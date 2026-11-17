import * as vscode from 'vscode';
import type { Result } from '../../core/errors';
import type {
  TrailChange,
  TrailDetail,
  TrailEvent,
  TrailMergeability,
  TrailSummary,
  TrailTimeline,
} from '../../core/schemas';
import type { RememberedTimeline } from '../../core/trailMemory';
import { isCommitSha, type CommitRecord } from '../../core/trailers';
import {
  changeRef,
  checkDetail,
  checkOutcome,
  eventText,
  gateLabel,
  gateOutcome,
  isCheckedOut,
  isInRepo,
  isTrailId,
  outcomeSummary,
  primaryChange,
  sameChange,
  trailProject,
  words,
  type HostedRepo,
  type TimelineOf,
} from '../../core/trails';
import {
  PROTOCOL_VERSION,
  isTrailWebviewMessage,
  type DetailTarget,
  type TrailChangeView,
  type TrailEventView,
  type TrailHostMessage,
  type TrailMergeView,
  type TrailTarget,
  type TrailView,
  type TrailWebviewMessage,
} from '../../shared/protocol';
import type { Actions } from '../actions';
import { TRAILS_OFF, type RepoContext, type RepoManager } from '../repoManager';
import { panelHtml } from './html';

/** Timeline entries per read. The CLI accepts 1 to 100. */
const TIMELINE_PAGE = 50;

/** A timeline entry with what this clone knows about its commit. */
interface LoadedEvent {
  event: TrailEvent;
  /** The commit, when the entry is one and this clone has it. */
  commit?: CommitRecord;
}

/** Everything the host keeps for the panel's current trail, once the trail has been read. */
interface Loaded {
  repo: RepoContext;
  detail: TrailDetail;
  view: TrailView;
  /** The change whose merge state and timeline are shown. */
  change?: TrailChange;
  events: LoadedEvent[];
  /** The first page of the timeline on screen, and how it was asked for. Its later pages are asked for the same way. */
  timeline?: RememberedTimeline;
  /** Where the next page of the timeline starts, while there is one. */
  nextPageToken?: string;
}

/** Validates a target that came back from a restored webview. */
export function readTrailTarget(value: unknown): TrailTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.repoRoot !== 'string' || raw.mode !== 'trail') return undefined;
  if (typeof raw.trail !== 'number' || !Number.isSafeInteger(raw.trail) || raw.trail < 1) return undefined;
  const target: TrailTarget = { repoRoot: raw.repoRoot, mode: 'trail', trail: raw.trail };
  // An ID that does not look like one is dropped, and the trail is then read by its number.
  if (isTrailId(raw.id)) target.id = raw.id;
  return target;
}

/** The top of the page: what a row of the Trails view and the trail itself both say. */
function headerView(trail: TrailSummary): TrailView {
  const view: TrailView = {
    number: trail.number,
    title: trail.title,
    assignees: trail.assignees,
    body: trail.body ?? '',
    canOpenOnWeb: false,
    changes: [],
    selected: 0,
  };
  if (trail.status) view.status = trail.status;
  if (trail.phase) view.phase = trail.phase;
  if (trail.type) view.type = trail.type;
  if (trail.priority && trail.priority !== 'none') view.priority = trail.priority;
  if (trail.createdAt) view.createdAt = trail.createdAt;
  if (trail.lastActivityAt) view.lastActivityAt = trail.lastActivityAt;
  if (trail.closedAt) view.closedAt = trail.closedAt;
  return view;
}

/** The whole trail except its timeline, with the change at `position` selected. */
function trailView(detail: TrailDetail, hosted: HostedRepo, branch: string | undefined, position: number): TrailView {
  const view = headerView(detail);
  view.canOpenOnWeb = detail.url !== undefined;
  view.changes = detail.changes.map((candidate): TrailChangeView => {
    const item: TrailChangeView = {
      repository: candidate.repository,
      number: candidate.number,
      checkedOut: isCheckedOut(candidate, hosted, branch),
      hasCodeChanges: candidate.hasCodeChanges,
      canOpenOnWeb: candidate.url !== undefined,
    };
    if (candidate.title) item.title = candidate.title;
    if (candidate.status) item.status = candidate.status;
    if (candidate.branch) item.branch = candidate.branch;
    if (candidate.base) item.base = candidate.base;
    if (candidate.mergeability) item.merge = mergeView(candidate.mergeability);
    return item;
  });
  view.selected = Math.max(0, position);
  if (detail.projectName) view.project = detail.projectName;
  return view;
}

/** Whether two values read from the CLI say the same thing. The readers build both, so key order agrees. */
function sameData(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether a fresh first page of a timeline shows what an earlier one did.
 * The page tokens are left out: they are opaque, and two reads of one
 * timeline may not return the same one.
 */
function samePage(a: TrailTimeline, b: TrailTimeline): boolean {
  return (
    sameData(a.events, b.events) &&
    a.commitCount === b.commitCount &&
    a.incomplete === b.incomplete &&
    (a.nextPageToken === undefined) === (b.nextPageToken === undefined)
  );
}

/** Hands the timeline one loaded trail shows to another, with every page of it read so far. */
function carryTimeline(from: Loaded, to: Loaded): void {
  if (!from.timeline || !from.view.timeline) return;
  to.timeline = from.timeline;
  to.events = from.events;
  if (from.nextPageToken) to.nextPageToken = from.nextPageToken;
  delete to.view.timelinePending;
  to.view.timeline = from.view.timeline;
}

/** Puts the first page of a timeline in place of whatever timeline a loaded trail showed. */
function setTimeline(loaded: Loaded, timeline: RememberedTimeline, events: LoadedEvent[]): void {
  loaded.timeline = timeline;
  loaded.events = events;
  if (timeline.page.nextPageToken) loaded.nextPageToken = timeline.page.nextPageToken;
  else delete loaded.nextPageToken;
  delete loaded.view.timelinePending;
  loaded.view.timeline = {
    events: events.map(eventView),
    hasMore: loaded.nextPageToken !== undefined,
    ...timelineNotice(timeline.page),
  };
}

function mergeView(merge: TrailMergeability): TrailMergeView {
  const outcomes = merge.checks.map(checkOutcome);
  const view: TrailMergeView = {
    mergeable: merge.mergeable,
    gates: merge.gates.map((gate) => ({
      label: gateLabel(gate.key),
      outcome: gateOutcome(gate),
      blocking: gate.blocking,
      ...(gate.rationale ? { rationale: gate.rationale } : {}),
      ...(gate.findingCount !== undefined ? { findings: gate.findingCount } : {}),
    })),
    checks: merge.checks.map((run, position) => ({
      name: run.name,
      outcome: outcomes[position] ?? 'pending',
      detail: checkDetail(run),
      ...(run.appName ? { app: run.appName } : {}),
      hasLink: run.detailsUrl !== undefined,
    })),
    checkSummary: outcomeSummary(outcomes),
  };
  if (merge.conflictStatus && merge.conflictStatus !== 'clean') view.conflict = words(merge.conflictStatus);
  if (merge.checksAvailability && merge.checksAvailability !== 'available') {
    view.checksNote = `Entire could not read the CI runs of this branch (${words(merge.checksAvailability)}).`;
  }
  return view;
}

/**
 * Drives one trail panel: reads the trail and the timeline of one of its
 * changes through the CLI, and answers the page's requests.
 *
 * Each read takes seconds, so the page is drawn in stages. What is known at
 * once comes first: the trail as this window last read it, or else what the
 * Trails view lists about it. The trail and the timeline are read side by
 * side, and each is drawn when it arrives.
 *
 * A commit in the timeline is matched to this clone by its SHA. When the
 * clone has it, the checkpoints it carries open in the detail panel.
 */
export class TrailPanelController implements vscode.Disposable {
  private loaded?: Loaded;
  /** What the page shows before the trail has been read: the facts from the Trails view's row. */
  private partial?: TrailView;
  private abort = new AbortController();
  private loadSequence = 0;
  private ready = false;
  private error?: { message: string; canRetry: boolean };
  /** A change the user picked in the panel, which overrides the default one. */
  private pickedChange?: number;
  private loadingMore = false;
  private disposed = false;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly disposeEmitter = new vscode.EventEmitter<void>();
  readonly onDidDispose = this.disposeEmitter.event;

  constructor(
    readonly panel: vscode.WebviewPanel,
    private readonly manager: RepoManager,
    private readonly actions: Actions,
    extensionUri: vscode.Uri,
    private target: TrailTarget,
    private readonly openCheckpoint: (target: DetailTarget) => void,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
    };
    panel.webview.html = panelHtml(panel.webview, extensionUri, 'trail');
    this.subscriptions.push(
      panel.webview.onDidReceiveMessage((message: unknown) => void this.onMessage(message)),
      panel.onDidDispose(() => this.dispose()),
    );
    void this.load({ reuse: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.abort.abort();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.disposeEmitter.fire();
    this.disposeEmitter.dispose();
  }

  /** True once the page's script has run and asked for data. */
  get webviewReady(): boolean {
    return this.ready;
  }

  /** What the panel currently shows, for the extension-host tests. */
  snapshot(): { view: TrailView; target: TrailTarget } | { error: string } | undefined {
    if (this.error) return { error: this.error.message };
    const view = this.loaded?.view ?? this.partial;
    return view ? { view, target: this.target } : undefined;
  }

  /** Reads the panel's trail again. The host calls this when the setting that allows trails changes. */
  refresh(): void {
    void this.load({ reuse: false });
  }

  /** Points the panel at another trail, reusing the tab. */
  show(target: TrailTarget): void {
    this.target = target;
    this.pickedChange = undefined;
    void this.load({ reuse: false });
  }

  /** Handles a message as if the page had sent it. The extension-host tests use this. */
  receive(message: TrailWebviewMessage): Promise<void> {
    return this.onMessage(message);
  }

  private post(message: TrailHostMessage): void {
    if (this.ready && !this.disposed) void this.panel.webview.postMessage(message);
  }

  private sendView(): void {
    const view = this.loaded?.view ?? this.partial;
    if (view) this.post({ type: 'trail', protocol: PROTOCOL_VERSION, view, restore: this.target });
  }

  /** Makes a trail the one the panel shows, and draws it. */
  private display(loaded: Loaded): void {
    this.loaded = loaded;
    this.partial = undefined;
    // A page of the timeline that was on its way belonged to the view this one replaces.
    this.loadingMore = false;
    this.panel.title = shortTitle(`#${loaded.detail.number} ${loaded.detail.title}`);
    this.sendView();
  }

  /** Ends the fresh read of a trail that was drawn from an earlier one. `notice` says so when the read failed. */
  private settle(loaded: Loaded, notice?: string): void {
    const wasRefreshing = loaded.view.refreshing === true;
    delete loaded.view.refreshing;
    if (notice) loaded.view.notice = notice;
    else delete loaded.view.notice;
    if (wasRefreshing || notice) this.post({ type: 'refreshed', ...(notice ? { notice } : {}) });
  }

  private showError(message: string, canRetry: boolean): void {
    this.loaded = undefined;
    this.partial = undefined;
    this.error = { message, canRetry };
    this.post({ type: 'error', message, canRetry });
  }

  /** The change to show: the one picked in the panel, or else the one that stands for the trail in this repository. */
  private position(changes: readonly TrailChange[], hosted: HostedRepo, branch: string | undefined): number {
    return this.pickedChange !== undefined && this.pickedChange < changes.length
      ? this.pickedChange
      : primaryChange(changes, hosted, branch);
  }

  /** A trail ready to draw, with its timeline still to come. */
  private frame(repo: RepoContext, hosted: HostedRepo, detail: TrailDetail): Loaded {
    const position = this.position(detail.changes, hosted, repo.branch);
    const change = detail.changes[position];
    const view = trailView(detail, hosted, repo.branch, position);
    if (change) view.timelinePending = true;
    return { repo, detail, view, events: [], ...(change ? { change } : {}) };
  }

  /**
   * Draws what is known about the trail at once, then reads the trail and
   * the timeline of the selected change, and draws each as it arrives.
   * `reuse` keeps the trail already read and reads only the timeline, for a
   * switch between the changes of one trail.
   */
  private async load(options: { reuse: boolean }): Promise<void> {
    const sequence = ++this.loadSequence;
    const stale = (): boolean => sequence !== this.loadSequence || this.disposed;
    this.abort.abort();
    this.abort = new AbortController();
    const signal = this.abort.signal;
    const reused = options.reuse ? this.loaded?.detail : undefined;
    this.loaded = undefined;
    this.partial = undefined;
    this.error = undefined;
    this.loadingMore = false;

    if (this.manager.viewState === 'loading') {
      // A panel restored at startup waits for the repositories to be read.
      this.post({ type: 'loading', title: 'Loading' });
      await this.manager.whenLoaded();
      if (stale()) return;
    }
    const repo = this.manager.repoFor(this.target.repoRoot);
    if (!repo) {
      this.showError('The repository for this tab is not open in this window.', false);
      return;
    }
    if (!this.manager.trailsEnabled) {
      // The setting is the user's word that nothing here reads Entire over the network.
      this.showError(TRAILS_OFF, true);
      return;
    }
    const hosted = repo.entireRepo;
    const cli = this.manager.cli;
    if (!hosted || !cli) {
      this.showError(
        cli
          ? 'Trails are available when the origin remote uses the entire:// scheme.'
          : 'The Entire CLI is not available.',
        true,
      );
      return;
    }

    const number = this.target.trail;
    const project = trailProject(hosted);
    const ref = this.manager.trailRef(repo, number, this.target.id);
    const readTimeline = (of: TimelineOf): Promise<Result<TrailTimeline>> =>
      cli.trailTimeline(repo.root, project, of, TIMELINE_PAGE, undefined, signal);

    // What is known before anything is read: the trail as this window last
    // read it, or else the row of the Trails view.
    const listed = repo.trails?.trails.find((trail) => trail.number === number);
    const known = reused ?? repo.trailMemory.get(number)?.detail;

    // Each CLI call takes seconds, so the trail and its timeline are read
    // side by side. The timeline call has to say what it reads before the
    // trail has said which changes it has.
    //
    // It names the trail, by ID when there is one, and the CLI picks the
    // change: that is the quickest call, and for a trail with one change,
    // which most have, it reads that change. It names a change instead when
    // the changes are known: all of them from an earlier read, or more than
    // one from the row. A row's list can fall short of the trail's, and a
    // row for a trail in the complete phase names none.
    //
    // Either way the answer is used only if it turns out to be for the change
    // that the trail, once read, has the panel show.
    const candidates = known ? known.changes : listed && listed.changes.length > 1 ? listed.changes : [];
    const guess = candidates[this.position(candidates, hosted, repo.branch)];
    const noBranchYet = known
      ? known.changes.length === 0
      : listed?.phase === 'planning' && listed.changes.length === 0;
    const earlyOf: TimelineOf | undefined = guess ? changeRef(guess) : noBranchYet ? undefined : { trail: ref };
    const early = earlyOf ? readTimeline(earlyOf) : undefined;
    const reading = reused ? undefined : this.manager.showTrail(repo, ref, signal);
    // Either answer can go unused: the timeline when it is of another change, both when another load takes over.
    void early?.catch(() => undefined);
    void reading?.catch(() => undefined);

    let current: Loaded | undefined;
    if (known) {
      current = this.frame(repo, hosted, known);
      const kept = current.change ? repo.trailMemory.timeline(number, current.change) : undefined;
      if (kept && current.change) {
        const events = await this.resolve(repo, current.change, kept.page.events);
        if (stale()) return;
        setTimeline(current, kept, events);
      }
      // Anything drawn from an earlier read is being checked against Entire.
      if (!reused || kept) current.view.refreshing = true;
      this.display(current);
    } else if (listed) {
      this.partial = { ...headerView(listed), partial: true };
      this.panel.title = shortTitle(`#${listed.number} ${listed.title}`);
      this.sendView();
    } else {
      this.post({ type: 'loading', title: 'Loading' });
    }

    let detail = reused;
    if (reading) {
      const read = await reading;
      if (stale()) return;
      if (!read.ok) {
        if (read.failure.kind === 'aborted') return;
        if (!current || read.failure.kind === 'notFound') {
          this.showError(read.failure.message, true);
          return;
        }
        // The trail as read earlier stays on screen, with the reason it could not be checked.
        if (current.view.timelinePending) {
          delete current.view.timelinePending;
          current.view.timeline = { events: [], hasMore: false, notice: `${read.failure.message} Refresh to try again.` };
          this.post({ type: 'timeline', timeline: current.view.timeline });
        }
        this.settle(current, `${read.failure.message} This is the trail as it was read earlier.`);
        return;
      }
      detail = read.value;
    }
    if (!detail) return;
    // The ID makes the next read of this trail quicker, after a window reload too.
    if (detail.id && this.target.id !== detail.id) this.target = { ...this.target, id: detail.id };

    if (!current || !sameData(current.detail, detail)) {
      const next = this.frame(repo, hosted, detail);
      // A timeline already on screen stays until the fresh one arrives, when it is of the same change.
      if (current?.change && next.change && sameChange(current.change, next.change)) carryTimeline(current, next);
      if (current?.view.refreshing) next.view.refreshing = true;
      current = next;
      this.display(current);
    }

    const change = current.change;
    let notice: string | undefined;
    if (change) {
      // The timeline read alongside the trail counts when it is of this
      // change. One that named the trail is of this change only when the
      // trail has no other: the CLI's answer does not say which it read.
      //
      // The CLI picks a change by its branch. A closed change has none left,
      // so the CLI refuses to pick it, and takes a second or two to say so.
      // Such a change is asked for by name at once.
      const byTrail = earlyOf !== undefined && 'trail' in earlyOf;
      const usable =
        earlyOf !== undefined &&
        (byTrail ? detail.changes.length === 1 && Boolean(change.branch) : sameChange(earlyOf, change));
      let of: TimelineOf = usable && earlyOf ? earlyOf : changeRef(change);
      let timeline = await (usable && early ? early : readTimeline(of));
      if (stale()) return;
      // When the CLI will not pick a change after all, the change is asked for by name.
      if (!timeline.ok && 'trail' in of && (timeline.failure.kind === 'exit' || timeline.failure.kind === 'notFound')) {
        of = changeRef(change);
        timeline = await readTimeline(of);
        if (stale()) return;
      }
      if (timeline.ok) {
        const fresh: RememberedTimeline = { of, page: timeline.value };
        repo.trailMemory.keepTimeline(number, change, fresh);
        if (!current.timeline || !samePage(current.timeline.page, fresh.page)) {
          const events = await this.resolve(repo, change, fresh.page.events);
          if (stale()) return;
          setTimeline(current, fresh, events);
          this.loadingMore = false;
          if (current.view.timeline) this.post({ type: 'timeline', timeline: current.view.timeline });
        }
      } else if (timeline.failure.kind === 'aborted') {
        return;
      } else if (current.view.timeline) {
        notice = `${timeline.failure.message} This is the timeline as it was read earlier.`;
      } else {
        // The trail itself loaded, so show it and say what is missing.
        delete current.view.timelinePending;
        current.view.timeline = { events: [], hasMore: false, notice: `${timeline.failure.message} Refresh to try again.` };
        this.post({ type: 'timeline', timeline: current.view.timeline });
      }
    }
    this.settle(current, notice);
  }

  /** Looks up each commit of a page of the timeline in this clone. */
  private async resolve(repo: RepoContext, change: TrailChange, events: TrailEvent[]): Promise<LoadedEvent[]> {
    // A change in another repository has its commits there, not here.
    const here = repo.entireRepo !== undefined && isInRepo(change, repo.entireRepo);
    return Promise.all(
      events.map(async (event): Promise<LoadedEvent> => {
        if (!here || !event.commitSha || !isCommitSha(event.commitSha)) return { event };
        const commit = await this.manager.git.commit(repo.root, event.commitSha);
        return commit ? { event, commit } : { event };
      }),
    );
  }

  private async loadMoreTimeline(): Promise<void> {
    const loaded = this.loaded;
    const first = loaded?.timeline;
    const cli = this.manager.cli;
    const hosted = loaded?.repo.entireRepo;
    if (!loaded?.change || !first || !loaded.nextPageToken || !cli || !hosted || this.loadingMore) return;
    if (!this.manager.trailsEnabled) return;
    this.loadingMore = true;
    const sequence = this.loadSequence;
    // A fresh read can put another timeline in place of this one while the page is on its way.
    const stale = (): boolean =>
      sequence !== this.loadSequence || this.disposed || this.loaded !== loaded || loaded.timeline !== first;
    try {
      const page = await cli.trailTimeline(
        loaded.repo.root,
        trailProject(hosted),
        first.of,
        TIMELINE_PAGE,
        loaded.nextPageToken,
        this.abort.signal,
      );
      if (stale()) return;
      if (!page.ok) {
        if (page.failure.kind !== 'aborted') {
          this.post({ type: 'timelinePage', events: [], hasMore: true, notice: page.failure.message });
        }
        return;
      }
      const events = await this.resolve(loaded.repo, loaded.change, page.value.events);
      if (stale()) return;
      loaded.events.push(...events);
      if (page.value.nextPageToken) loaded.nextPageToken = page.value.nextPageToken;
      else delete loaded.nextPageToken;
      const views = events.map(eventView);
      const hasMore = loaded.nextPageToken !== undefined;
      // Keep the host's copy of the view whole, so a page that reloads gets every entry.
      if (loaded.view.timeline) {
        loaded.view.timeline.events.push(...views);
        loaded.view.timeline.hasMore = hasMore;
      }
      this.post({ type: 'timelinePage', events: views, hasMore, ...timelineNotice(page.value) });
    } finally {
      if (this.loaded === loaded && loaded.timeline === first) this.loadingMore = false;
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isTrailWebviewMessage(raw)) return;
    const message: TrailWebviewMessage = raw;
    if (message.type === 'ready') {
      this.ready = true;
      if (this.loaded || this.partial) this.sendView();
      else if (this.error) this.post({ type: 'error', ...this.error });
      else this.post({ type: 'loading', title: 'Loading' });
      return;
    }
    if (message.type === 'retry') {
      void this.load({ reuse: false });
      return;
    }
    if (message.type === 'openLink') {
      await this.actions.openExternal(message.href);
      return;
    }

    const loaded = this.loaded;
    if (!loaded) return;
    const { repo, detail, change } = loaded;

    switch (message.type) {
      case 'selectChange':
        if (message.position < detail.changes.length && message.position !== loaded.view.selected) {
          this.pickedChange = message.position;
          void this.load({ reuse: true });
        }
        return;
      case 'openOnWeb':
        if (detail.url) await this.actions.openExternal(detail.url);
        return;
      case 'openChangeOnWeb':
        if (change?.url) await this.actions.openExternal(change.url);
        return;
      case 'openCheck': {
        const url = change?.mergeability?.checks[message.run]?.detailsUrl;
        if (url) await this.actions.openExternal(url);
        return;
      }
      case 'openCheckpoint': {
        const commit = loaded.events[message.event]?.commit;
        const checkpointId = commit?.checkpointIds[message.checkpoint];
        if (commit && checkpointId) {
          this.openCheckpoint({ repoRoot: repo.root, mode: 'checkpoint', checkpointId, commitSha: commit.sha });
        }
        return;
      }
      case 'showCommitDiff': {
        const commit = loaded.events[message.event]?.commit;
        if (commit) await this.actions.showCommitDiff(repo, commit.sha);
        return;
      }
      case 'copyCommitSha': {
        const sha = loaded.events[message.event]?.event.commitSha;
        if (sha) await this.actions.copy(sha, 'commit SHA');
        return;
      }
      case 'copyBranch':
        if (change?.branch) await this.actions.copy(change.branch, 'branch name');
        return;
      case 'copyLink':
        if (detail.url) await this.actions.copy(detail.url, 'trail link');
        return;
      case 'loadMoreTimeline':
        await this.loadMoreTimeline();
        return;
    }
  }
}

function eventView({ event, commit }: LoadedEvent): TrailEventView {
  const view: TrailEventView = { kind: event.kind, text: eventText(event) };
  if (event.actor) view.actor = event.actor;
  if (event.occurredAt) view.at = event.occurredAt;
  if (event.commitSha) {
    view.commit = {
      shortSha: commit?.shortSha ?? event.commitSha.slice(0, 7),
      local: commit !== undefined,
      checkpoints: commit?.checkpointIds.length ?? 0,
      remoteCheckpoints: event.checkpointCount ?? 0,
      agents: event.agents,
      ...(event.additions !== undefined ? { additions: event.additions } : {}),
      ...(event.deletions !== undefined ? { deletions: event.deletions } : {}),
      ...(event.filesChanged !== undefined ? { files: event.filesChanged } : {}),
    };
  }
  return view;
}

function timelineNotice(timeline: TrailTimeline): { notice?: string } {
  return timeline.incomplete
    ? { notice: 'Entire could not read the whole history of this branch, so some commits may be missing.' }
    : {};
}

function shortTitle(title: string): string {
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}
