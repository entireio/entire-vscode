import * as vscode from 'vscode';
import type { CheckpointRow } from '../../core/schemas';
import type { DetailTarget } from '../../shared/protocol';
import { LISTS, type RepoContext, type RepoManager, type SessionEntry } from '../repoManager';
import { MAX_PAGES_TO_REACH_A_ROW, slotNodes } from './checkpointsTree';
import { nodeId, paged, tooltip, treeItem, type Node } from './nodes';
import { RowRegistry } from './rowRegistry';

/**
 * Agent sessions for the repository: the ones running now, then the rest.
 *
 * A session appears here when local session state exists for it or when a
 * checkpoint references it, so a fresh clone still lists the sessions behind
 * its commits. For a repository that Entire hosts, the sessions Entire lists
 * appear too, under the names entire.com shows, each with its checkpoints.
 */
export class SessionsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  /** One object for each row, so that `TreeView.reveal` finds the row it is given. */
  private readonly rows = new RowRegistry();

  constructor(private readonly manager: RepoManager) {
    this.subscription = manager.onDidChange(() => this.changed.fire(undefined));
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return treeItem(node);
  }

  /** Called when a row is hovered, to fill in the tooltip that `getTreeItem` leaves out. */
  resolveTreeItem(item: vscode.TreeItem, node: Node): vscode.TreeItem {
    const text = tooltip(node);
    if (text) item.tooltip = text;
    return item;
  }

  getParent(node: Node): Node | undefined {
    return this.rows.parentOf(node);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) this.rows.keepOnly(this.manager.repos.map((repo) => repo.root));
    return this.rows.adopt(await this.listChildren(node), node);
  }

  /**
   * The row to select while a detail tab shows `target`: the session's row
   * for a tab opened on the session, and otherwise the checkpoint's row under
   * the session. With `slot`, it is the row of the session under that, for a
   * checkpoint that holds several sessions.
   *
   * A row beyond the end of its list is brought onto it: the list grows by
   * as many pages as it takes. When the session lists no such checkpoint, the
   * session's row stands in. Undefined when the view does not list the
   * session.
   */
  async find(target: DetailTarget, options: { slot?: boolean } = {}): Promise<Node | undefined> {
    const repo = this.manager.repoFor(target.repoRoot);
    const sessionId = target.sessionId;
    if (!repo?.enabled || !sessionId || this.manager.viewState !== 'ready') return undefined;

    const place = (): { list: string; at: number } | undefined => {
      const { active, recent } = this.manager.sessions(repo);
      const among = (sessions: SessionEntry[]): number => sessions.findIndex((session) => session.sessionId === sessionId);
      if (among(active) >= 0) return { list: LISTS.activeSessions, at: among(active) };
      return among(recent) >= 0 ? { list: LISTS.recentSessions, at: among(recent) } : undefined;
    };
    for (let pages = 0; pages < MAX_PAGES_TO_REACH_A_ROW; pages += 1) {
      const found = place();
      if (!found) return undefined;
      if (found.at < repo.limit(found.list)) break;
      await this.manager.showMore(repo, found.list);
    }
    const roots = await this.getChildren();
    const own = roots.find((node) => node.kind === 'repo' && node.repo === repo);
    const top = own ? await this.getChildren(own) : roots;
    const listed = (
      await Promise.all(top.map((node) => (node.kind === 'sessionGroup' ? this.getChildren(node) : [node])))
    ).flat();
    const session = listed.find((node) => node.kind === 'session' && node.session.sessionId === sessionId);
    if (!session || target.mode === 'session' || !target.checkpointId) return session;

    const checkpointId = target.checkpointId;
    const list = LISTS.sessionCheckpoints(sessionId);
    const at = (): number =>
      this.manager.sessionEntry(repo, sessionId)?.checkpoints.findIndex((known) => known.checkpointId === checkpointId) ?? -1;
    for (let pages = 0; pages < MAX_PAGES_TO_REACH_A_ROW && at() >= repo.limit(list); pages += 1) {
      await this.manager.showMore(repo, list);
    }
    const row = (await this.getChildren(session)).find(
      (node) => node.kind === 'checkpoint' && node.checkpointId === checkpointId,
    );
    if (!row) return session;
    if (!options.slot) return row;
    const slot = (await this.getChildren(row)).find(
      (node) => node.kind === 'slot' && node.session.sessionId === sessionId,
    );
    return slot ?? row;
  }

  private async listChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      if (this.manager.viewState !== 'ready') return [];
      const repos = this.manager.enabledRepos;
      if (repos.length === 1 && repos[0]) return this.repoChildren(repos[0]);
      return repos.map((repo): Node => ({ kind: 'repo', repo }));
    }

    switch (node.kind) {
      case 'repo':
        return this.repoChildren(node.repo);
      case 'sessionGroup': {
        const { active, recent } = this.manager.sessions(node.repo);
        return node.group === 'active'
          ? this.sessionNodes(node.repo, active, LISTS.activeSessions)
          : this.sessionNodes(node.repo, recent, LISTS.recentSessions);
      }
      case 'session': {
        const { repo, session } = node;
        const parentId = nodeId(node);
        const list = LISTS.sessionCheckpoints(session.sessionId);
        // Entire is asked for the session's checkpoints when it counts more than the clone knows.
        const checkpoints = await this.manager.sessionCheckpoints(repo, session.sessionId);
        const fromEntire = this.manager.sessionEntry(repo, session.sessionId)?.checkpointsFromEntire === true;
        const ordinals = new Map(checkpoints.map((checkpoint, at) => [checkpoint.checkpointId, checkpoints.length - at]));
        return paged(repo, list, 'Checkpoints', checkpoints, (checkpoint): Node => {
          const commit = repo.index?.commitsFor(checkpoint.checkpointId)[0];
          // A checkpoint of another branch has no row from the CLI. Entire's list says what it is.
          const row: CheckpointRow | undefined =
            repo.index?.row(checkpoint.checkpointId) ??
            (checkpoint.date || checkpoint.message
              ? {
                  checkpointId: checkpoint.checkpointId,
                  sessionIds: [],
                  ...(checkpoint.date ? { date: checkpoint.date } : {}),
                  ...(checkpoint.message ? { message: checkpoint.message } : {}),
                }
              : undefined);
          const ordinal = ordinals.get(checkpoint.checkpointId);
          return {
            kind: 'checkpoint',
            repo,
            checkpointId: checkpoint.checkpointId,
            sessionId: session.sessionId,
            parentId,
            ...(commit ? { commit } : {}),
            ...(row ? { row } : {}),
            // With Entire's list, the place is counted in it, and not in what the clone knows.
            ...(fromEntire && ordinal !== undefined
              ? { position: { ordinal, total: checkpoints.length, mayHaveEarlier: false } }
              : {}),
          };
        });
      }
      case 'checkpoint':
        return slotNodes(this.manager, node.repo, node.checkpointId, node.commit, nodeId(node));
      default:
        return [];
    }
  }

  /** How many sessions are running across the open repositories. */
  activeCount(): number {
    return this.manager.enabledRepos.reduce((total, repo) => total + this.manager.sessions(repo).active.length, 0);
  }

  private repoChildren(repo: RepoContext): Node[] {
    const { active, recent } = this.manager.sessions(repo);
    // Group only when something is running. Otherwise the list is flat.
    if (active.length === 0) return this.sessionNodes(repo, recent, LISTS.recentSessions);
    const groups: Node[] = [{ kind: 'sessionGroup', repo, group: 'active' }];
    if (recent.length > 0) groups.push({ kind: 'sessionGroup', repo, group: 'recent' });
    return groups;
  }

  private sessionNodes(repo: RepoContext, sessions: SessionEntry[], list: string): Node[] {
    // A session that Entire does not list is named by the prompt that opened
    // it. That is read from the session's checkpoints, for the rows on show
    // and not for the rest.
    this.manager.nameSessions(repo, sessions.slice(0, repo.limit(list)));
    // Entire may list more sessions than have been read, and then the list can grow past its rows.
    const more = list === LISTS.recentSessions && this.manager.moreSessionsOnEntire(repo);
    return paged(
      repo,
      list,
      'Sessions',
      sessions,
      (session): Node => ({ kind: 'session', repo, session }),
      more ? { moreToRead: true } : {},
    );
  }
}
