import * as vscode from 'vscode';
import type { RepoManager } from '../repoManager';
import { LOAD_MORE_SCHEME, readLoadMoreUri } from './nodes';

/**
 * Loads the next page of a list when its Load More row scrolls into view.
 *
 * Tree views tell an extension nothing about scrolling. They do ask for a
 * row's file decoration when they draw it, and they draw only the rows in
 * view. Each Load More row carries a URI that names its list and how many
 * rows the list showed when the row was made, so a request to decorate that
 * URI means the row is on screen.
 *
 * This leans on how the tree draws rows, which is not a documented contract.
 * If a future editor asks at a different time, the row is still there to
 * click, and `entire.loadOnScroll` turns this off.
 */
export class ScrollLoader implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    // The editor remembers the answer for each row it has asked about. When
    // the setting changes, ask it to forget, so a Load More row that is
    // already on screen is asked about again.
    this.subscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('entire.loadOnScroll')) this.changed.fire(undefined);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): undefined {
    if (uri.scheme !== LOAD_MORE_SCHEME) return undefined;
    if (!vscode.workspace.getConfiguration('entire').get<boolean>('loadOnScroll', true)) return undefined;
    const target = readLoadMoreUri(uri);
    const repo = target ? this.manager.repoFor(target.root) : undefined;
    if (!target || !repo || repo.autoLoadPaused.has(target.list)) return undefined;

    // Load after the tree has finished drawing, not in the middle of it.
    setTimeout(() => {
      // The row belongs to a page that has already been extended: a second
      // draw of the same row, or one that outlived its list.
      if (repo.limit(target.list) !== target.limit || !this.manager.repos.includes(repo)) return;
      void this.manager.showMore(repo, target.list, { automatic: true });
    }, 0);
    return undefined;
  }
}
