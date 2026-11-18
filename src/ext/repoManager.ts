import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import {
  CheckpointIndex,
  LIST_LIMIT,
  loadPage,
  PAGE_SIZE,
  type SessionCheckpoint,
} from '../core/checkpointIndex';
import { CheckpointStore } from '../core/checkpointStore';
import {
  isExecutableFile,
  isSupportedVersion,
  locateCli,
  loginShellProbe,
  MIN_CLI_VERSION_TEXT,
  type CliSource,
  type CliVersion,
} from '../core/cliLocator';
import { EntireCli } from '../core/entireCli';
import { fail, type Failure, type Result } from '../core/errors';
import type { Exec } from '../core/exec';
import type { Git, RepoPaths } from '../core/git';
import {
  REMOTE_SESSIONS_PAGE,
  type RemoteCheckpoint,
  type RemoteSession,
  type RemoteSessionPage,
} from '../core/remoteSessions';
import { Lane } from '../core/scheduler';
import type { CheckpointDetail, SessionRow, StatusInfo, TrailDetail, TrailSummary } from '../core/schemas';
import { TrailMemory } from '../core/trailMemory';
import {
  addTrailPage,
  DEFAULT_TRAIL_FILTER,
  inTrailFilter,
  readTrailPages,
  trailFilterKey,
  trailProject,
  trailRepo,
  type TrailFilter,
  type TrailListStatus,
  type TrailPages,
  type TrailRef,
} from '../core/trails';
import { parseEntireRemote, resolveWebBase, type EntireRepo } from '../core/webLinks';

/**
 * Names of the lists the views page through. Each list shows one page of rows
 * and grows by a page when its Load More row is used.
 */
export const LISTS = {
  commits: 'commits',
  otherCheckpoints: 'other',
  activeSessions: 'sessions:active',
  recentSessions: 'sessions:recent',
  sessionCheckpoints: (sessionId: string): string => `session:${sessionId}`,
  /**
   * Each fresh read of the trails, and each change of the filter, gets a list
   * of its own, so it starts again at one page and its Load More row is new
   * to the editor.
   */
  trails: (filter: string, read: number): string => `trails:${filter}:${read}`,
} as const;

export type ViewState = 'loading' | 'noFolder' | 'notGit' | 'cliMissing' | 'cliTooOld' | 'notEnabled' | 'ready';

/** What the Trails view shows: rows, or the reason it has none. */
export type TrailsState = 'loading' | 'loggedOut' | 'noAccess' | 'failed' | 'empty' | 'ready';

/**
 * The trails of one repository, as far as they have been read: the ones the
 * CLI lists for a status. The view's filter may show only some of them. See
 * `RepoManager.shownTrails`.
 */
export interface TrailList extends TrailPages {
  /** The list's name for paging. See `LISTS.trails`. */
  list: string;
  /** What the CLI was asked to list: open trails, closed trails, or all. */
  status: TrailListStatus;
  /** The first page is being read. */
  loading: boolean;
  /** Why the last read failed. */
  failure?: Failure;
}

/**
 * Entire's list of a repository's sessions, as far as it has been read. It
 * is the list on the Sessions page of entire.com, and it names each session.
 */
export interface RemoteSessionList {
  /** By session ID, in Entire's order: most recent activity first. */
  sessions: Map<string, RemoteSession>;
  /** Asks Entire for the next page. Absent once the last page has been read. */
  nextCursor?: string;
  /** The first page is being read. */
  loading: boolean;
  /** Why the last read failed. */
  failure?: Failure;
}

/** The checkpoints Entire lists for one session. `checkpoints` is set once the read has answered. */
interface RemoteCheckpointRead {
  read: Promise<RemoteCheckpoint[] | undefined>;
  checkpoints?: RemoteCheckpoint[];
  /** When the read failed. It is not tried again for a while, or until a manual refresh. */
  failedAt?: number;
}

/**
 * How long a failed read of a session's checkpoints stands. The Sessions
 * view asks again each time it redraws, which it does every few seconds.
 */
const REMOTE_CHECKPOINTS_RETRY_MS = 60_000;

/** Pages of sessions one read may ask Entire for, so a long list cannot be read to its end in one go. */
const MAX_REMOTE_SESSION_PAGES_PER_READ = 4;

function addRemoteSessions(list: RemoteSessionList, page: RemoteSessionPage, asked?: string): void {
  // A session moves to the front when it sees activity, so it can turn up again on a later page.
  for (const session of page.sessions) {
    if (!list.sessions.has(session.sessionId)) list.sessions.set(session.sessionId, session);
  }
  // A cursor that leads back to itself would be asked for without end.
  if (page.nextCursor && page.nextCursor !== asked) list.nextCursor = page.nextCursor;
  else delete list.nextCursor;
}

const instant = (date?: string): number => (date ? Date.parse(date) : 0) || 0;

const DETAIL_CACHE_SIZE = 200;
/**
 * A checkpoint is addressed by ID and changes only when the CLI finalizes its
 * transcript or adds a summary, so details are reused for this long. A manual
 * refresh clears them.
 */
const DETAIL_TTL_MS = 5 * 60_000;
/** Automatic enrichment runs at most this often per repository. */
const ENRICHMENT_MIN_INTERVAL_MS = 60_000;
const ENRICHMENT_DEBOUNCE_MS = 3000;

/** A session as the Sessions view shows it, merged from every source that knows it. */
export interface SessionEntry {
  sessionId: string;
  agent?: string;
  model?: string;
  /** `active`, `idle`, `ended`, or undefined when only checkpoints mention it. */
  status?: string;
  branch?: string;
  /**
   * The session's name. For a session that Entire lists, it is the name
   * entire.com shows: one a person set, or else the title Entire wrote. For
   * any other, it is the prompt that opened the session, known once the
   * transcript of one of its checkpoints has been read.
   */
  name?: string;
  /** The prompt that opened the session, when that is known and is not its name. */
  opening?: string;
  /** How many checkpoints Entire counts for the session. Set for a session that Entire lists. */
  listedCheckpoints?: number;
  /** Entire's own list of the session's checkpoints has been read, and `checkpoints` holds it. */
  checkpointsFromEntire?: boolean;
  /** The latest prompt, known only when local session state exists. */
  lastPrompt?: string;
  /** Message of the newest checkpoint: its commit subject, or its prompt when no commit carries it. */
  title?: string;
  /** ISO time of the last activity or the newest checkpoint. */
  lastActive?: string;
  /** The row from `entire session list`, when local state exists. */
  local?: SessionRow;
  /** Newest first. */
  checkpoints: SessionCheckpoint[];
  /** The session may have earlier checkpoints than the ones listed here. */
  mayHaveEarlier?: boolean;
}

export class RepoContext {
  readonly name: string;
  originUrl?: string;
  entireRepo?: EntireRepo;
  branch?: string;
  status?: StatusInfo;
  index?: CheckpointIndex;
  /** Set when the commit history could not be read. */
  gitError?: string;
  sessionRows?: SessionRow[];
  /** Bumped whenever the branch tip changes, so late results can be dropped. */
  generation = 0;
  lastEnrichment = 0;
  lastRefresh = 0;
  enrichmentTimer?: NodeJS.Timeout;
  readonly details = new Map<string, { at: number; result: Promise<Result<CheckpointDetail>> }>();
  /** Rows each list shows, for lists that have grown past their first page. */
  private readonly limits = new Map<string, number>();
  /** Lists that stopped loading on scroll, and wait for a click on Load More. */
  readonly autoLoadPaused = new Set<string>();
  /**
   * Checkpoints the CLI could not find when asked, here or on the remote. A
   * commit records a checkpoint's ID, but the session data is uploaded
   * separately, and for these it was not. Cleared by a manual refresh.
   */
  readonly withoutData = new Set<string>();
  /** Authors the CLI named for checkpoints that no commit read so far carries, by checkpoint ID. */
  readonly checkpointAuthors = new Map<string, string>();
  /**
   * The prompt that opens each session, by session ID. A session's opening
   * prompt does not change, so a name is kept for as long as the window is
   * open. `name` is null for a session none of whose checkpoints stored a
   * transcript to read it from. `checkpoints` says how many the session had
   * then, so that the session is looked at again once it has more.
   */
  readonly sessionNames = new Map<string, { name: string | null; checkpoints: number }>();
  /** Unset until the Sessions view first asks, so nothing reads entire.io before then. */
  remoteSessions?: RemoteSessionList;
  /** Counts the reads of Entire's session list, so a late answer to an earlier one can be dropped. */
  remoteSessionReads = 0;
  /** The checkpoints Entire lists for a session, by session ID, for the sessions that were asked about. */
  readonly remoteCheckpoints = new Map<string, RemoteCheckpointRead>();
  /** Unset until the Trails view first asks, so nothing reads entire.io before then. */
  trails?: TrailList;
  /** Counts the reads of the trail list, so a late answer to an earlier one can be dropped. */
  trailReads = 0;
  /** Web pages of trails, by trail number, as `entire trail show` reported them. */
  readonly trailUrls = new Map<number, string>();
  /** Trails read in this window, so a trail panel can draw one at once while it reads it again. */
  readonly trailMemory = new TrailMemory();

  constructor(readonly paths: RepoPaths) {
    this.name = path.basename(paths.root);
  }

  get root(): string {
    return this.paths.root;
  }

  get enabled(): boolean {
    return this.status?.enabled === true;
  }

  /** How many rows of a list the views show. */
  limit(list: string): number {
    return this.limits.get(list) ?? PAGE_SIZE;
  }

  showMore(list: string): void {
    this.limits.set(list, this.limit(list) + PAGE_SIZE);
  }

  /** Drops what is kept about a list that no longer exists. */
  forgetList(list: string): void {
    this.limits.delete(list);
    this.autoLoadPaused.delete(list);
  }

  /** Drops everything Entire said about the repository's sessions. An answer still on its way is ignored. */
  forgetRemoteSessions(): void {
    this.remoteSessions = undefined;
    this.remoteSessionReads += 1;
    this.remoteCheckpoints.clear();
  }

  /** Drops everything read about the repository's trails. An answer still on its way is ignored. */
  forgetTrails(): void {
    if (this.trails) this.forgetList(this.trails.list);
    this.trails = undefined;
    this.trailReads += 1;
    this.trailUrls.clear();
    this.trailMemory.clear();
  }
}

/** What a trail panel says while the `entire.trails.enabled` setting is off. */
export const TRAILS_OFF = 'Trails are turned off. Turn on the entire.trails.enabled setting to read them from Entire.';

/**
 * Owns what the extension knows about each open repository and decides which
 * git and CLI calls run when.
 */
export class RepoManager implements vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;

  repos: RepoContext[] = [];
  viewState: ViewState = 'loading';
  cli?: EntireCli;
  cliVersion?: CliVersion;
  /**
   * Where the CLI was found and how, even when it is too old to use. The
   * Setup view runs the CLI by this path in a terminal.
   */
  cliPath?: string;
  cliSource?: CliSource;
  readonly store: CheckpointStore;

  /** The filter of the Trails view, shared by every repository in it. */
  trailFilter: TrailFilter = DEFAULT_TRAIL_FILTER;

  private readonly cliLane = new Lane(4);
  /** Sessions whose opening prompt is being read, and the reads that wait their turn. */
  private readonly naming = new Set<string>();
  private readonly nameQueue: (() => Promise<void>)[] = [];
  private nameWorkers = 0;
  private namesTimer: NodeJS.Timeout | undefined;
  /** The latest history scan of each repository, which the next one waits for. */
  private readonly scans = new WeakMap<RepoContext, Promise<boolean>>();
  /** The latest page read of each trail list, which the next one waits for. */
  private readonly trailPageReads = new WeakMap<TrailList, Promise<boolean>>();
  /** The latest page read of each of Entire's session lists, which the next one waits for. */
  private readonly remoteSessionPageReads = new WeakMap<RemoteSessionList, Promise<boolean>>();
  private loadSequence = 0;

  constructor(
    readonly git: Git,
    private readonly exec: Exec,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.store = new CheckpointStore(git);
  }

  dispose(): void {
    for (const repo of this.repos) clearTimeout(repo.enrichmentTimer);
    clearTimeout(this.namesTimer);
    this.nameQueue.length = 0;
    this.changed.dispose();
  }

  repoFor(root: string): RepoContext | undefined {
    return this.repos.find((repo) => repo.root === root);
  }

  /** Resolves once the first load has settled, for panels restored at startup. */
  whenLoaded(): Promise<void> {
    if (this.viewState !== 'loading') return Promise.resolve();
    return new Promise((resolve) => {
      const subscription = this.onDidChange(() => {
        if (this.viewState === 'loading') return;
        subscription.dispose();
        resolve();
      });
    });
  }

  /** Repositories that have Entire enabled, which are the ones the views show. */
  get enabledRepos(): RepoContext[] {
    return this.repos.filter((repo) => repo.enabled);
  }

  webBase(): string {
    const setting = vscode.workspace.getConfiguration('entire').get<string>('webBaseUrl');
    return resolveWebBase(setting, process.env);
  }

  /**
   * Finds the CLI and the repositories, then loads each one. A manual refresh
   * also reloads the full session list, which automatic refreshes never do.
   */
  async reload(options: { manual: boolean }): Promise<void> {
    const sequence = ++this.loadSequence;
    const stale = (): boolean => sequence !== this.loadSequence;
    const previous = new Map(this.repos.map((repo) => [repo.root, repo]));
    this.setState(this.repos.length === 0 ? 'loading' : this.viewState);

    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === 'file' || folder.uri.scheme === 'vscode-remote',
    );
    if (folders.length === 0) {
      this.replaceRepos([]);
      this.setState('noFolder');
      return;
    }

    const repos: RepoContext[] = [];
    for (const folder of folders) {
      const paths = await this.git.repoPaths(folder.uri.fsPath);
      if (stale()) return;
      if (!paths.ok) {
        this.log.info(`${folder.uri.fsPath}: ${paths.failure.message} ${paths.failure.detail ?? ''}`.trim());
        continue;
      }
      if (repos.some((repo) => repo.root === paths.value.root)) continue;
      const existing = previous.get(paths.value.root);
      repos.push(existing ?? new RepoContext(paths.value));
    }
    this.replaceRepos(repos);
    if (repos.length === 0) {
      this.setState('notGit');
      return;
    }

    const cwd = repos[0]?.root ?? os.homedir();
    const configured = vscode.workspace.getConfiguration('entire').get<string>('cliPath');
    const located = await locateCli(configured, {
      env: process.env,
      platform: process.platform,
      homedir: os.homedir(),
      isExecutable: isExecutableFile,
      probeLoginShell: loginShellProbe(this.exec, process.env, cwd),
    });
    if (stale()) return;
    this.cliPath = located?.path;
    this.cliSource = located?.source;
    if (!located) {
      this.cli = undefined;
      this.log.warn(
        configured?.trim()
          ? `entire.cliPath is set to "${configured}", but no executable exists there.`
          : 'The Entire CLI was not found on PATH, in common install locations, or through the login shell.',
      );
      this.setState('cliMissing');
      return;
    }

    const cli = new EntireCli(located.path, this.exec, this.cliLane, (line) => this.log.info(line));
    const version = await cli.version(cwd);
    if (stale()) return;
    if (!version.ok) {
      this.cli = undefined;
      this.log.warn(`${located.path}: ${version.failure.message} ${version.failure.detail ?? ''}`.trim());
      this.setState('cliMissing');
      return;
    }
    this.cliVersion = version.value;
    this.log.info(`Using Entire CLI ${version.value.raw} at ${located.path} (found through ${located.source}).`);
    if (!isSupportedVersion(version.value)) {
      this.cli = undefined;
      this.log.warn(`Entire CLI ${version.value.raw} is older than the required ${MIN_CLI_VERSION_TEXT}.`);
      this.setState('cliTooOld');
      return;
    }
    this.cli = cli;

    await Promise.all(repos.map((repo) => this.loadStatus(repo)));
    if (stale()) return;
    if (options.manual) {
      for (const repo of repos) {
        repo.trailUrls.clear();
        repo.trailMemory.clear();
        // Only lists the Trails view has already asked for. Nothing waits for them.
        if (repo.entireRepo && repo.trails) void this.loadTrails(repo);
      }
    }
    if (this.enabledRepos.length === 0) {
      this.setState('notEnabled');
      return;
    }

    await Promise.all(
      this.enabledRepos.map(async (repo) => {
        repo.details.clear();
        repo.withoutData.clear();
        await this.loadGit(repo, { force: true });
        this.scheduleEnrichment(repo, { immediate: true });
        if (options.manual && repo.sessionRows !== undefined) await this.loadSessionRows(repo);
        if (options.manual && repo.remoteSessions !== undefined) {
          // Only a list the Sessions view has already asked for. Nothing waits for it.
          repo.remoteCheckpoints.clear();
          void this.loadRemoteSessions(repo);
        }
      }),
    );
    if (stale()) return;
    this.setState('ready');
  }

  /** Re-reads HEAD and rebuilds the commit index when the branch tip moved. */
  async refreshGit(repo: RepoContext): Promise<void> {
    if (!repo.enabled || !this.cli) return;
    const changed = await this.loadGit(repo, { force: false });
    if (changed) {
      this.scheduleEnrichment(repo, { immediate: false });
      this.changed.fire();
    }
  }

  /** Re-reads `entire status --json`, the only session source with no side effects. */
  async refreshStatus(repo: RepoContext): Promise<void> {
    if (!this.cli) return;
    const wasEnabled = repo.enabled;
    await this.loadStatus(repo);
    if (repo.enabled !== wasEnabled) {
      await this.reload({ manual: false });
      return;
    }
    this.changed.fire();
  }

  /**
   * Shows one more page of a list. Three lists have more to read than they
   * hold: the commit list scans further back in history when the commits
   * already scanned run short, and the trail list and the session list ask
   * Entire for the next page.
   */
  async showMore(repo: RepoContext, list: string, options: { automatic: boolean } = { automatic: false }): Promise<void> {
    const trails = repo.trails?.list === list ? repo.trails : undefined;
    const sessions = list === LISTS.recentSessions && repo.remoteSessions !== undefined;
    const visible = (): number =>
      trails
        ? Math.min(repo.limit(list), this.shownTrails(trails).length)
        : sessions
          ? Math.min(repo.limit(list), this.sessions(repo).recent.length)
          : Math.min(repo.limit(LISTS.commits), repo.index?.commits.length ?? 0);
    const before = visible();
    repo.showMore(list);
    if (!options.automatic) repo.autoLoadPaused.delete(list);
    if (list === LISTS.commits || trails || sessions) {
      const read = trails
        ? await this.readMoreTrails(repo, trails)
        : sessions
          ? await this.readMoreRemoteSessions(repo)
          : await this.scanForCommits(repo);
      if (!read && !options.automatic) {
        void vscode.window.showWarningMessage(
          trails
            ? 'Entire could not load more trails.'
            : sessions
              ? 'Entire could not load more sessions.'
              : 'Entire could not read more of the commit history.',
        );
      }
      // A scan stops after a fixed stretch of history. When loading on scroll
      // finds no new row in that stretch, the Load More row is still in view
      // and would start the next scan at once, and so on to the first commit.
      // Stop there and leave the rest to a click. The same goes for trails:
      // for a page that fails to load, and for a read that finds no trail
      // the filter shows.
      if (options.automatic && (!read || visible() <= before)) repo.autoLoadPaused.add(list);
    }
    this.changed.fire();
  }

  /**
   * Whether the extension may read trails. They are the one thing it reads
   * over the network, and the `entire.trails.enabled` setting turns them off.
   */
  get trailsEnabled(): boolean {
    return vscode.workspace.getConfiguration('entire').get<boolean>('trails.enabled', true);
  }

  /** Repositories that Entire hosts, which are the ones the Trails view lists. None while trails are turned off. */
  get trailRepos(): RepoContext[] {
    if (!this.trailsEnabled) return [];
    // Trails live on entire.io, so a repository can have them before Entire is enabled in its clone.
    if (this.viewState !== 'ready' && this.viewState !== 'notEnabled') return [];
    return this.repos.filter((repo) => repo.entireRepo !== undefined);
  }

  /**
   * Applies a change of the `entire.trails.enabled` setting. Turning trails
   * off hides the Trails view and drops what was read, so turning them on
   * again starts from a fresh read.
   */
  applyTrailsSetting(): void {
    if (!this.trailsEnabled) {
      for (const repo of this.repos) repo.forgetTrails();
    }
    this.trailsChanged();
  }

  /**
   * The trails of a list that the filter shows. The CLI lists by status, so a
   * filter on a phase keeps the trails in that phase out of the ones read so
   * far.
   */
  shownTrails(list: TrailList): TrailSummary[] {
    const filter = this.trailFilter;
    return filter.phase ? list.trails.filter((trail) => inTrailFilter(trail, filter)) : list.trails;
  }

  /**
   * What the Trails view shows. With one repository, a list with no rows
   * leaves the view empty and this says why. With several, each repository
   * has a row of its own and says so under it.
   */
  trailsState(): TrailsState {
    const repos = this.trailRepos;
    if (repos.length !== 1) return 'ready';
    const list = repos[0]?.trails;
    if (!list || (list.loading && list.trails.length === 0)) return 'loading';
    if (this.shownTrails(list).length > 0) return 'ready';
    if (list.failure) {
      if (list.failure.kind === 'notLoggedIn') return 'loggedOut';
      return list.failure.kind === 'noAccess' ? 'noAccess' : 'failed';
    }
    // No row passes the filter yet, but the CLI has more to list: the view keeps its Load More row.
    return list.nextPageToken ? 'ready' : 'empty';
  }

  /**
   * Reads the first page of trails for each repository that has not been
   * asked about yet. The Trails view calls this when it is shown.
   */
  ensureTrails(): void {
    for (const repo of this.trailRepos) {
      if (!repo.trails) void this.loadTrails(repo);
    }
  }

  /**
   * Changes which trails the Trails view shows: every trail, the open ones,
   * the closed ones, or the open ones in one phase.
   */
  async setTrailFilter(filter: TrailFilter): Promise<void> {
    if (trailFilterKey(filter) === trailFilterKey(this.trailFilter)) return;
    this.trailFilter = filter;
    this.trailsChanged();
    await Promise.all(
      this.trailRepos.map((repo) => {
        const list = repo.trails;
        // A phase is matched here, so the trails already read for the status serve any phase of it.
        const reusable = list !== undefined && list.status === filter.status && !list.loading && !list.failure;
        return reusable ? this.refilterTrails(repo, list) : this.loadTrails(repo);
      }),
    );
  }

  /** Starts the trail list of a repository over from its first page. */
  loadTrails(repo: RepoContext): Promise<void> {
    return this.withViewProgress('entire.trails', this.readFirstTrails(repo));
  }

  private async readFirstTrails(repo: RepoContext): Promise<void> {
    const cli = this.cli;
    const entireRepo = repo.entireRepo;
    if (!cli || !entireRepo || !this.trailsEnabled) return;
    const read = ++repo.trailReads;
    const filter = this.trailFilter;
    const list: TrailList = {
      list: LISTS.trails(trailFilterKey(filter), read),
      status: filter.status,
      trails: [],
      loading: true,
    };
    // A refresh keeps the rows on screen until the fresh ones arrive. Rows of
    // another status go at once: they would sit under the wrong heading.
    const previous = repo.trails;
    if (!previous || previous.status !== list.status || previous.trails.length === 0) {
      repo.trails = list;
      this.trailsChanged();
    }
    const page = await cli.listTrails(
      repo.root,
      { project: trailProject(entireRepo), repo: trailRepo(entireRepo) },
      list.status,
      PAGE_SIZE,
    );
    if (read !== repo.trailReads) return;
    list.loading = false;
    if (page.ok) {
      addTrailPage(list, page.value);
    } else {
      list.failure = page.failure;
      this.log.warn(`${repo.name}: ${page.failure.message} ${page.failure.detail ?? ''}`.trim());
    }
    if (previous && previous !== list) repo.forgetList(previous.list);
    repo.trails = list;
    this.trailsChanged();
    // With a filter on a phase, the first page may hold few trails that pass it.
    await this.readMoreTrails(repo, list);
    this.trailsChanged();
  }

  /** Shows the trails already read under a filter that has changed, from the first page of rows. */
  private async refilterTrails(repo: RepoContext, list: TrailList): Promise<void> {
    repo.forgetList(list.list);
    list.list = LISTS.trails(trailFilterKey(this.trailFilter), ++repo.trailReads);
    this.trailsChanged();
    await this.readMoreTrails(repo, list);
    this.trailsChanged();
  }

  /**
   * Names a trail for a CLI call: by its ID when the caller, the Trails view,
   * or an earlier read has it, and by its number otherwise.
   */
  trailRef(repo: RepoContext, trail: number, id?: string): TrailRef {
    const known =
      id ?? repo.trails?.trails.find((listed) => listed.number === trail)?.id ?? repo.trailMemory.idOf(trail);
    return known ? { number: trail, id: known } : { number: trail };
  }

  /**
   * Reads one trail from entire.io: its changes, their merge gates and CI
   * runs, and its page on the web. The trail is kept for the views and for
   * the next panel that opens it.
   */
  async showTrail(repo: RepoContext, trail: TrailRef, signal?: AbortSignal): Promise<Result<TrailDetail>> {
    const cli = this.cli;
    if (!cli) return fail('cliMissing', 'The Entire CLI is not available.');
    if (!this.trailsEnabled) return fail('noAccess', TRAILS_OFF);
    if (!repo.entireRepo) {
      return fail('noAccess', 'Trails are available when the origin remote uses the entire:// scheme.');
    }
    const hosted = repo.entireRepo;
    const detail = await cli.showTrail(repo.root, trailProject(hosted), trail, signal);
    // An answer for an origin that has since changed belongs to another repository.
    if (JSON.stringify(repo.entireRepo) !== JSON.stringify(hosted)) return detail;
    if (detail.ok) {
      if (detail.value.url) repo.trailUrls.set(detail.value.number, detail.value.url);
      repo.trailMemory.keepDetail(detail.value);
    } else if (detail.failure.kind === 'notFound') {
      repo.trailMemory.forget(trail.number);
    }
    if (!detail.ok && detail.failure.kind !== 'aborted') {
      this.log.warn(`Trail ${trail.number}: ${detail.failure.message} ${detail.failure.detail ?? ''}`.trim());
    }
    return detail;
  }

  /**
   * The web page of a trail. It comes from the CLI: a trail's address is not
   * derived from its number here, because the CLI asks callers not to.
   */
  async trailUrl(repo: RepoContext, trail: number): Promise<string | undefined> {
    const known = repo.trailUrls.get(trail);
    if (known) return known;
    const detail = await this.showTrail(repo, this.trailRef(repo, trail));
    return detail.ok ? detail.value.url : undefined;
  }

  /**
   * Asks the CLI for pages until the list shows as many trails as its rows
   * allow, the CLI has no more, or one read's worth of pages has been asked
   * for. Reads of one list run one after another, because each continues
   * from the token the one before it returned.
   */
  private readMoreTrails(repo: RepoContext, list: TrailList): Promise<boolean> {
    // Nothing to read: say so without touching the view's progress bar.
    if (!list.nextPageToken || this.shownTrails(list).length >= repo.limit(list.list)) {
      return this.trailPageReads.get(list) ?? Promise.resolve(true);
    }
    const read = async (): Promise<boolean> => {
      const cli = this.cli;
      const entireRepo = repo.entireRepo;
      // The list was replaced, or its rows were restarted under another filter, while this waited.
      const name = list.list;
      const current = (): boolean => repo.trails === list && list.list === name;
      if (!current()) return true;
      if (!cli || !entireRepo) return false;
      let replaced = false;
      const okay = await readTrailPages(
        list,
        async (pageToken) => {
          const page = await cli.listTrails(
            repo.root,
            { project: trailProject(entireRepo), repo: trailRepo(entireRepo) },
            list.status,
            PAGE_SIZE,
            pageToken,
          );
          if (repo.trails !== list) {
            replaced = true;
            return undefined;
          }
          if (!page.ok) {
            this.log.warn(`${repo.name}: ${page.failure.message} ${page.failure.detail ?? ''}`.trim());
            return undefined;
          }
          return page.value;
        },
        () => !current() || this.shownTrails(list).length >= repo.limit(list.list),
        // Rows appear as each page arrives, which matters when a read takes several.
        { onPage: () => this.changed.fire() },
      );
      return okay || replaced;
    };
    const next = (this.trailPageReads.get(list) ?? Promise.resolve(true)).then(read, read);
    this.trailPageReads.set(list, next);
    return this.withViewProgress('entire.trails', next);
  }

  /**
   * Shows a view's progress bar while Entire is read for it. Each call to
   * the CLI takes seconds, and a filter on a trail phase can take several.
   */
  private withViewProgress<T>(viewId: string, work: Promise<T>): Promise<T> {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    // The bar is a courtesy. An editor that cannot show it still gets the trails.
    try {
      Promise.resolve(vscode.window.withProgress({ location: { viewId } }, () => settled)).catch(
        () => {},
      );
    } catch {
      // Nothing to do: the read goes on without the bar.
    }
    return work;
  }

  /**
   * Reads Entire's list of sessions for each repository that Entire hosts
   * and that has not been asked about yet. The Sessions view calls this when
   * it is shown, so nothing reads entire.io for it before then.
   */
  ensureRemoteSessions(): void {
    if (this.viewState !== 'ready') return;
    for (const repo of this.enabledRepos) {
      if (repo.entireRepo && !repo.remoteSessions) void this.loadRemoteSessions(repo);
    }
  }

  /** Starts Entire's list of a repository's sessions over from its first page. */
  loadRemoteSessions(repo: RepoContext): Promise<void> {
    return this.withViewProgress('entire.sessions', this.readFirstRemoteSessions(repo));
  }

  private async readFirstRemoteSessions(repo: RepoContext): Promise<void> {
    const cli = this.cli;
    if (!cli || !repo.enabled || !repo.entireRepo) return;
    const read = ++repo.remoteSessionReads;
    const list: RemoteSessionList = { sessions: new Map(), loading: true };
    // A refresh keeps the names on screen until the fresh ones arrive.
    const previous = repo.remoteSessions;
    if (!previous) {
      repo.remoteSessions = list;
      this.changed.fire();
    }
    const page = await cli.remoteSessions(repo.root, REMOTE_SESSIONS_PAGE);
    if (read !== repo.remoteSessionReads) return;
    list.loading = false;
    if (page.ok) {
      addRemoteSessions(list, page.value);
    } else {
      list.failure = page.failure;
      this.log.warn(`${repo.name}: ${page.failure.message} ${page.failure.detail ?? ''}`.trim());
    }
    if (!page.ok && previous && previous.sessions.size > 0) {
      // The names read before still hold. Only the reason for the failure is new.
      previous.failure = page.failure;
    } else {
      repo.remoteSessions = list;
    }
    this.changed.fire();
    // A list that had grown past its first page keeps its rows named.
    await this.readMoreRemoteSessions(repo);
  }

  /**
   * Asks Entire for pages until its list holds as many sessions as the
   * Sessions view shows rows, or Entire has no more. Entire lists the most
   * recent sessions first, and so does the view, so that many sessions name
   * every row on show that Entire knows.
   *
   * Reads of one list run one after another, because each continues from
   * the cursor the one before it returned.
   */
  private readMoreRemoteSessions(repo: RepoContext): Promise<boolean> {
    const list = repo.remoteSessions;
    if (!list) return Promise.resolve(true);
    const enough = (): boolean => !list.nextCursor || list.sessions.size >= repo.limit(LISTS.recentSessions);
    // Nothing to read: say so without touching the view's progress bar.
    if (enough()) return this.remoteSessionPageReads.get(list) ?? Promise.resolve(true);
    const read = async (): Promise<boolean> => {
      for (let pages = 0; pages < MAX_REMOTE_SESSION_PAGES_PER_READ; pages += 1) {
        // The list was replaced by a fresh read while this waited.
        if (repo.remoteSessions !== list || enough()) return true;
        const cli = this.cli;
        const cursor = list.nextCursor;
        if (!cli || !cursor) return false;
        const page = await cli.remoteSessions(repo.root, REMOTE_SESSIONS_PAGE, cursor);
        if (repo.remoteSessions !== list) return true;
        if (!page.ok) {
          this.log.warn(`${repo.name}: ${page.failure.message} ${page.failure.detail ?? ''}`.trim());
          return false;
        }
        addRemoteSessions(list, page.value, cursor);
        // Names appear as each page arrives.
        this.changed.fire();
      }
      return true;
    };
    const next = (this.remoteSessionPageReads.get(list) ?? Promise.resolve(true)).then(read, read);
    this.remoteSessionPageReads.set(list, next);
    return this.withViewProgress('entire.sessions', next);
  }

  /** Whether Entire lists more sessions of the repository than have been read. */
  moreSessionsOnEntire(repo: RepoContext): boolean {
    return repo.remoteSessions?.nextCursor !== undefined;
  }

  /**
   * What the Sessions view says above its rows, when Entire could not name
   * them for a reason the reader can do something about.
   */
  sessionsNotice(): string | undefined {
    const loggedOut = this.enabledRepos.some((repo) => repo.remoteSessions?.failure?.kind === 'notLoggedIn');
    return loggedOut
      ? 'You are not logged in to Entire, so sessions are named by their opening prompt. Run "entire login" in a terminal, then refresh.'
      : undefined;
  }

  /**
   * The checkpoints of a session, newest first. The clone knows the ones on
   * the checked-out branch. When Entire counts more than that, its list of
   * the session's checkpoints is read as well, once, and the two are shown
   * as one list.
   *
   * Entire sends that list with the session's transcript, which takes
   * seconds for a long session. So the checkpoints the clone knows are
   * returned at once, and the views are redrawn when Entire's arrive. With
   * `wait`, or for a session the clone knows no checkpoint of, the call
   * waits for Entire instead.
   */
  async sessionCheckpoints(
    repo: RepoContext,
    sessionId: string,
    options: { wait?: boolean; signal?: AbortSignal } = {},
  ): Promise<SessionCheckpoint[]> {
    const entry = this.sessionEntry(repo, sessionId);
    if (!entry) return [];
    const short = entry.listedCheckpoints !== undefined && entry.listedCheckpoints > entry.checkpoints.length;
    if (!short || entry.checkpointsFromEntire) return entry.checkpoints;
    const read = this.readRemoteCheckpoints(repo, sessionId, options.signal);
    if (!options.wait && entry.checkpoints.length > 0) return entry.checkpoints;
    await read;
    return this.sessionEntry(repo, sessionId)?.checkpoints ?? entry.checkpoints;
  }

  /**
   * Entire's list of a session's checkpoints, read once. The views are
   * redrawn when it arrives. A read that fails is tried again after a while.
   */
  private readRemoteCheckpoints(
    repo: RepoContext,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<RemoteCheckpoint[] | undefined> {
    const known = repo.remoteCheckpoints.get(sessionId);
    if (known && (known.failedAt === undefined || Date.now() - known.failedAt < REMOTE_CHECKPOINTS_RETRY_MS)) {
      return known.read;
    }
    const cli = this.cli;
    if (!cli || !repo.entireRepo) return Promise.resolve(undefined);
    const slot: RemoteCheckpointRead = {
      read: cli.remoteSessionCheckpoints(repo.root, sessionId, signal).then((result) => {
        if (repo.remoteCheckpoints.get(sessionId) !== slot) return undefined;
        if (!result.ok) {
          if (result.failure.kind === 'aborted') {
            // The panel that asked was closed. The next one to ask reads again.
            repo.remoteCheckpoints.delete(sessionId);
          } else {
            slot.failedAt = Date.now();
            this.log.warn(`Session ${sessionId}: ${result.failure.message} ${result.failure.detail ?? ''}`.trim());
          }
          return undefined;
        }
        slot.checkpoints = result.value;
        this.changed.fire();
        return result.value;
      }),
    };
    repo.remoteCheckpoints.set(sessionId, slot);
    return this.withViewProgress('entire.sessions', slot.read);
  }

  /** Publishes what the Trails view depends on, then redraws the views. */
  private trailsChanged(): void {
    this.syncTrailContext();
    this.changed.fire();
  }

  private syncTrailContext(): void {
    void vscode.commands.executeCommand('setContext', 'entire.hasTrails', this.trailRepos.length > 0);
    void vscode.commands.executeCommand('setContext', 'entire.trailsFilter', trailFilterKey(this.trailFilter));
    void vscode.commands.executeCommand('setContext', 'entire.trailsState', this.trailsState());
  }

  /**
   * Scans history until the index holds as many linked commits as the commit
   * list shows. Scans of one repository run one after another: each starts
   * where the index stops, so two at once would read the same stretch twice
   * and list its commits twice.
   */
  private scanForCommits(repo: RepoContext): Promise<boolean> {
    const scan = async (): Promise<boolean> => {
      const index = repo.index;
      const missing = index ? repo.limit(LISTS.commits) - index.commits.length : 0;
      if (!index || index.exhausted || missing <= 0) return true;
      return loadPage(index, (skip, count) => this.fetchWindow(repo, index.tipSha, skip, count), missing);
    };
    const next = (this.scans.get(repo) ?? Promise.resolve(true)).then(scan, scan);
    this.scans.set(repo, next);
    return next;
  }

  /**
   * Loads the full session list. The CLI prunes session state idle for more
   * than seven days while it lists, so this runs only when the Sessions view
   * is first shown and on a manual refresh.
   */
  async loadSessionRows(repo: RepoContext): Promise<void> {
    if (!this.cli || !repo.enabled) return;
    const rows = await this.cli.sessionList(repo.root);
    if (rows.ok) {
      repo.sessionRows = rows.value;
    } else {
      repo.sessionRows ??= [];
      this.log.warn(`${repo.name}: ${rows.failure.message} ${rows.failure.detail ?? ''}`.trim());
    }
    this.changed.fire();
  }

  /**
   * Checkpoint detail from the CLI, cached. A failure is not cached, so a
   * retry runs again, except "not found": the CLI spends two seconds asking
   * the remote before it says so, and the answer rarely changes within minutes.
   */
  detail(repo: RepoContext, checkpointId: string, signal?: AbortSignal): Promise<Result<CheckpointDetail>> {
    const cli = this.cli;
    if (!cli) return Promise.resolve(fail('cliMissing', 'The Entire CLI is not available.'));
    const cached = repo.details.get(checkpointId);
    if (cached && Date.now() - cached.at < DETAIL_TTL_MS) {
      // Refresh the entry's position so the least recently used one is evicted first.
      repo.details.delete(checkpointId);
      repo.details.set(checkpointId, cached);
      return cached.result;
    }
    const result = cli.explainCheckpoint(repo.root, checkpointId, signal).then((outcome) => {
      const missing = !outcome.ok && outcome.failure.kind === 'notFound';
      if (!outcome.ok) {
        if (!missing && repo.details.get(checkpointId)?.result === result) repo.details.delete(checkpointId);
        if (outcome.failure.kind !== 'aborted') {
          this.log.warn(`${checkpointId}: ${outcome.failure.message} ${outcome.failure.detail ?? ''}`.trim());
        }
      }
      // Rows for the checkpoint say whether it has data, so they are redrawn when that is learned.
      if (missing !== repo.withoutData.has(checkpointId) && (missing || outcome.ok)) {
        if (missing) repo.withoutData.add(checkpointId);
        else repo.withoutData.delete(checkpointId);
        this.changed.fire();
      }
      return outcome;
    });
    repo.details.delete(checkpointId);
    repo.details.set(checkpointId, { at: Date.now(), result });
    if (repo.details.size > DETAIL_CACHE_SIZE) {
      const oldest = repo.details.keys().next().value;
      if (oldest !== undefined) repo.details.delete(oldest);
    }
    return result;
  }

  /** Sessions for the Sessions view: running ones first, then the rest by recency. */
  sessions(repo: RepoContext): { active: SessionEntry[]; recent: SessionEntry[] } {
    const entries = new Map<string, SessionEntry>();
    const entry = (sessionId: string): SessionEntry => {
      let found = entries.get(sessionId);
      if (!found) {
        found = { sessionId, checkpoints: [] };
        entries.set(sessionId, found);
      }
      return found;
    };

    for (const indexed of repo.index?.sessions() ?? []) {
      const target = entry(indexed.sessionId);
      target.checkpoints = [...indexed.checkpoints];
      if (indexed.mayHaveEarlier) target.mayHaveEarlier = true;
      if (indexed.agent) target.agent = indexed.agent;
      if (indexed.lastDate) target.lastActive = indexed.lastDate;
      const title = indexed.checkpoints[0]?.message;
      if (title) target.title = title;
    }

    for (const row of repo.sessionRows ?? []) {
      const target = entry(row.sessionId);
      target.local = row;
      if (row.agent) target.agent = row.agent;
      if (row.model) target.model = row.model;
      if (row.status) target.status = row.status;
      if (row.lastPrompt) target.lastPrompt = row.lastPrompt;
      const lastActive = row.lastActive ?? row.endedAt ?? row.startedAt;
      if (lastActive && (!target.lastActive || Date.parse(lastActive) > Date.parse(target.lastActive))) {
        target.lastActive = lastActive;
      }
      if (row.lastCheckpointId && !target.checkpoints.some((cp) => cp.checkpointId === row.lastCheckpointId)) {
        target.checkpoints.push({ checkpointId: row.lastCheckpointId });
      }
    }

    for (const live of repo.status?.activeSessions ?? []) {
      if (!live.sessionId) continue;
      const target = entry(live.sessionId);
      target.status = live.status ?? 'active';
      if (live.agent) target.agent = live.agent;
      if (live.model) target.model = live.model;
      if (live.branch) target.branch = live.branch;
    }

    // Entire's list names its sessions, counts their checkpoints, and adds
    // the ones this clone has no data for, such as those of other branches.
    for (const listed of repo.remoteSessions?.sessions.values() ?? []) {
      const target = entry(listed.sessionId);
      if (listed.name) target.name = listed.name;
      if (listed.prompt && listed.prompt !== listed.name) target.opening = listed.prompt;
      if (listed.agent) target.agent ??= listed.agent;
      if (listed.model) target.model ??= listed.model;
      if (listed.checkpointCount !== undefined) target.listedCheckpoints = listed.checkpointCount;
      const lastActive = listed.lastActivityAt ?? listed.startedAt;
      if (lastActive && instant(lastActive) > instant(target.lastActive)) target.lastActive = lastActive;
    }
    for (const [sessionId, read] of repo.remoteCheckpoints) {
      const target = entries.get(sessionId);
      if (!target || !read.checkpoints) continue;
      const known = new Set(target.checkpoints.map((checkpoint) => checkpoint.checkpointId));
      for (const checkpoint of read.checkpoints) {
        if (known.has(checkpoint.checkpointId)) continue;
        target.checkpoints.push({
          checkpointId: checkpoint.checkpointId,
          ...(checkpoint.date ? { date: checkpoint.date } : {}),
          ...(checkpoint.message ? { message: checkpoint.message } : {}),
        });
      }
      target.checkpoints.sort((a, b) => instant(b.date) - instant(a.date));
      target.checkpointsFromEntire = true;
      // Entire lists the session from its start.
      delete target.mayHaveEarlier;
    }

    const byRecency = (a: SessionEntry, b: SessionEntry): number => instant(b.lastActive) - instant(a.lastActive);
    const all = [...entries.values()];
    for (const session of all) {
      const opening = repo.sessionNames.get(session.sessionId)?.name;
      if (!opening) continue;
      // The opening prompt names a session that Entire has not named.
      if (!session.name) session.name = opening;
      else if (session.name !== opening) session.opening ??= opening;
    }
    const isLive = (session: SessionEntry): boolean => session.status === 'active' || session.status === 'idle';
    return {
      active: all.filter(isLive).sort(byRecency),
      recent: all.filter((session) => !isLive(session)).sort(byRecency),
    };
  }

  /**
   * Reads, in the background, the opening prompt of each of these sessions
   * that has a checkpoint and no name yet. The Sessions view asks for the
   * rows it shows, and the names appear as they arrive.
   */
  nameSessions(repo: RepoContext, sessions: readonly SessionEntry[]): void {
    // Entire is about to name most of these. The rest are read once it has answered.
    if (repo.remoteSessions?.loading) return;
    for (const session of sessions) {
      if (repo.remoteSessions?.sessions.get(session.sessionId)?.name) continue;
      const count = session.checkpoints.length;
      const known = repo.sessionNames.get(session.sessionId);
      // A session with no name is tried again only once it has checkpoints that were not looked at.
      if (count === 0 || (known && (known.name !== null || known.checkpoints >= count))) continue;
      const key = `${repo.root}\0${session.sessionId}`;
      if (this.naming.has(key)) continue;
      this.naming.add(key);
      this.nameQueue.push(async () => {
        const name = await this.readSessionName(repo, session).catch(() => undefined);
        this.naming.delete(key);
        if (this.repoFor(repo.root) !== repo) return;
        // A panel may have named the session in the meantime. A name that was read stands.
        if (repo.sessionNames.get(session.sessionId)?.name) return;
        repo.sessionNames.set(session.sessionId, { name: name ?? null, checkpoints: count });
        if (name) this.namesChanged();
      });
    }
    this.runNameQueue();
  }

  /** Records the opening prompt of a session whose transcript a panel has read. */
  noteSessionName(repo: RepoContext, sessionId: string, name: string): void {
    if (repo.sessionNames.get(sessionId)?.name === name) return;
    repo.sessionNames.set(sessionId, { name, checkpoints: Number.MAX_SAFE_INTEGER });
    this.namesChanged();
  }

  /**
   * The opening prompt of a session, from the start of the transcript that
   * one of its checkpoints stores. A transcript that holds the session from
   * its start gives the same prompt whichever checkpoint stores it. The
   * oldest known checkpoint is read first, and then the newest, because an
   * old checkpoint can predate stored transcripts.
   *
   * An older transcript holds only its checkpoint's part. Its first prompt
   * is taken for the session's only when the checkpoint is known to be the
   * session's first.
   */
  private async readSessionName(repo: RepoContext, session: SessionEntry): Promise<string | undefined> {
    const ids = session.checkpoints.map((checkpoint) => checkpoint.checkpointId);
    const oldest = ids.at(-1);
    const tries = [...new Set([oldest, ids[0], ids[Math.floor(ids.length / 2)]])];
    let ofFirstCheckpoint: string | undefined;
    for (const checkpointId of tries) {
      if (!checkpointId) continue;
      const tree = await this.store.locate(repo.root, checkpointId);
      const prompt = tree ? await this.store.openingPrompt(repo.root, tree, session.sessionId) : undefined;
      if (!prompt) continue;
      if (prompt.fromSessionStart) return prompt.text;
      if (checkpointId === oldest && !session.mayHaveEarlier) ofFirstCheckpoint = prompt.text;
    }
    return ofFirstCheckpoint;
  }

  /** Runs the queued name reads two at a time, so that they do not hold up the git calls of a click. */
  private runNameQueue(): void {
    while (this.nameWorkers < 2 && this.nameQueue.length > 0) {
      const task = this.nameQueue.shift();
      if (!task) break;
      this.nameWorkers += 1;
      void task().finally(() => {
        this.nameWorkers -= 1;
        this.runNameQueue();
      });
    }
  }

  /** Redraws the views once for the names that arrive close together. */
  private namesChanged(): void {
    if (this.namesTimer) return;
    this.namesTimer = setTimeout(() => {
      this.namesTimer = undefined;
      this.changed.fire();
    }, 60);
  }

  sessionEntry(repo: RepoContext, sessionId: string): SessionEntry | undefined {
    const { active, recent } = this.sessions(repo);
    return [...active, ...recent].find((session) => session.sessionId === sessionId);
  }

  private replaceRepos(repos: RepoContext[]): void {
    for (const old of this.repos) {
      if (!repos.includes(old)) clearTimeout(old.enrichmentTimer);
    }
    this.repos = repos;
  }

  private setState(state: ViewState): void {
    this.viewState = state;
    void vscode.commands.executeCommand('setContext', 'entire.viewState', state);
    void vscode.commands.executeCommand(
      'setContext',
      'entire.hasWebRepo',
      this.repos.some((repo) => repo.entireRepo !== undefined),
    );
    this.syncTrailContext();
    this.changed.fire();
  }

  private async loadStatus(repo: RepoContext): Promise<void> {
    const [status, origin] = await Promise.all([this.cli?.status(repo.root), this.git.originUrl(repo.root)]);
    const hosted = parseEntireRemote(origin);
    if (JSON.stringify(hosted) !== JSON.stringify(repo.entireRepo)) {
      // The origin now names another repository, or none. Its trails and Entire's sessions are not this one's.
      repo.forgetTrails();
      repo.forgetRemoteSessions();
    }
    repo.originUrl = origin;
    repo.entireRepo = hosted;
    repo.lastRefresh = Date.now();
    if (status?.ok) {
      repo.status = status.value;
    } else if (status) {
      repo.status = { enabled: false, agents: [], activeSessions: [], error: status.failure.message };
      this.log.warn(`${repo.name}: ${status.failure.message} ${status.failure.detail ?? ''}`.trim());
    }
  }

  /** Returns true when the index was rebuilt. */
  private async loadGit(repo: RepoContext, options: { force: boolean }): Promise<boolean> {
    const [tip, branch] = await Promise.all([this.git.head(repo.root), this.git.branch(repo.root)]);
    repo.lastRefresh = Date.now();
    const branchChanged = branch !== repo.branch;
    repo.branch = branch;
    if (!tip) {
      const had = repo.index !== undefined;
      repo.index = undefined;
      repo.gitError = undefined;
      return had || branchChanged;
    }
    if (!options.force && repo.index?.tipSha === tip) return branchChanged;

    const generation = ++repo.generation;
    const index = new CheckpointIndex(tip);
    // Scan for as many rows as the commit list shows, so a rebuilt index does
    // not collapse a list the user has already extended.
    const okay = await loadPage(
      index,
      (skip, count) => this.fetchWindow(repo, tip, skip, count),
      repo.limit(LISTS.commits),
    );
    if (generation !== repo.generation) return false;
    // Keep the previous rows until fresh ones arrive, so rows do not lose
    // their agent for a moment on every commit.
    index.setRows(repo.index?.allRows() ?? []);
    repo.index = index;
    repo.autoLoadPaused.delete(LISTS.commits);
    repo.gitError = okay ? undefined : 'Entire could not read the commit history.';
    return true;
  }

  private async fetchWindow(repo: RepoContext, tip: string, skip: number, count: number) {
    const window = await this.git.logWindow(repo.root, tip, skip, count);
    if (!window.ok) {
      this.log.warn(`${repo.name}: ${window.failure.message} ${window.failure.detail ?? ''}`.trim());
      return undefined;
    }
    return window.value;
  }

  /**
   * Asks the CLI for checkpoint rows in the background. The CLI may fetch
   * checkpoint refs from the remote while it lists, which can take tens of
   * seconds, so the views never wait for this.
   */
  private scheduleEnrichment(repo: RepoContext, options: { immediate: boolean }): void {
    clearTimeout(repo.enrichmentTimer);
    const sinceLast = Date.now() - repo.lastEnrichment;
    const delay = options.immediate ? 0 : Math.max(ENRICHMENT_DEBOUNCE_MS, ENRICHMENT_MIN_INTERVAL_MS - sinceLast);
    repo.enrichmentTimer = setTimeout(() => void this.enrich(repo), delay);
  }

  private async enrich(repo: RepoContext): Promise<void> {
    const cli = this.cli;
    const generation = repo.generation;
    if (!cli || !repo.index) return;
    repo.lastEnrichment = Date.now();
    const rows = await cli.listCheckpoints(repo.root, LIST_LIMIT);
    if (generation !== repo.generation || !repo.index) return;
    if (!rows.ok) {
      this.log.warn(`${repo.name}: ${rows.failure.message} ${rows.failure.detail ?? ''}`.trim());
      return;
    }
    repo.index.setRows(rows.value);
    this.changed.fire();
  }
}
