/**
 * Messages between the extension host and the detail panel.
 *
 * The webview sends intents and indexes only. It never sends a path, a URL for
 * a header button, or a CLI argument: the host resolves those from its own
 * state, so a compromised transcript cannot steer the host.
 */
import type { Outcome } from '../core/trails';

export const PROTOCOL_VERSION = 1;

/** What a panel is open on. Plain data, so the webview can hand it back after a window reload. */
export interface DetailTarget {
  repoRoot: string;
  mode: 'checkpoint' | 'session';
  checkpointId?: string;
  commitSha?: string;
  /** In session mode, the session to show. In checkpoint mode, the slot to preselect. */
  sessionId?: string;
}

export type WireBlock =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      /** Position of the block in its turn, used to request the body. */
      block: number;
      name: string;
      /** One line describing the call, taken from its input. */
      summary: string;
      status?: 'success' | 'error';
      /** False when the source had no input or result to show. */
      hasBody: boolean;
    }
  | { kind: 'image'; block: number; mediaType?: string }
  | { kind: 'note'; text: string };

export interface WireTurn {
  index: number;
  role: 'user' | 'assistant';
  /** ISO timestamp, when the agent recorded one. */
  ts?: string;
  blocks: WireBlock[];
}

export interface HeaderCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  /** ISO timestamp. */
  date: string;
}

export interface HeaderSession {
  /** Session slot inside the checkpoint. */
  index: number;
  sessionId?: string;
  agent?: string;
  model?: string;
  /** Tokens used since the previous checkpoint of this session. */
  tokens?: number;
  createdAt?: string;
  intent?: string;
  outcome?: string;
}

export interface HeaderFile {
  path: string;
  /** Git status letter, when the file is part of the commit. */
  status?: string;
}

/** Where the shown checkpoint sits among the checkpoints of the selected session. */
export interface HeaderPosition {
  ordinal: number;
  total: number;
  /** The session may have earlier checkpoints than the ones counted. */
  mayHaveEarlier: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
}

/** Facts about a local session, shown when the panel opens on a session. */
export interface HeaderLocalSession {
  sessionId: string;
  status?: string;
  agent?: string;
  model?: string;
  turns?: number;
  pendingTurns?: number;
  tokens?: number;
  startedAt?: string;
  lastActive?: string;
}

export interface PanelHeader {
  mode: 'checkpoint' | 'session';
  title: string;
  checkpointId?: string;
  commit?: HeaderCommit;
  /** How many other scanned commits carry the same checkpoint. */
  otherCommits: number;
  branch?: string;
  sessions: HeaderSession[];
  /** Position in `sessions` of the one whose transcript is shown. */
  selected: number;
  files: HeaderFile[];
  /** Present when the panel shows one checkpoint and its session's other checkpoints are known. */
  position?: HeaderPosition;
  localSession?: HeaderLocalSession;
  /**
   * Who sent the prompts of the transcript: the author of the commit that
   * carries the checkpoint, or else the author the CLI names for it. The
   * transcript itself does not record a name. Absent while it is not known.
   */
  promptAuthor?: string;
  canOpenOnWeb: boolean;
  canShowCommitDiff: boolean;
  canOpenRaw: boolean;
  /** A caveat about the data, for example that the CLI read only part of it. */
  notice?: string;
}

export type TranscriptSource = 'compact' | 'cliText' | 'none';

export interface TranscriptInfo {
  source: TranscriptSource;
  /** Number of turns that will arrive in `turns` messages. */
  total: number;
  /** First turn of this checkpoint's own portion. Earlier turns are prior context. */
  start: number;
  /** Why there is no transcript, or what kind of view this is. */
  notice?: string;
}

export type HostMessage =
  | { type: 'loading'; title: string }
  | { type: 'init'; protocol: number; header: PanelHeader; transcript: TranscriptInfo; restore: DetailTarget }
  | { type: 'turns'; turns: WireTurn[]; done: boolean }
  /** Who sent the prompts, found after `init` was sent without a name. */
  | { type: 'promptAuthor'; name: string }
  | { type: 'toolBody'; requestId: number; input: string; output: string; truncated: boolean }
  | { type: 'image'; requestId: number; mediaType: string; base64: string }
  | { type: 'imageUnavailable'; requestId: number }
  | { type: 'error'; message: string; canRetry: boolean };

export type CopyTarget = 'checkpointId' | 'commitSha' | 'sessionId';

export type WebviewMessage =
  | { type: 'ready'; protocol: number }
  | { type: 'selectSession'; position: number }
  | { type: 'stepSession'; direction: 'previous' | 'next' }
  | { type: 'requestToolBody'; requestId: number; turn: number; block: number }
  | { type: 'requestImage'; requestId: number; turn: number; block: number }
  | { type: 'openToolBody'; turn: number; block: number }
  | { type: 'openOnWeb' }
  | { type: 'showCommitDiff' }
  | { type: 'openFile'; index: number }
  | { type: 'openRawTranscript' }
  | { type: 'openLink'; href: string }
  | { type: 'copy'; target: CopyTarget }
  | { type: 'retry' };

/** Narrowing guard for messages that arrive from the webview. */
export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  const int = (key: string): boolean => Number.isInteger(message[key]) && (message[key] as number) >= 0;
  switch (message.type) {
    case 'ready':
      return int('protocol');
    case 'selectSession':
      return int('position');
    case 'stepSession':
      return message.direction === 'previous' || message.direction === 'next';
    case 'requestToolBody':
    case 'requestImage':
      return int('requestId') && int('turn') && int('block');
    case 'openToolBody':
      return int('turn') && int('block');
    case 'openFile':
      return int('index');
    case 'openLink':
      return typeof message.href === 'string';
    case 'copy':
      return message.target === 'checkpointId' || message.target === 'commitSha' || message.target === 'sessionId';
    case 'openOnWeb':
    case 'showCommitDiff':
    case 'openRawTranscript':
    case 'retry':
      return true;
    default:
      return false;
  }
}

/** What a trail panel is open on. Plain data, so the webview can hand it back after a window reload. */
export interface TrailTarget {
  repoRoot: string;
  mode: 'trail';
  /** The trail's number in its project. */
  trail: number;
  /** The trail's ID on Entire, when known. The CLI finds a trail by its ID sooner than by its number. */
  id?: string;
}

/** One condition a change has to meet before it can merge. */
export interface TrailGateView {
  label: string;
  outcome: Outcome;
  /** A gate that does not block is reported and does not stop a merge. */
  blocking: boolean;
  /** The reason entire.io gives for the outcome. */
  rationale?: string;
  findings?: number;
}

/** One CI run on the head commit of a change. */
export interface TrailCheckView {
  name: string;
  outcome: Outcome;
  /** What the run is doing or how it ended, in words. */
  detail: string;
  app?: string;
  /** The run has a page of its own, which the host can open. */
  hasLink: boolean;
}

export interface TrailMergeView {
  mergeable: boolean;
  /** Set when the branch does not merge cleanly: the CLI's word for why. */
  conflict?: string;
  gates: TrailGateView[];
  checks: TrailCheckView[];
  /** "1 failed, 20 passed". Empty when there are no runs. */
  checkSummary: string;
  /** Why no CI runs are listed, when the CLI could not read them. */
  checksNote?: string;
}

/** One branch of the trail, in one repository. */
export interface TrailChangeView {
  repository: string;
  /** The change's number in its repository. Not the trail's number. */
  number: number;
  title?: string;
  status?: string;
  branch?: string;
  base?: string;
  /** The branch is the one checked out in the repository this panel belongs to. */
  checkedOut: boolean;
  hasCodeChanges: boolean;
  merge?: TrailMergeView;
  canOpenOnWeb: boolean;
}

export interface TrailCommitView {
  shortSha: string;
  additions?: number;
  deletions?: number;
  files?: number;
  /** The commit is in this clone, so its diff can be shown. */
  local: boolean;
  /** Checkpoints the commit carries, as read from this clone. Each one can be opened. */
  checkpoints: number;
  /** Checkpoints entire.io has for the commit. Shown when the commit is not in this clone. */
  remoteCheckpoints: number;
  agents: string[];
}

/** One entry of a change's timeline. */
export interface TrailEventView {
  kind: string;
  /** One line that says what happened. For a commit, its subject. */
  text: string;
  actor?: string;
  /** ISO timestamp. */
  at?: string;
  commit?: TrailCommitView;
}

export interface TrailTimelineView {
  /** Newest first. */
  events: TrailEventView[];
  hasMore: boolean;
  /** A caveat, for example that the timeline could not be read. */
  notice?: string;
}

export interface TrailView {
  number: number;
  title: string;
  status?: string;
  phase?: string;
  type?: string;
  priority?: string;
  project?: string;
  assignees: string[];
  createdAt?: string;
  lastActivityAt?: string;
  closedAt?: string;
  /** The trail's description, as Markdown. */
  body: string;
  canOpenOnWeb: boolean;
  changes: TrailChangeView[];
  /** Position in `changes` of the one whose merge state and timeline are shown. */
  selected: number;
  /** Activity on the selected change. Absent when the trail has no changes, and while it is being read. */
  timeline?: TrailTimelineView;
  /**
   * The view holds only what the Trails view listed about the trail: its
   * title and the facts under it. The changes are still being read.
   */
  partial?: boolean;
  /** The timeline of the selected change is still being read. */
  timelinePending?: boolean;
  /** The view is the trail as this window read it earlier, and a fresh read is under way. */
  refreshing?: boolean;
  /** A caveat about the whole view, for example that the fresh read failed. */
  notice?: string;
}

/**
 * What the host sends the trail panel's page. A trail arrives in stages,
 * because each read from Entire takes seconds: `trail` once with what is
 * known at once, `trail` again when the trail has been read, and `timeline`
 * when its timeline has.
 */
export type TrailHostMessage =
  | { type: 'loading'; title: string }
  | { type: 'trail'; protocol: number; view: TrailView; restore: TrailTarget }
  /** The first page of the selected change's timeline. It replaces the one on the page. */
  | { type: 'timeline'; timeline: TrailTimelineView }
  | { type: 'timelinePage'; events: TrailEventView[]; hasMore: boolean; notice?: string }
  /** The fresh read of a view sent with `refreshing` has ended. `notice` says so when it failed. */
  | { type: 'refreshed'; notice?: string }
  | { type: 'error'; message: string; canRetry: boolean };

/**
 * What the trail panel's page can ask for. As with the detail panel, it
 * names things by position: the host looks up the commit, the checkpoint, or
 * the address in its own state.
 */
export type TrailWebviewMessage =
  | { type: 'ready'; protocol: number }
  | { type: 'retry' }
  | { type: 'openLink'; href: string }
  | { type: 'selectChange'; position: number }
  | { type: 'openOnWeb' }
  | { type: 'openChangeOnWeb' }
  | { type: 'openCheck'; run: number }
  | { type: 'openCheckpoint'; event: number; checkpoint: number }
  | { type: 'showCommitDiff'; event: number }
  | { type: 'copyCommitSha'; event: number }
  | { type: 'copyBranch' }
  | { type: 'copyLink' }
  | { type: 'loadMoreTimeline' };

/** Narrowing guard for messages that arrive from the trail panel's page. */
export function isTrailWebviewMessage(value: unknown): value is TrailWebviewMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  const int = (key: string): boolean => Number.isInteger(message[key]) && (message[key] as number) >= 0;
  switch (message.type) {
    case 'ready':
      return int('protocol');
    case 'selectChange':
      return int('position');
    case 'openCheck':
      return int('run');
    case 'openCheckpoint':
      return int('event') && int('checkpoint');
    case 'showCommitDiff':
    case 'copyCommitSha':
      return int('event');
    case 'openLink':
      return typeof message.href === 'string';
    case 'retry':
    case 'openOnWeb':
    case 'openChangeOnWeb':
    case 'copyBranch':
    case 'copyLink':
    case 'loadMoreTimeline':
      return true;
    default:
      return false;
  }
}
