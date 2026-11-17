import * as vscode from 'vscode';
import { noTrailsText } from '../../core/trails';
import type { RepoContext, RepoManager } from '../repoManager';
import { paged, tooltip, treeItem, type Node } from './nodes';

/**
 * The trails that touch the repository: the units of work that entire.io
 * tracks, each with a branch in one or more repositories.
 *
 * Trails come from entire.io through the CLI, so this view exists only for a
 * repository whose origin remote uses the `entire://` scheme. It lists the
 * trails the filter selects, a page at a time, most recent activity first:
 * every trail, the open ones, the closed ones, or the open ones in one phase.
 */
export class TrailsTree implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subscription: vscode.Disposable;
  /** The row each row was listed under, which `TreeView.reveal` needs. */
  private readonly parents = new WeakMap<Node, Node | undefined>();

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
    return this.parents.get(node);
  }

  getChildren(node?: Node): Node[] {
    const children = this.listChildren(node);
    for (const child of children) this.parents.set(child, node);
    return children;
  }

  private listChildren(node?: Node): Node[] {
    if (!node) {
      const repos = this.manager.trailRepos;
      if (repos.length === 1 && repos[0]) return this.repoChildren(repos[0], false);
      return repos.map((repo): Node => ({ kind: 'repo', repo }));
    }
    return node.kind === 'repo' ? this.repoChildren(node.repo, true) : [];
  }

  /**
   * The trails of one repository. When the repository is alone in the view
   * and has no rows, the view stays empty and its welcome text says why.
   * Under a repository row there is no welcome text, so a row says it.
   */
  private repoChildren(repo: RepoContext, nested: boolean): Node[] {
    const list = repo.trails;
    const note = (id: string, text: string): Node[] =>
      nested ? [{ kind: 'message', id: `${repo.root}|trails:${id}`, text }] : [];
    if (!list || (list.loading && list.trails.length === 0)) return note('loading', 'Loading…');
    const filter = this.manager.trailFilter;
    const shown = this.manager.shownTrails(list);
    const moreToRead = list.nextPageToken !== undefined;
    if (shown.length === 0 && !moreToRead) {
      return list.failure ? note('failed', list.failure.message) : note('empty', noTrailsText(filter));
    }
    return paged(repo, list.list, 'Trails', shown, (trail): Node => ({ kind: 'trail', repo, trail }), {
      moreToRead,
      // The CLI's total counts every trail of the status. With a filter on a
      // phase it is how far there is to read, not how many rows there will be.
      ...(filter.phase
        ? { scanned: { read: list.trails.length, ...(list.total === undefined ? {} : { total: list.total }) } }
        : list.total === undefined
          ? {}
          : { sourceTotal: list.total }),
    });
  }
}
