import * as vscode from 'vscode';
import { PAGE_SIZE } from '../core/checkpointIndex';
import type { Failure } from '../core/errors';
import { headline, joinParts, relativeTime, truncate } from '../core/format';
import type { CheckpointRow, TrailSummary } from '../core/schemas';
import {
  hasLocalTerms,
  matchesTerms,
  SEARCH_SCOPES,
  searchTerms,
  trailMatches,
  type SearchHit,
  type SearchScope,
  type SearchTerms,
} from '../core/search';
import type { CommitRecord } from '../core/trailers';
import { addTrailPage, readTrailPages, trailProject, trailRepo, type TrailPages } from '../core/trails';
import type { Actions } from './actions';
import type { PanelManager } from './panel/panelManager';
import type { RepoContext, RepoManager, SessionEntry } from './repoManager';

/** What a search result opens. */
export type SearchTarget =
  | { kind: 'checkpoint'; root: string; checkpointId: string; commitSha?: string; sessionId?: string }
  /** A commit that Entire's search found with no checkpoint on it. */
  | { kind: 'commit'; root: string; sha: string }
  | { kind: 'session'; root: string; sessionId: string; checkpointId?: string }
  | { kind: 'trail'; root: string; number: number; id?: string };

export interface SearchItem extends vscode.QuickPickItem {
  target?: SearchTarget;
  /** An item that is not a result: it offers a login, or the log of a search that failed. */
  hint?: 'login' | 'log' | 'none';
}

type Groups = Record<SearchScope, SearchItem[]>;

/** Results Entire's search returns for one repository. */
const HOSTED_LIMIT = 25;
/** Results of one kind that the extension matches itself, for one repository. */
const LOCAL_LIMIT = 30;
/** Rows of each kind listed before anything is typed. */
const RECENT_LIMIT = 8;
/** Entire's search runs once the query has this many characters. */
const HOSTED_MIN_LENGTH = 2;
const DEBOUNCE_MS = 300;
const DETAIL_CHARS = 120;
/** Pages of trails a search reads after the first. */
const MAX_TRAIL_PAGES = 3;

const GROUP_LABELS: Record<SearchScope, string> = {
  checkpoints: 'Checkpoints',
  sessions: 'Sessions',
  trails: 'Trails',
};

const TITLES: Record<SearchScope | 'all', string> = {
  all: 'Search Entire',
  checkpoints: 'Search Checkpoints',
  sessions: 'Search Sessions',
  trails: 'Search Trails',
};

const PLACEHOLDERS: Record<SearchScope | 'all', string> = {
  all: 'Search checkpoints, sessions, and trails',
  checkpoints: 'Search checkpoints by commit, prompt, or checkpoint ID',
  sessions: 'Search sessions by name, prompt, agent, or session ID',
  trails: 'Search trails by number, title, description, or branch',
};

const NEW_TAB: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('split-horizontal'), tooltip: 'Open in New Tab' };
const ON_WEB: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Open on entire.com' };

function emptyGroups(): Groups {
  return { checkpoints: [], sessions: [], trails: [] };
}

function targetKey(target: SearchTarget): string {
  switch (target.kind) {
    case 'checkpoint':
      return `checkpoint\x00${target.root}\x00${target.checkpointId}`;
    case 'commit':
      return `commit\x00${target.root}\x00${target.sha}`;
    case 'session':
      return `session\x00${target.root}\x00${target.sessionId}`;
    case 'trail':
      return `trail\x00${target.root}\x00${target.number}`;
  }
}

function hostedSearchEnabled(): boolean {
  return vscode.workspace.getConfiguration('entire').get<boolean>('search.hosted', true);
}

/**
 * Finds what a query matches, for one search: the rows the extension has
 * already read, Entire's search for the checkpoints and sessions of each
 * repository on Entire, and the trails, which are read once per search.
 */
export class SearchEngine {
  /** The trails read for this search, by repository. Set once the read is done. */
  private trails?: Map<string, TrailSummary[]>;
  private trailRead?: Promise<void>;
  private trailFailures: Failure[] = [];

  constructor(
    private readonly manager: RepoManager,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  scopes(scope?: SearchScope): readonly SearchScope[] {
    return scope ? [scope] : SEARCH_SCOPES;
  }

  /** Whether the search includes trails, and there are any to read. */
  hasTrails(scope?: SearchScope): boolean {
    return this.scopes(scope).includes('trails') && this.manager.trailRepos.length > 0;
  }

  /** The rows listed before anything is typed: the newest of each kind. */
  recent(scope?: SearchScope): Groups {
    const groups = emptyGroups();
    const scopes = this.scopes(scope);
    for (const repo of this.manager.enabledRepos) {
      if (scopes.includes('checkpoints')) {
        groups.checkpoints.push(...(repo.index?.commits ?? []).slice(0, RECENT_LIMIT).flatMap((commit) => this.commitItems(repo, commit)));
      }
      if (scopes.includes('sessions')) {
        const { active, recent } = this.manager.sessions(repo);
        groups.sessions.push(...[...active, ...recent].slice(0, RECENT_LIMIT).map((session) => this.sessionItem(repo, session)));
      }
    }
    if (scopes.includes('trails')) {
      for (const repo of this.manager.trailRepos) {
        groups.trails.push(...this.knownTrails(repo).slice(0, RECENT_LIMIT).map((trail) => this.trailItem(repo, trail)));
      }
    }
    return groups;
  }

  /** What the query matches among the rows already read. Runs no command. */
  local(query: string, scope?: SearchScope): Groups {
    const groups = emptyGroups();
    const terms = searchTerms(query);
    if (!hasLocalTerms(terms)) return groups;
    const scopes = this.scopes(scope);
    for (const repo of this.manager.enabledRepos) {
      if (scopes.includes('checkpoints')) groups.checkpoints.push(...this.localCheckpoints(repo, terms));
      if (scopes.includes('sessions')) groups.sessions.push(...this.localSessions(repo, terms));
    }
    if (scopes.includes('trails')) {
      for (const repo of this.manager.trailRepos) {
        groups.trails.push(
          ...this.knownTrails(repo)
            .filter((trail) => trailMatches(terms, trail))
            .slice(0, LOCAL_LIMIT)
            .map((trail) => this.trailItem(repo, trail)),
        );
      }
    }
    return groups;
  }

  /**
   * Asks Entire's search for the checkpoints and sessions of each repository
   * that Entire hosts and has Entire enabled. Returns the results by kind,
   * best first, and an item that says why a search failed.
   */
  async hosted(query: string, scope: SearchScope | undefined, signal?: AbortSignal): Promise<{ groups: Groups; hints: SearchItem[] }> {
    const groups = emptyGroups();
    const scopes: readonly SearchScope[] = this.scopes(scope).filter((kind) => kind !== 'trails');
    const cli = this.manager.cli;
    const repos = this.manager.enabledRepos.filter((repo) => repo.entireRepo !== undefined);
    if (!cli || scopes.length === 0 || repos.length === 0 || query.trim().length < HOSTED_MIN_LENGTH || !hostedSearchEnabled()) {
      return { groups, hints: [] };
    }
    const failures: Failure[] = [];
    await Promise.all(
      repos.map(async (repo) => {
        const page = await cli.search(repo.root, query, HOSTED_LIMIT, signal);
        if (!page.ok) {
          if (page.failure.kind === 'aborted') return;
          failures.push(page.failure);
          if (page.failure.kind !== 'notLoggedIn') {
            this.log.warn(`${repo.name}: ${page.failure.message} ${page.failure.detail ?? ''}`.trim());
          }
          return;
        }
        for (const hit of page.value.hits) {
          const item = this.hitItem(repo, hit);
          if (item && scopes.includes(item.group)) groups[item.group].push(item.item);
        }
      }),
    );
    return { groups, hints: this.hints(failures) };
  }

  /** Reads the trails of each repository on Entire, once for this search, then matches them. */
  async searchTrails(query: string, scope?: SearchScope): Promise<{ items: SearchItem[]; hints: SearchItem[] }> {
    if (!this.hasTrails(scope)) return { items: [], hints: [] };
    await this.readTrails();
    const terms = searchTerms(query);
    const items = this.manager.trailRepos.flatMap((repo) =>
      this.knownTrails(repo)
        .filter((trail) => trailMatches(terms, trail))
        .slice(0, LOCAL_LIMIT)
        .map((trail) => this.trailItem(repo, trail)),
    );
    return { items, hints: this.hints(this.trailFailures) };
  }

  /**
   * Reads every trail of each repository, open and closed, up to four pages
   * of 50. The Trails view reads by status and keeps what it shows, so the
   * search reads its own list and adds the view's to it.
   */
  readTrails(): Promise<void> {
    this.trailRead ??= (async () => {
      const cli = this.manager.cli;
      const trails = new Map<string, TrailSummary[]>();
      const failures: Failure[] = [];
      await Promise.all(
        this.manager.trailRepos.map(async (repo) => {
          const hosted = repo.entireRepo;
          if (!cli || !hosted) return;
          const scope = { project: trailProject(hosted), repo: trailRepo(hosted) };
          const list: TrailPages = { trails: [] };
          const first = await cli.listTrails(repo.root, scope, 'all', PAGE_SIZE);
          if (!first.ok) {
            failures.push(first.failure);
            if (first.failure.kind !== 'notLoggedIn') {
              this.log.warn(`${repo.name}: ${first.failure.message} ${first.failure.detail ?? ''}`.trim());
            }
          } else {
            addTrailPage(list, first.value);
            await readTrailPages(
              list,
              async (pageToken) => {
                const page = await cli.listTrails(repo.root, scope, 'all', PAGE_SIZE, pageToken);
                return page.ok ? page.value : undefined;
              },
              () => false,
              { maxPages: MAX_TRAIL_PAGES },
            );
          }
          trails.set(repo.root, list.trails);
        }),
      );
      this.trails = trails;
      this.trailFailures = failures;
    })();
    return this.trailRead;
  }

  /** Everything the query matches, once every source has answered. */
  async collect(query: string, scope?: SearchScope, signal?: AbortSignal): Promise<SearchItem[]> {
    if (query.trim() === '') {
      if (this.hasTrails(scope)) await this.readTrails();
      return this.compose(scope, this.recent(scope));
    }
    const [hosted, trails] = await Promise.all([this.hosted(query, scope, signal), this.searchTrails(query, scope)]);
    const local = this.local(query, scope);
    const groups = emptyGroups();
    for (const kind of SEARCH_SCOPES) {
      groups[kind] = mergeItems(hosted.groups[kind], local[kind], kind === 'trails' ? trails.items : []);
    }
    return this.compose(scope, groups, [...hosted.hints, ...trails.hints]);
  }

  /** The items of the picker: each kind under its heading, then the hints. */
  compose(scope: SearchScope | undefined, groups: Groups, hints: readonly SearchItem[] = []): SearchItem[] {
    const items: SearchItem[] = [];
    for (const kind of this.scopes(scope)) {
      const group = groups[kind];
      if (group.length === 0) continue;
      if (!scope) items.push({ label: GROUP_LABELS[kind], kind: vscode.QuickPickItemKind.Separator });
      items.push(...group);
    }
    return [...items, ...dedupeHints(hints)];
  }

  /** The trails known for a repository: the ones this search read, and the ones the Trails view has. */
  private knownTrails(repo: RepoContext): TrailSummary[] {
    const read = this.trails?.get(repo.root) ?? [];
    const known = new Set(read.map((trail) => trail.number));
    return [...read, ...(repo.trails?.trails ?? []).filter((trail) => !known.has(trail.number))];
  }

  private localCheckpoints(repo: RepoContext, terms: SearchTerms): SearchItem[] {
    const index = repo.index;
    if (!index) return [];
    const items: SearchItem[] = [];
    for (const commit of index.commits) {
      const rows = commit.checkpointIds.map((id) => index.row(id));
      const fields = [
        commit.subject,
        commit.sha,
        commit.author,
        ...commit.checkpointIds,
        ...rows.flatMap((row) => [row?.agent, row?.message, ...(row?.sessionIds ?? [])]),
      ];
      if (matchesTerms(terms, fields, repo.branch)) items.push(...this.commitItems(repo, commit));
      if (items.length >= LOCAL_LIMIT) return items.slice(0, LOCAL_LIMIT);
    }
    // Checkpoints the CLI lists that no commit read so far carries: imported, or on another branch.
    for (const row of index.unlinkedRows()) {
      if (matchesTerms(terms, [row.message, row.checkpointId, row.agent, ...row.sessionIds])) items.push(this.rowItem(repo, row));
      if (items.length >= LOCAL_LIMIT) break;
    }
    return items.slice(0, LOCAL_LIMIT);
  }

  private localSessions(repo: RepoContext, terms: SearchTerms): SearchItem[] {
    const { active, recent } = this.manager.sessions(repo);
    return [...active, ...recent]
      .filter((session) =>
        matchesTerms(
          terms,
          [session.name, session.title, session.opening, session.lastPrompt, session.sessionId, session.agent, session.model, session.branch],
          session.branch,
        ),
      )
      .slice(0, LOCAL_LIMIT)
      .map((session) => this.sessionItem(repo, session));
  }

  private where(repo: RepoContext): string | undefined {
    return this.manager.repos.length > 1 ? repo.name : undefined;
  }

  private buttons(repo: RepoContext, target: SearchTarget): vscode.QuickInputButton[] {
    const buttons: vscode.QuickInputButton[] = [];
    if (target.kind !== 'commit') buttons.push(NEW_TAB);
    const web =
      target.kind === 'trail' ||
      target.kind === 'session' ||
      target.kind === 'commit' ||
      (target.kind === 'checkpoint' && (target.commitSha !== undefined || target.sessionId !== undefined));
    if (repo.entireRepo && web) buttons.push(ON_WEB);
    return buttons;
  }

  private item(repo: RepoContext, icon: string, label: string, description: string, target: SearchTarget, detail?: string): SearchItem {
    return {
      label,
      iconPath: new vscode.ThemeIcon(icon),
      description,
      ...(detail ? { detail } : {}),
      // The picker's own matching looks at labels only. These results were matched here, on more than the label.
      alwaysShow: true,
      target,
      buttons: this.buttons(repo, target),
    };
  }

  private commitItems(repo: RepoContext, commit: CommitRecord): SearchItem[] {
    const ids = commit.checkpointIds;
    return ids.map((checkpointId, at) =>
      this.item(
        repo,
        'git-commit',
        headline(commit.subject) || commit.shortSha,
        joinParts(
          'Checkpoint',
          commit.shortSha,
          ids.length > 1 ? `${at + 1} of ${ids.length}` : undefined,
          repo.index?.row(checkpointId)?.agent,
          relativeTime(commit.authorTime * 1000),
          this.where(repo),
        ),
        { kind: 'checkpoint', root: repo.root, checkpointId, commitSha: commit.sha },
      ),
    );
  }

  private rowItem(repo: RepoContext, row: CheckpointRow): SearchItem {
    return this.item(
      repo,
      'git-commit',
      headline(row.message) || `Checkpoint ${row.checkpointId}`,
      joinParts('Checkpoint', row.agent, relativeTime(row.date), this.where(repo)),
      { kind: 'checkpoint', root: repo.root, checkpointId: row.checkpointId, ...(row.sessionId ? { sessionId: row.sessionId } : {}) },
    );
  }

  private sessionItem(repo: RepoContext, session: SessionEntry): SearchItem {
    const live = session.status === 'active' || session.status === 'idle';
    return this.item(
      repo,
      'comment-discussion',
      headline(session.name ?? session.title ?? session.opening ?? session.lastPrompt) || `Session ${session.sessionId.slice(0, 8)}`,
      joinParts('Session', live ? 'running' : undefined, session.agent, session.branch, relativeTime(session.lastActive), this.where(repo)),
      { kind: 'session', root: repo.root, sessionId: session.sessionId, ...(session.checkpoints[0] ? { checkpointId: session.checkpoints[0].checkpointId } : {}) },
    );
  }

  private trailItem(repo: RepoContext, trail: TrailSummary): SearchItem {
    const branch = trail.changes.find((change) => change.branch)?.branch;
    return this.item(
      repo,
      trail.status === 'closed' ? 'git-pull-request-closed' : 'git-pull-request',
      headline(trail.title) || `Trail ${trail.number}`,
      joinParts(`Trail #${trail.number}`, trail.phase ?? trail.status, branch, relativeTime(trail.lastActivityAt), this.where(repo)),
      { kind: 'trail', root: repo.root, number: trail.number, ...(trail.id ? { id: trail.id } : {}) },
    );
  }

  /** An item for one of Entire's results, under the kind it belongs to. */
  private hitItem(repo: RepoContext, hit: SearchHit): { group: SearchScope; item: SearchItem } | undefined {
    const detail = (text?: string): string | undefined => (text ? truncate(text, DETAIL_CHARS) : undefined);
    switch (hit.kind) {
      case 'commit': {
        const [checkpointId] = hit.checkpointIds;
        const description = joinParts(checkpointId ? 'Checkpoint' : 'Commit', hit.sha.slice(0, 7), hit.branch, hit.author, relativeTime(hit.createdAt), this.where(repo));
        const target: SearchTarget = checkpointId
          ? { kind: 'checkpoint', root: repo.root, checkpointId, commitSha: hit.sha }
          : { kind: 'commit', root: repo.root, sha: hit.sha };
        return { group: 'checkpoints', item: this.item(repo, 'git-commit', headline(hit.subject) || hit.sha.slice(0, 7), description, target) };
      }
      case 'session':
        return {
          group: 'sessions',
          item: this.item(
            repo,
            'comment-discussion',
            headline(hit.name ?? hit.prompt) || `Session ${hit.sessionId.slice(0, 8)}`,
            joinParts('Session', hit.agent, hit.branch, relativeTime(hit.createdAt), this.where(repo)),
            { kind: 'session', root: repo.root, sessionId: hit.sessionId, ...(hit.checkpointId ? { checkpointId: hit.checkpointId } : {}) },
            detail(hit.snippet),
          ),
        };
      case 'checkpoint':
        return {
          group: 'checkpoints',
          item: this.item(
            repo,
            'git-commit',
            headline(hit.title) || `Checkpoint ${hit.checkpointId}`,
            joinParts('Checkpoint', hit.agent, hit.branch, relativeTime(hit.createdAt), this.where(repo)),
            {
              kind: 'checkpoint',
              root: repo.root,
              checkpointId: hit.checkpointId,
              ...(hit.commitSha ? { commitSha: hit.commitSha } : {}),
              ...(hit.sessionId ? { sessionId: hit.sessionId } : {}),
            },
            detail(hit.snippet),
          ),
        };
    }
  }

  /** Items that say why Entire could not be searched. One for each reason. */
  private hints(failures: readonly Failure[]): SearchItem[] {
    const hints: SearchItem[] = [];
    if (failures.some((failure) => failure.kind === 'notLoggedIn')) {
      hints.push({
        label: 'Log in to Entire to search sessions and trails on Entire',
        iconPath: new vscode.ThemeIcon('account'),
        description: 'Runs entire login in a terminal',
        alwaysShow: true,
        hint: 'login',
      });
    }
    if (failures.some((failure) => failure.kind === 'noAccess')) {
      hints.push({
        label: 'Entire does not know this repository, or your login cannot see it',
        iconPath: new vscode.ThemeIcon('info'),
        alwaysShow: true,
        hint: 'none',
      });
    }
    if (failures.some((failure) => failure.kind !== 'notLoggedIn' && failure.kind !== 'noAccess')) {
      hints.push({
        label: 'Entire could not be searched',
        iconPath: new vscode.ThemeIcon('warning'),
        description: 'Show the log',
        alwaysShow: true,
        hint: 'log',
      });
    }
    return hints;
  }
}

/** Joins lists of results, keeping the first of any two that open the same thing. */
function mergeItems(...lists: readonly SearchItem[][]): SearchItem[] {
  const seen = new Set<string>();
  const merged: SearchItem[] = [];
  for (const list of lists) {
    for (const item of list) {
      const key = item.target ? targetKey(item.target) : undefined;
      if (key !== undefined) {
        if (seen.has(key)) continue;
        seen.add(key);
      }
      merged.push(item);
    }
  }
  return merged;
}

function dedupeHints(hints: readonly SearchItem[]): SearchItem[] {
  const seen = new Set<string>();
  return hints.filter((hint) => {
    const key = hint.hint ?? hint.label;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The Search command: a picker that searches as you type, and opens what you
 * pick in the detail panel or the trail panel.
 *
 * The rows the extension has read are matched at once. Entire's search runs
 * after a pause in typing, and the trails are read once per search. The
 * picker's own sorting puts results whose title holds the query first while
 * a query is typed, and hides the headings, so each result names its kind.
 */
export class SearchPicker {
  constructor(
    private readonly manager: RepoManager,
    private readonly panels: PanelManager,
    private readonly actions: Actions,
    private readonly log: vscode.LogOutputChannel,
  ) {}

  /** A fresh search, for the extension-host tests. */
  engine(): SearchEngine {
    return new SearchEngine(this.manager, this.log);
  }

  show(scope?: SearchScope): void {
    const engine = this.engine();
    const picker = vscode.window.createQuickPick<SearchItem>();
    picker.title = TITLES[scope ?? 'all'];
    picker.placeholder = PLACEHOLDERS[scope ?? 'all'];
    picker.items = engine.compose(scope, engine.recent(scope));

    let controller: AbortController | undefined;
    let timer: NodeJS.Timeout | undefined;
    let closed = false;

    const showRecent = (): void => {
      picker.items = engine.compose(scope, engine.recent(scope));
    };
    const update = (value: string): void => {
      controller?.abort();
      clearTimeout(timer);
      const query = value.trim();
      if (query === '') {
        controller = undefined;
        picker.busy = false;
        showRecent();
        return;
      }
      picker.items = engine.compose(scope, engine.local(query, scope));
      const current = new AbortController();
      controller = current;
      timer = setTimeout(() => {
        picker.busy = true;
        void engine.collect(query, scope, current.signal).then((items) => {
          if (closed || current.signal.aborted) return;
          picker.items = items;
          picker.busy = false;
          controller = undefined;
        });
      }, DEBOUNCE_MS);
    };

    // The trails are read once, at the start, when the search covers them.
    if (engine.hasTrails(scope)) {
      picker.busy = true;
      void engine.readTrails().then(() => {
        if (closed) return;
        if (!controller) picker.busy = false;
        if (picker.value.trim() === '') showRecent();
        else update(picker.value);
      });
    }

    picker.onDidChangeValue(update);
    picker.onDidAccept(() => {
      const item = picker.selectedItems[0] ?? picker.activeItems[0];
      if (!item) return;
      picker.hide();
      void this.accept(item, { newTab: false });
    });
    picker.onDidTriggerItemButton(({ item, button }) => {
      picker.hide();
      if (button === ON_WEB) void this.openOnWeb(item);
      else void this.accept(item, { newTab: true });
    });
    picker.onDidHide(() => {
      closed = true;
      controller?.abort();
      clearTimeout(timer);
      picker.dispose();
    });
    picker.show();
  }

  /** Opens what a result stands for, or does what a hint offers. */
  async accept(item: SearchItem, options: { newTab: boolean }): Promise<void> {
    if (item.hint === 'login') {
      await vscode.commands.executeCommand('entire.runSetupStep', null, 'login');
      return;
    }
    if (item.hint === 'log') {
      this.log.show();
      return;
    }
    const target = item.target;
    if (!target) return;
    const repo = this.manager.repoFor(target.root);
    if (!repo) return;
    switch (target.kind) {
      case 'checkpoint':
        this.panels.open(
          {
            repoRoot: repo.root,
            mode: 'checkpoint',
            checkpointId: target.checkpointId,
            ...(target.commitSha ? { commitSha: target.commitSha } : {}),
            ...(target.sessionId ? { sessionId: target.sessionId } : {}),
          },
          { newTab: options.newTab },
        );
        return;
      case 'commit':
        // A commit that is not in the clone has no diff to show here.
        if (await this.manager.git.commit(repo.root, target.sha)) await this.actions.showCommitDiff(repo, target.sha);
        else await this.actions.openCommitOnWeb(repo, target.sha);
        return;
      case 'session': {
        const { active, recent } = this.manager.sessions(repo);
        const known = [...active, ...recent].some((session) => session.sessionId === target.sessionId);
        if (known) {
          this.panels.open({ repoRoot: repo.root, mode: 'session', sessionId: target.sessionId }, { newTab: options.newTab });
        } else if (target.checkpointId) {
          // The session panel knows only the sessions the views list. A checkpoint of the session opens it from there.
          this.panels.open(
            { repoRoot: repo.root, mode: 'checkpoint', checkpointId: target.checkpointId, sessionId: target.sessionId },
            { newTab: options.newTab },
          );
        } else {
          await this.actions.openSessionOnWeb(repo, target.sessionId);
        }
        return;
      }
      case 'trail':
        this.panels.openTrail(
          { repoRoot: repo.root, mode: 'trail', trail: target.number, ...(target.id ? { id: target.id } : {}) },
          { newTab: options.newTab },
        );
        return;
    }
  }

  /** Opens a result's page on entire.com. */
  async openOnWeb(item: SearchItem): Promise<void> {
    const target = item.target;
    const repo = target ? this.manager.repoFor(target.root) : undefined;
    if (!target || !repo) return;
    switch (target.kind) {
      case 'checkpoint':
        if (target.commitSha) await this.actions.openCommitOnWeb(repo, target.commitSha);
        else if (target.sessionId) await this.actions.openSessionOnWeb(repo, target.sessionId);
        return;
      case 'commit':
        await this.actions.openCommitOnWeb(repo, target.sha);
        return;
      case 'session':
        await this.actions.openSessionOnWeb(repo, target.sessionId);
        return;
      case 'trail':
        await this.actions.openTrailOnWeb(repo, target.number);
        return;
    }
  }
}
