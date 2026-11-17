import type * as vscode from 'vscode';
import type { DetailTarget } from '../../shared/protocol';
import type { PanelManager, PanelShown } from '../panel/panelManager';
import { standsFor, type DetailView, type Node } from './nodes';

/** A view whose rows open the detail panel, and the tree that fills it. */
export interface FollowedView {
  view: vscode.TreeView<Node>;
  tree: { find(target: DetailTarget, options?: { slot?: boolean }): Promise<Node | undefined> };
}

/**
 * Moves a view's selection to what the detail tab shows.
 *
 * A click selects a row and opens the tab on it. The tab can then move on by
 * itself: Previous and Next step through a session's checkpoints, and a
 * checkpoint that holds several sessions lets the reader pick another one.
 * The row that was clicked would stay selected, under a tab that now shows
 * something else. So when a tab moves, the view it was opened from selects
 * the row for what the tab shows now. A tab that was not opened from a row,
 * such as a checkpoint opened from a trail, is followed by the Checkpoints
 * view.
 *
 * A view that is not on screen is left alone: revealing a row there would
 * open the sidebar on it.
 */
export class SelectionSync implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  /** Counts the moves, so that a search for an earlier one does not select its row after a later one has. */
  private moves = 0;
  /** The latest move, which the extension-host tests wait for. */
  settled: Promise<void> = Promise.resolve();

  constructor(
    private readonly views: Record<DetailView, FollowedView>,
    panels: PanelManager,
    private readonly log: (line: string) => void = () => {},
  ) {
    this.subscription = panels.onDidChangeShown((shown) => {
      this.settled = this.follow(shown);
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.moves += 1;
  }

  private async follow(shown: PanelShown): Promise<void> {
    const move = ++this.moves;
    const { view, tree } = this.views[shown.origin ?? 'checkpoints'];
    if (!view.visible) return;
    const selected = view.selection[0];
    if (selected && standsFor(selected, shown.target)) return;
    try {
      // The reader was on a session's own row, so the row to move to is that session's too.
      const row = await tree.find(shown.target, { slot: selected?.kind === 'slot' });
      if (!row || move !== this.moves || !view.visible) return;
      // The keyboard focus stays where it is: in the tab, on the button that was pressed.
      await view.reveal(row, { select: true, focus: false });
    } catch (error) {
      this.log(`Could not select the row for the open tab: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
