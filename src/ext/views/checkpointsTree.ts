import * as vscode from 'vscode';
import type { CommitRecord } from '../../core/trailers';
import type { DetailTarget } from '../../shared/protocol';
import { LISTS, type RepoContext, type RepoManager } from '../repoManager';
import { nodeId, paged, tooltip, treeItem, type Node } from './nodes';
import { RowRegistry } from './rowRegistry';

/** Pages a list may grow by to bring one row onto it. */
export const MAX_PAGES_TO_REACH_A_ROW = 20;

/** Session slots of one checkpoint, loaded from the CLI the first time the row expands. */
export async function slotNodes(
  manager: RepoManager,
  repo: RepoContext,
  checkpointId: string,
  commit: CommitRecord | undefined,
  parentId: string,
): Promise<Node[]> {
  const detail = await manager.detail(repo, checkpointId);
  if (!detail.ok) {
    return [{ kind: 'message', id: `${parentId}|error`, text: detail.failure.message }];
  }
  if (detail.value.sessions.length === 0) {
    return [{ kind: 'message', id: `${parentId}|empty`, text: 'This checkpoint has no recorded sessions.' }];
  }
  return detail.value.sessions.map(
    (session): Node => ({
      kind: 'slot',
      repo,
      checkpointId,
      session,
      parentId,
      ...(commit ? { commit } : {}),
    }),
  );
}

/**
 * Commits on the current branch that carry checkpoints.
 *
 * Git supplies every row, so the list is complete without the CLI. CLI rows
 * add the agent where they exist. Rows appear a page at a time, and history
 * is scanned further back only when a page needs it.
 */
export class CheckpointsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
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
   * The row to select while a detail tab shows `target`: the commit that
   * carries the checkpoint, the checkpoint's own row under a commit that
   * carries several, or its row under Other Checkpoints. With `slot`, it is
   * the row of the target's session under that, for a checkpoint that holds
   * several sessions.
   *
   * A row beyond the end of its list is brought onto it: the list grows by
   * as many pages as it takes. Undefined when the view has no row for the
   * checkpoint.
   */
  async find(target: DetailTarget, options: { slot?: boolean } = {}): Promise<Node | undefined> {
    const repo = this.manager.repoFor(target.repoRoot);
    const checkpointId = target.checkpointId;
    if (!repo?.enabled || !repo.index || !checkpointId || this.manager.viewState !== 'ready') return undefined;
    const top = async (): Promise<Node[]> => {
      const roots = await this.getChildren();
      const own = roots.find((node) => node.kind === 'repo' && node.repo === repo);
      return own ? this.getChildren(own) : roots;
    };

    let row: Node | undefined;
    const carriers = repo.index.commitsFor(checkpointId);
    const commit = carriers.find((carrier) => carrier.sha === target.commitSha) ?? carriers[0];
    if (commit) {
      // The commit has been scanned, so only the number of rows on show stands between it and the list.
      for (let pages = 0; pages < MAX_PAGES_TO_REACH_A_ROW; pages += 1) {
        const at = repo.index?.commits.indexOf(commit) ?? -1;
        if (at < 0) return undefined;
        if (at < repo.limit(LISTS.commits)) break;
        await this.manager.showMore(repo, LISTS.commits);
      }
      const commitRow = (await top()).find((node) => node.kind === 'commit' && node.commit.sha === commit.sha);
      if (!commitRow) return undefined;
      row =
        commit.checkpointIds.length > 1
          ? (await this.getChildren(commitRow)).find((node) => node.kind === 'checkpoint' && node.checkpointId === checkpointId)
          : commitRow;
    } else {
      const at = repo.index.unlinkedRows().findIndex((unlinked) => unlinked.checkpointId === checkpointId);
      if (at < 0) return undefined;
      for (let pages = 0; pages < MAX_PAGES_TO_REACH_A_ROW && at >= repo.limit(LISTS.otherCheckpoints); pages += 1) {
        await this.manager.showMore(repo, LISTS.otherCheckpoints);
      }
      const group = (await top()).find((node) => node.kind === 'otherGroup');
      row = group
        ? (await this.getChildren(group)).find((node) => node.kind === 'checkpoint' && node.checkpointId === checkpointId)
        : undefined;
    }
    if (!row || !options.slot || !target.sessionId) return row;
    const slot = (await this.getChildren(row)).find(
      (node) => node.kind === 'slot' && node.session.sessionId === target.sessionId,
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
      case 'commit': {
        const { commit, repo } = node;
        const parentId = nodeId(node);
        const [first, ...rest] = commit.checkpointIds;
        if (first && rest.length === 0) return slotNodes(this.manager, repo, first, commit, parentId);
        return commit.checkpointIds.map((checkpointId): Node => {
          const row = repo.index?.row(checkpointId);
          return { kind: 'checkpoint', repo, checkpointId, commit, parentId, ...(row ? { row } : {}) };
        });
      }
      case 'checkpoint':
        return slotNodes(this.manager, node.repo, node.checkpointId, node.commit, nodeId(node));
      case 'otherGroup': {
        const parentId = nodeId(node);
        return paged(
          node.repo,
          LISTS.otherCheckpoints,
          'Checkpoints',
          node.repo.index?.unlinkedRows() ?? [],
          (row): Node => ({ kind: 'checkpoint', repo: node.repo, checkpointId: row.checkpointId, row, parentId }),
        );
      }
      default:
        return [];
    }
  }

  private repoChildren(repo: RepoContext): Node[] {
    const index = repo.index;
    if (!index) return [];
    const nodes = paged(
      repo,
      LISTS.commits,
      'Checkpoints',
      index.commits,
      (commit): Node => ({ kind: 'commit', repo, commit }),
      { moreToRead: !index.exhausted },
    );
    if (index.unlinkedRows().length > 0) nodes.push({ kind: 'otherGroup', repo });
    return nodes;
  }
}
