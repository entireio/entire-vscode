import * as vscode from 'vscode';
import { hasBrain, type BrainStatus } from '../core/brain';
import { fail, type Failure } from '../core/errors';
import type { RunningServer } from '../core/serverProcess';
import type { RepoContext, RepoManager } from './repoManager';

/** How a request to open the brain graph ended. The caller words the message. */
export type BrainOutcome =
  /** The page is open. `started` says whether a server had to be started for it. */
  | { kind: 'opened'; url: string; started: boolean }
  /** The entire-brain plugin is not installed. */
  | { kind: 'pluginMissing' }
  /** The repository has no brain yet. */
  | { kind: 'noBrain' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/** What the Brain view shows: the brain's details, or the reason it has none. */
export type BrainViewState = 'loading' | 'pluginMissing' | 'noBrain' | 'failed' | 'ready';

/** What is known about the brain of one repository, as far as it has been read. */
export interface BrainInfo {
  loading: boolean;
  /** The plugin's last report. Kept while a fresh one is read. */
  status?: BrainStatus;
  /** Why the last read gave no report. */
  failure?: Failure;
}

interface Running {
  server: RunningServer;
  /** The branch that was checked out when the server started. It reads the branch once. */
  branch: string | undefined;
}

/**
 * The brain of each open repository: what the entire-brain plugin reports
 * about it, for the Brain view, and the plugin's graph page.
 *
 * The report is read when the Brain view is first shown and on Refresh, and
 * not before: the view starts collapsed, and a repository may have no brain.
 *
 * The graph page is the one `entire brain viz` serves on the loopback
 * address. It opens in the browser. It cannot be shown in an editor tab,
 * because the plugin's server forbids every other page from framing it
 * (`frame-ancestors 'none'`). The server runs until it is stopped, so this
 * owns one per repository and stops them all when the window closes.
 *
 * Nothing here installs the plugin or builds a brain: both write, and the
 * extension only reads.
 */
export class BrainService implements vscode.Disposable {
  /**
   * Opens a page of a server on this machine. The address goes through
   * `asExternalUri` first, which forwards the port when the extension runs
   * on another machine than the browser. The extension-host tests replace
   * this, so that no browser opens.
   */
  openUrl: (url: string) => Thenable<unknown> = async (url) =>
    vscode.env.openExternal(await vscode.env.asExternalUri(vscode.Uri.parse(url, true)));

  private readonly info = new Map<string, BrainInfo>();
  /** Counts the reads of each repository's report, so a late answer to an earlier one is dropped. */
  private readonly reads = new Map<string, number>();
  private readonly servers = new Map<string, Running>();
  /** Starts under way, by repository, so that two requests share one. */
  private readonly starting = new Map<string, Promise<BrainOutcome>>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a report arrives or a server starts or stops. */
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;
  private disposed = false;

  constructor(
    private readonly manager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {
    // A repository that leaves the window takes its report and its server with it.
    this.subscription = manager.onDidChange(() => {
      let dropped = false;
      for (const root of new Set([...this.servers.keys(), ...this.info.keys()])) {
        if (manager.repoFor(root)) continue;
        this.servers.get(root)?.server.stop();
        this.servers.delete(root);
        this.info.delete(root);
        dropped = true;
      }
      // The state the view shows also depends on which repositories have Entire enabled.
      this.sync();
      if (dropped) this.changed.fire();
    });
    this.sync();
  }

  /** What has been read about the brain of a repository. Undefined until the Brain view asks. */
  details(root: string): BrainInfo | undefined {
    return this.info.get(root);
  }

  /**
   * What the Brain view shows. With one repository, a brain that cannot be
   * listed leaves the view empty and this says why. With several, each
   * repository has a row of its own and says so under it.
   */
  state(): BrainViewState {
    const repos = this.manager.enabledRepos;
    if (repos.length !== 1 || !repos[0]) return 'ready';
    return this.stateOf(repos[0].root);
  }

  /** The same, for one repository. */
  stateOf(root: string): BrainViewState {
    const info = this.info.get(root);
    if (!info || (info.loading && !info.status && !info.failure)) return 'loading';
    if (info.status) return hasBrain(info.status) ? 'ready' : 'noBrain';
    return info.failure?.kind === 'pluginMissing' ? 'pluginMissing' : 'failed';
  }

  /**
   * Reads the report of each repository that has not been asked about yet.
   * The Brain view calls this when it is shown.
   */
  ensureStatus(): void {
    for (const repo of this.manager.enabledRepos) {
      if (!this.info.has(repo.root)) void this.loadStatus(repo);
    }
  }

  /** Reads again every report that has been read. Refresh calls this. */
  refresh(): void {
    for (const root of [...this.info.keys()]) {
      const repo = this.manager.repoFor(root);
      if (repo) void this.loadStatus(repo);
    }
  }

  /** Reads the plugin's report on one repository. The one already shown stays until the answer arrives. */
  async loadStatus(repo: RepoContext, signal?: AbortSignal): Promise<BrainInfo> {
    const cli = this.manager.cli;
    const read = (this.reads.get(repo.root) ?? 0) + 1;
    this.reads.set(repo.root, read);
    const before = this.info.get(repo.root);
    const pending: BrainInfo = { ...before, loading: true };
    this.info.set(repo.root, pending);
    this.announce();

    const result = cli
      ? await cli.brainStatus(repo.root, signal)
      : fail<BrainStatus>('cliMissing', 'The Entire CLI is not available.');
    // A newer read, or the repository leaving the window, makes this answer stale.
    if (this.reads.get(repo.root) !== read || this.info.get(repo.root) !== pending) {
      return this.info.get(repo.root) ?? { loading: false };
    }
    if (!result.ok && result.failure.kind === 'aborted') {
      // A cancelled read says nothing new. What was known before still stands.
      if (before) this.info.set(repo.root, { ...before, loading: false });
      else this.info.delete(repo.root);
      this.announce();
      return this.info.get(repo.root) ?? { loading: false, failure: result.failure };
    }
    const next: BrainInfo = result.ok ? { loading: false, status: result.value } : { loading: false, failure: result.failure };
    if (!result.ok && result.failure.kind !== 'pluginMissing') {
      this.log.warn(`${repo.name}: ${result.failure.message} ${result.failure.detail ?? ''}`.trim());
    }
    this.info.set(repo.root, next);
    this.announce();
    return next;
  }

  /** Whether a graph server is up, for one repository or for any. */
  running(root?: string): boolean {
    return root === undefined ? this.servers.size > 0 : this.servers.has(root);
  }

  /** The address of the repository's graph page, while its server runs. */
  url(root: string): string | undefined {
    return this.servers.get(root)?.server.url;
  }

  /** Whether opening the graph has to start a server first, which takes a moment. */
  needsStart(repo: RepoContext): boolean {
    const running = this.servers.get(repo.root);
    return !running || running.branch !== repo.branch;
  }

  /**
   * Opens the graph of a repository's brain, starting its server when none
   * runs. `signal` gives up on a start that is still under way.
   */
  async open(repo: RepoContext, signal?: AbortSignal): Promise<BrainOutcome> {
    if (this.disposed) return { kind: 'cancelled' };
    const running = this.servers.get(repo.root);
    if (running && running.branch === repo.branch) {
      await this.openUrl(running.server.url);
      return { kind: 'opened', url: running.server.url, started: false };
    }
    // The server read the branch when it started. Another branch needs another server.
    if (running) this.stop(repo.root);

    let start = this.starting.get(repo.root);
    if (!start) {
      start = this.start(repo, signal).finally(() => this.starting.delete(repo.root));
      this.starting.set(repo.root, start);
    }
    return start;
  }

  private async start(repo: RepoContext, signal?: AbortSignal): Promise<BrainOutcome> {
    const cli = this.manager.cli;
    if (!cli) return { kind: 'failed', message: 'The Entire CLI is not available.' };

    // The server would start without a brain and show an empty page, so the report is read first.
    const info = await this.loadStatus(repo, signal);
    if (signal?.aborted) return { kind: 'cancelled' };
    if (info.status) {
      if (!hasBrain(info.status)) return { kind: 'noBrain' };
    } else if (info.failure?.kind === 'pluginMissing') {
      return { kind: 'pluginMissing' };
    }
    // Any other failure to read the report is no reason not to try: the page says what the brain holds.

    const started = await cli.startBrainViz(repo.root, signal);
    if (!started.ok) {
      if (started.failure.kind === 'pluginMissing') return { kind: 'pluginMissing' };
      if (started.failure.kind === 'aborted') return { kind: 'cancelled' };
      this.log.warn(`${repo.name}: ${started.failure.message} ${started.failure.detail ?? ''}`.trim());
      return { kind: 'failed', message: started.failure.message };
    }
    const server = started.value;
    if (this.disposed || !this.manager.repoFor(repo.root)) {
      // The window closed, or the repository left it, while the server started.
      server.stop();
      return { kind: 'cancelled' };
    }
    this.servers.set(repo.root, { server, branch: repo.branch });
    void server.exited.then(() => {
      if (this.servers.get(repo.root)?.server !== server) return;
      this.servers.delete(repo.root);
      this.announce();
    });
    this.announce();
    await this.openUrl(server.url);
    return { kind: 'opened', url: server.url, started: true };
  }

  /** Stops the graph server of one repository, or every server. */
  stop(root?: string): void {
    for (const key of root === undefined ? [...this.servers.keys()] : [root]) {
      this.servers.get(key)?.server.stop();
      this.servers.delete(key);
    }
    this.announce();
  }

  dispose(): void {
    this.disposed = true;
    this.subscription.dispose();
    this.stop();
    this.changed.dispose();
  }

  /** Publishes what the Brain view and the Stop command depend on, then redraws the view. */
  private announce(): void {
    this.sync();
    if (!this.disposed) this.changed.fire();
  }

  private sync(): void {
    void vscode.commands.executeCommand('setContext', 'entire.brainRunning', this.servers.size > 0);
    void vscode.commands.executeCommand('setContext', 'entire.brainState', this.state());
  }
}
