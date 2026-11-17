import path from 'node:path';
import * as vscode from 'vscode';
import type { CheckpointTree, StoredSession } from '../../core/checkpointStore';
import { headline } from '../../core/format';
import { totalTokens, type CheckpointDetail } from '../../core/schemas';
import { parseCliText } from '../../core/transcript/cliText';
import { toolInputText, toWireTurn, type FullTurn, type ParsedTranscript } from '../../core/transcript/model';
import { parseCompactTranscript } from '../../core/transcript/normalize';
import { openingPrompt } from '../../core/transcript/prompts';
import { isCheckpointId, isCommitSha, type CommitRecord } from '../../core/trailers';
import {
  PROTOCOL_VERSION,
  isWebviewMessage,
  type DetailTarget,
  type HeaderFile,
  type HeaderLocalSession,
  type HeaderSession,
  type HostMessage,
  type PanelHeader,
  type TranscriptInfo,
  type WebviewMessage,
  type WireTurn,
} from '../../shared/protocol';
import type { Actions } from '../actions';
import type { RepoContext, RepoManager, SessionEntry } from '../repoManager';
import type { DetailView } from '../views/nodes';
import { panelHtml } from './html';

const TURNS_PER_MESSAGE = 100;
/** Tool inputs and results beyond this size open in an editor instead. */
const BODY_LIMIT = 256 * 1024;
const IMAGE_LIMIT = 8 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** Everything the host keeps for the panel's current target. */
interface Loaded {
  repo: RepoContext;
  header: PanelHeader;
  info: TranscriptInfo;
  turns: FullTurn[];
  wire: WireTurn[];
  detail?: CheckpointDetail;
  checkpointId?: string;
  commit?: CommitRecord;
  /** Slot of the selected session inside the checkpoint. */
  sessionIndex?: number;
  sessionId?: string;
  /** The checkpoints just before and after this one in the selected session. */
  neighbors?: { previous?: string; next?: string };
  tree?: CheckpointTree;
  stored?: StoredSession;
}

/** Validates a target that came back from a restored webview. */
export function readDetailTarget(value: unknown): DetailTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.repoRoot !== 'string' || (raw.mode !== 'checkpoint' && raw.mode !== 'session')) return undefined;
  const target: DetailTarget = { repoRoot: raw.repoRoot, mode: raw.mode };
  if (typeof raw.checkpointId === 'string' && isCheckpointId(raw.checkpointId)) target.checkpointId = raw.checkpointId;
  if (typeof raw.commitSha === 'string' && isCommitSha(raw.commitSha)) target.commitSha = raw.commitSha;
  if (typeof raw.sessionId === 'string' && raw.sessionId.length <= 128) target.sessionId = raw.sessionId;
  if (target.mode === 'checkpoint' && !target.checkpointId) return undefined;
  if (target.mode === 'session' && !target.sessionId) return undefined;
  return target;
}

/** Drives one detail panel: loads its data and answers the webview's requests. */
export class PanelController implements vscode.Disposable {
  private loaded?: Loaded;
  private abort = new AbortController();
  private loadSequence = 0;
  private ready = false;
  private error?: { message: string; canRetry: boolean };
  /** A session the user picked in the panel, which overrides the target's preselection. */
  private pickedPosition?: number;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;
  private readonly shownEmitter = new vscode.EventEmitter<DetailTarget>();
  /**
   * Fires when the tab moves on by itself, with what it now shows: another
   * checkpoint of the session, or another session of the checkpoint. The
   * view the tab was opened from moves its selection to match.
   */
  readonly onDidChangeShown = this.shownEmitter.event;
  /** The view whose row the tab was opened from. Unset for a tab opened from elsewhere, such as a trail. */
  origin?: DetailView;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly manager: RepoManager,
    private readonly actions: Actions,
    extensionUri: vscode.Uri,
    private target: DetailTarget,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = panelHtml(panel.webview, extensionUri);
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
    void this.load();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
    this.shownEmitter.dispose();
  }

  /** True once the page's script has run and asked for data. */
  get webviewReady(): boolean {
    return this.ready;
  }

  /** What the panel currently shows, for the extension-host tests. */
  snapshot(): { header: PanelHeader; transcript: TranscriptInfo; turns: number } | { error: string } | undefined {
    if (this.error) return { error: this.error.message };
    if (!this.loaded) return undefined;
    return { header: this.loaded.header, transcript: this.loaded.info, turns: this.loaded.wire.length };
  }

  /** Moves to the checkpoint before or after this one in the selected session, when there is one. */
  step(direction: 'previous' | 'next'): void {
    const loaded = this.loaded;
    // The checkpoint comes from the host's own index, never from the page.
    const checkpointId = loaded?.neighbors?.[direction];
    if (!loaded || !checkpointId) return;
    this.show({
      repoRoot: loaded.repo.root,
      mode: 'checkpoint',
      checkpointId,
      ...(loaded.sessionId ? { sessionId: loaded.sessionId } : {}),
    });
    this.shownEmitter.fire(this.target);
  }

  /** Shows another session of the checkpoint: the one at `position` among its sessions. */
  selectSession(position: number): void {
    const loaded = this.loaded;
    const session = loaded?.detail?.sessions[position];
    if (!loaded?.checkpointId || !session) return;
    this.pickedPosition = position;
    void this.load();
    this.shownEmitter.fire({
      repoRoot: loaded.repo.root,
      mode: 'checkpoint',
      checkpointId: loaded.checkpointId,
      ...(loaded.commit ? { commitSha: loaded.commit.sha } : {}),
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
    });
  }

  /** Points the panel at something else, reusing the tab. */
  show(target: DetailTarget): void {
    this.target = target;
    this.pickedPosition = undefined;
    void this.load();
  }

  private post(message: HostMessage): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(message);
  }

  private sendLoaded(): void {
    const loaded = this.loaded;
    if (!loaded) return;
    this.post({
      type: 'init',
      protocol: PROTOCOL_VERSION,
      header: loaded.header,
      transcript: loaded.info,
      restore: this.target,
    });
    if (loaded.wire.length === 0) {
      this.post({ type: 'turns', turns: [], done: true });
      return;
    }
    for (let from = 0; from < loaded.wire.length; from += TURNS_PER_MESSAGE) {
      const turns = loaded.wire.slice(from, from + TURNS_PER_MESSAGE);
      this.post({ type: 'turns', turns, done: from + TURNS_PER_MESSAGE >= loaded.wire.length });
    }
  }

  private showError(message: string, canRetry: boolean): void {
    this.loaded = undefined;
    this.error = { message, canRetry };
    this.post({ type: 'error', message, canRetry });
  }

  private async load(): Promise<void> {
    const sequence = ++this.loadSequence;
    const stale = (): boolean => sequence !== this.loadSequence || this.disposed;
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.loaded = undefined;
    this.error = undefined;
    this.post({ type: 'loading', title: 'Loading' });

    await this.manager.whenLoaded();
    if (stale()) return;
    const repo = this.manager.repoFor(this.target.repoRoot);
    if (!repo) {
      this.showError('The repository for this tab is not open in this window.', false);
      return;
    }

    const entry =
      this.target.mode === 'session' && this.target.sessionId
        ? this.manager.sessionEntry(repo, this.target.sessionId)
        : undefined;
    let checkpointId =
      this.target.mode === 'checkpoint'
        ? this.target.checkpointId
        : (entry?.checkpoints[0]?.checkpointId ?? entry?.local?.lastCheckpointId);
    if (!checkpointId && entry?.listedCheckpoints) {
      // A session of another branch: the clone has none of its checkpoints, and Entire lists them.
      const listed = await this.manager.sessionCheckpoints(repo, entry.sessionId, { wait: true, signal });
      checkpointId = listed[0]?.checkpointId;
      if (stale()) return;
    }

    if (!checkpointId) {
      this.loaded = this.sessionOnly(repo, entry);
      this.panel.title = shortTitle(this.loaded.header.title);
      this.sendLoaded();
      return;
    }

    const detail = await this.manager.detail(repo, checkpointId, signal);
    if (stale()) return;
    if (!detail.ok) {
      if (detail.failure.kind === 'notFound') {
        // The checkpoint's data was never uploaded. The commit is still here, so show that.
        const commit = await this.findCommit(repo, checkpointId);
        const files = await this.files(repo, [], commit);
        if (stale()) return;
        this.loaded = this.withoutData(repo, checkpointId, commit, files, entry);
        this.panel.title = shortTitle(this.loaded.header.title);
        this.sendLoaded();
      } else if (detail.failure.kind !== 'aborted') {
        this.showError(detail.failure.message, true);
      }
      return;
    }

    const sessions = detail.value.sessions;
    const position = this.selectPosition(detail.value);
    const slot = sessions[position];

    const commit = await this.findCommit(repo, checkpointId);
    if (stale()) return;
    const touched = slot && slot.filesTouched.length > 0 ? slot.filesTouched : detail.value.filesTouched;
    const files = await this.files(repo, touched, commit);
    if (stale()) return;

    const tree = await this.manager.store.locate(repo.root, checkpointId);
    const stored = tree && slot ? (await this.manager.store.sessions(repo.root, tree))[slot.index] : undefined;
    if (stale()) return;
    const transcript = await this.transcript(repo, checkpointId, tree, stored, position === sessions.length - 1, signal);
    if (stale()) return;

    const headerSessions = sessions.map((session): HeaderSession => {
      const header: HeaderSession = { index: session.index };
      if (session.sessionId) header.sessionId = session.sessionId;
      if (session.agent) header.agent = session.agent;
      if (session.model) header.model = session.model;
      if (session.tokenUsage) header.tokens = totalTokens(session.tokenUsage);
      if (session.createdAt) header.createdAt = session.createdAt;
      if (session.summary?.intent) header.intent = session.summary.intent;
      if (session.summary?.outcome) header.outcome = session.summary.outcome;
      return header;
    });

    const row = repo.index?.row(checkpointId);
    const sessionId = slot?.sessionId ?? (this.target.mode === 'session' ? this.target.sessionId : undefined);
    // The transcript opens with the prompt that names a session Entire has
    // not named. The Sessions view is told, so that its row has the name too.
    const opening = transcript.fromSessionStart ? openingPrompt(transcript.parsed.turns) : undefined;
    if (opening && slot?.sessionId) this.manager.noteSessionName(repo, slot.sessionId, opening);
    const title =
      (this.target.mode === 'session' ? headline(entry?.name ?? opening ?? entry?.lastPrompt, 120) : '') ||
      commit?.subject ||
      headline(row?.message, 120) ||
      checkpointId;

    const header: PanelHeader = {
      mode: this.target.mode,
      title,
      checkpointId,
      otherCommits: Math.max(0, (repo.index?.commitsFor(checkpointId).length ?? 0) - 1),
      sessions: headerSessions,
      selected: position,
      files,
      canOpenOnWeb: repo.entireRepo !== undefined && (commit !== undefined || sessionId !== undefined),
      canShowCommitDiff: commit !== undefined,
      canOpenRaw: slot !== undefined,
    };
    if (commit) {
      header.commit = {
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.author,
        date: new Date(commit.authorTime * 1000).toISOString(),
      };
    }
    if (detail.value.branch) header.branch = detail.value.branch;
    if (entry) header.localSession = localSession(entry);
    if (detail.value.partial) header.notice = 'The Entire CLI could read only part of this checkpoint.';
    // The transcript does not say who sent its prompts. The CLI takes that
    // to be the author of the commit that carries the checkpoint.
    const promptAuthor = commit?.author || repo.checkpointAuthors.get(checkpointId);
    if (promptAuthor) header.promptAuthor = promptAuthor;

    // A panel on one checkpoint says where that checkpoint sits in its
    // session and can step to the ones around it. A panel on a session shows
    // the whole conversation, so it has no place to report.
    const place =
      this.target.mode === 'checkpoint' && slot?.sessionId
        ? repo.index?.position(slot.sessionId, checkpointId)
        : undefined;
    if (place) {
      header.position = {
        ordinal: place.ordinal,
        total: place.total,
        mayHaveEarlier: place.mayHaveEarlier,
        hasPrevious: place.previous !== undefined,
        hasNext: place.next !== undefined,
      };
    }

    const wire = transcript.parsed.turns.map(toWireTurn);
    const info: TranscriptInfo = {
      source: transcript.source,
      total: wire.length,
      // A session view shows the whole conversation, not one checkpoint's part of it.
      start: this.target.mode === 'session' ? 0 : transcript.parsed.startTurn,
    };
    if (transcript.notice) info.notice = transcript.notice;

    this.loaded = {
      repo,
      header,
      info,
      turns: transcript.parsed.turns,
      wire,
      detail: detail.value,
      checkpointId,
      ...(commit ? { commit } : {}),
      ...(slot ? { sessionIndex: slot.index } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(place ? { neighbors: { ...(place.previous ? { previous: place.previous } : {}), ...(place.next ? { next: place.next } : {}) } } : {}),
      ...(tree ? { tree } : {}),
      ...(stored ? { stored } : {}),
    };
    this.panel.title = shortTitle(title);
    this.sendLoaded();
    if (!promptAuthor && wire.length > 0) void this.findPromptAuthor(repo, checkpointId, this.loaded, signal);
  }

  /**
   * Asks the CLI who the author of a checkpoint is, and puts the name on the
   * prompts already drawn. This is for a checkpoint that no commit in the
   * history read so far carries, such as one made on another branch. The
   * call takes a second or two, so the transcript does not wait for it.
   */
  private async findPromptAuthor(
    repo: RepoContext,
    checkpointId: string,
    loaded: Loaded,
    signal: AbortSignal,
  ): Promise<void> {
    const author = await this.manager.cli?.checkpointAuthor(repo.root, checkpointId, signal);
    if (!author?.ok || !author.value) return;
    repo.checkpointAuthors.set(checkpointId, author.value);
    if (this.loaded !== loaded || this.disposed) return;
    loaded.header.promptAuthor = author.value;
    this.post({ type: 'promptAuthor', name: author.value });
  }

  /** A local session that no checkpoint references yet: facts only, no transcript view. */
  private sessionOnly(repo: RepoContext, entry: SessionEntry | undefined): Loaded {
    const sessionId = this.target.sessionId ?? '';
    const header: PanelHeader = {
      mode: 'session',
      title: headline(entry?.name ?? entry?.lastPrompt, 120) || `${entry?.agent ?? 'Agent'} session`,
      otherCommits: 0,
      sessions: [],
      selected: 0,
      files: [],
      canOpenOnWeb: repo.entireRepo !== undefined && sessionId !== '',
      canShowCommitDiff: false,
      canOpenRaw: entry?.local !== undefined,
    };
    if (entry) header.localSession = localSession(entry);
    return {
      repo,
      header,
      info: {
        source: 'none',
        total: 0,
        start: 0,
        notice: entry
          ? 'This session has no checkpoint yet. Its transcript appears here after a commit that includes its work.'
          : 'Entire has no record of this session in this repository.',
      },
      turns: [],
      wire: [],
      ...(sessionId ? { sessionId } : {}),
    };
  }

  private selectPosition(detail: CheckpointDetail): number {
    const count = detail.sessions.length;
    if (count === 0) return 0;
    if (this.pickedPosition !== undefined && this.pickedPosition < count) return this.pickedPosition;
    if (this.target.sessionId) {
      const found = detail.sessions.findIndex((session) => session.sessionId === this.target.sessionId);
      if (found >= 0) return found;
    }
    // The latest session is the one the CLI itself shows by default.
    return count - 1;
  }

  private async findCommit(repo: RepoContext, checkpointId: string): Promise<CommitRecord | undefined> {
    const carriers = repo.index?.commitsFor(checkpointId) ?? [];
    const wanted = this.target.commitSha;
    if (wanted) {
      return carriers.find((commit) => commit.sha === wanted) ?? (await this.manager.git.commit(repo.root, wanted));
    }
    return carriers[0];
  }

  /**
   * A checkpoint that a commit names but whose session data the CLI cannot
   * find. The panel shows what git knows about the commit and says why there
   * is no transcript.
   */
  private withoutData(
    repo: RepoContext,
    checkpointId: string,
    commit: CommitRecord | undefined,
    files: HeaderFile[],
    /** The session the tab was opened for, when it was opened for a session and not for the checkpoint. */
    session?: SessionEntry,
  ): Loaded {
    const hosted = repo.entireRepo !== undefined;
    const header: PanelHeader = {
      mode: session ? 'session' : 'checkpoint',
      title: (session ? headline(session.name ?? session.lastPrompt, 120) : '') || commit?.subject || checkpointId,
      checkpointId,
      otherCommits: Math.max(0, (repo.index?.commitsFor(checkpointId).length ?? 0) - 1),
      sessions: [],
      selected: 0,
      files,
      // A session has a page on entire.com whether or not a commit here carries its checkpoint.
      canOpenOnWeb: hosted && (commit !== undefined || session !== undefined),
      canShowCommitDiff: commit !== undefined,
      canOpenRaw: false,
    };
    if (commit) {
      header.commit = {
        sha: commit.sha,
        shortSha: commit.shortSha,
        subject: commit.subject,
        author: commit.author,
        date: new Date(commit.authorTime * 1000).toISOString(),
      };
    }
    return {
      repo,
      header,
      info: {
        source: 'none',
        total: 0,
        start: 0,
        notice:
          session && hosted && session.listedCheckpoints !== undefined
            ? // Entire lists the session, so its data is there, even though the CLI did not find it.
              "The Entire CLI could not find the session data of this session's latest checkpoint, on this machine or on the remote. Entire lists the session, so its page on entire.com may have the transcript."
            : "Entire has no session data for this checkpoint. The commit records the checkpoint's ID, but the session data is uploaded separately, and this checkpoint's is not on this machine or on the remote. If its author still has it, running \"entire checkpoint push\" on their machine uploads it.",
      },
      turns: [],
      wire: [],
      checkpointId,
      ...(commit ? { commit } : {}),
      ...(session ? { sessionId: session.sessionId } : {}),
    };
  }

  /** Files the session touched, marked with a status when the commit changed them. */
  private async files(repo: RepoContext, touched: string[], commit: CommitRecord | undefined): Promise<HeaderFile[]> {
    const changes = commit ? await this.manager.git.commitFiles(repo.root, commit.sha) : [];
    const status = new Map(changes.map((change) => [change.path, change.status]));
    const paths = touched.length > 0 ? touched : changes.map((change) => change.path);
    return paths.map((filePath): HeaderFile => {
      // Agents record absolute paths at times. Show them relative to the repository.
      const relative = path.isAbsolute(filePath) ? path.relative(repo.root, filePath) : filePath;
      const letter = status.get(relative);
      return letter ? { path: relative, status: letter } : { path: relative };
    });
  }

  private async transcript(
    repo: RepoContext,
    checkpointId: string,
    tree: CheckpointTree | undefined,
    stored: StoredSession | undefined,
    isLatestSession: boolean,
    signal: AbortSignal,
  ): Promise<{
    parsed: ParsedTranscript;
    source: TranscriptInfo['source'];
    /** The transcript holds the session from its start, so its first prompt is the one that opened the session. */
    fromSessionStart: boolean;
    notice?: string;
  }> {
    if (tree && stored) {
      const text = await this.manager.store.compactTranscript(repo.root, tree, stored, signal);
      if (text !== undefined) {
        const meta = await this.manager.store.sessionMeta(repo.root, tree, stored);
        return {
          parsed: parseCompactTranscript(text, meta?.compactTranscriptStart),
          source: 'compact',
          // Without a start line, the file holds only this checkpoint's part of the session.
          fromSessionStart: typeof meta?.compactTranscriptStart === 'number',
        };
      }
    }
    // The CLI's text view covers only the latest session of a checkpoint.
    if (isLatestSession && this.manager.cli) {
      const text = await this.manager.cli.fullText(repo.root, checkpointId, signal);
      if (text.ok) {
        return {
          parsed: parseCliText(text.value),
          source: 'cliText',
          // The CLI's text view is of the whole session.
          fromSessionStart: true,
          notice:
            'Text view from the Entire CLI. This session has no normalized transcript, so tool inputs and results are not shown.',
        };
      }
    }
    return {
      parsed: { turns: [], startTurn: 0 },
      source: 'none',
      fromSessionStart: false,
      notice: 'No transcript preview is available for this session. Open the raw transcript to read it.',
    };
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isWebviewMessage(raw)) return;
    const message: WebviewMessage = raw;
    if (message.type === 'ready') {
      this.ready = true;
      if (this.loaded) this.sendLoaded();
      else if (this.error) this.post({ type: 'error', ...this.error });
      else this.post({ type: 'loading', title: 'Loading' });
      return;
    }
    if (message.type === 'retry') {
      void this.load();
      return;
    }
    if (message.type === 'openLink') {
      await this.actions.openExternal(message.href);
      return;
    }

    const loaded = this.loaded;
    if (!loaded) return;
    const { repo } = loaded;

    switch (message.type) {
      case 'selectSession':
        this.selectSession(message.position);
        return;
      case 'stepSession':
        this.step(message.direction);
        return;
      case 'requestToolBody': {
        const block = loaded.turns[message.turn]?.blocks[message.block];
        if (block?.kind !== 'tool') return;
        const input = toolInputText(block.input);
        const output = block.output ?? '';
        this.post({
          type: 'toolBody',
          requestId: message.requestId,
          input: input.slice(0, BODY_LIMIT),
          output: output.slice(0, BODY_LIMIT),
          truncated: input.length > BODY_LIMIT || output.length > BODY_LIMIT,
        });
        return;
      }
      case 'openToolBody': {
        const block = loaded.turns[message.turn]?.blocks[message.block];
        if (block?.kind !== 'tool') return;
        const parts = [`# ${block.name}`, '', '## Input', '', toolInputText(block.input), '', '## Result', '', block.output ?? ''];
        await this.actions.openText(block.name, parts.join('\n'));
        return;
      }
      case 'requestImage':
        this.post(await this.image(loaded, message.requestId, message.turn, message.block));
        return;
      case 'openOnWeb':
        if (loaded.commit && loaded.header.mode === 'checkpoint') {
          await this.actions.openCommitOnWeb(repo, loaded.commit.sha);
        } else if (loaded.sessionId) {
          await this.actions.openSessionOnWeb(repo, loaded.sessionId);
        } else if (loaded.commit) {
          await this.actions.openCommitOnWeb(repo, loaded.commit.sha);
        }
        return;
      case 'showCommitDiff':
        if (loaded.commit) await this.actions.showCommitDiff(repo, loaded.commit.sha);
        return;
      case 'openFile': {
        const file = loaded.header.files[message.index];
        if (file) await this.actions.openFile(repo, loaded.commit?.sha, file.path);
        return;
      }
      case 'openRawTranscript':
        if (loaded.checkpointId && loaded.sessionIndex !== undefined) {
          await this.actions.openRawCheckpointTranscript(repo, loaded.checkpointId, loaded.sessionIndex);
        } else if (loaded.sessionId) {
          await this.actions.openRawSessionTranscript(repo, loaded.sessionId);
        }
        return;
      case 'copy': {
        const value =
          message.target === 'checkpointId'
            ? loaded.checkpointId
            : message.target === 'commitSha'
              ? loaded.commit?.sha
              : loaded.sessionId;
        const label =
          message.target === 'checkpointId' ? 'checkpoint ID' : message.target === 'commitSha' ? 'commit SHA' : 'session ID';
        if (value) await this.actions.copy(value, label);
        return;
      }
    }
  }

  private async image(loaded: Loaded, requestId: number, turn: number, blockIndex: number): Promise<HostMessage> {
    const unavailable: HostMessage = { type: 'imageUnavailable', requestId };
    const block = loaded.turns[turn]?.blocks[blockIndex];
    if (block?.kind !== 'image') return unavailable;

    let base64 = block.base64;
    let mediaType = block.mediaType;
    if (!base64 && block.assetPath && loaded.tree && loaded.stored) {
      const data = await this.manager.store.asset(loaded.repo.root, loaded.tree, loaded.stored, block.assetPath);
      base64 = data?.toString('base64');
      mediaType ??= IMAGE_TYPES[path.extname(block.assetPath).slice(1).toLowerCase()];
    }
    // SVG is left out on purpose: it is the one image type that can carry script.
    if (!base64 || base64.length > IMAGE_LIMIT || !mediaType || !Object.values(IMAGE_TYPES).includes(mediaType)) {
      return unavailable;
    }
    return { type: 'image', requestId, mediaType, base64 };
  }
}

function localSession(entry: SessionEntry): HeaderLocalSession {
  const local: HeaderLocalSession = { sessionId: entry.sessionId };
  if (entry.status) local.status = entry.status;
  if (entry.agent) local.agent = entry.agent;
  if (entry.model) local.model = entry.model;
  if (entry.local?.turns !== undefined) local.turns = entry.local.turns;
  if (entry.local?.pendingTurns !== undefined) local.pendingTurns = entry.local.pendingTurns;
  if (entry.local?.tokens) local.tokens = entry.local.tokens.total;
  if (entry.local?.startedAt) local.startedAt = entry.local.startedAt;
  if (entry.lastActive) local.lastActive = entry.lastActive;
  return local;
}

function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}
