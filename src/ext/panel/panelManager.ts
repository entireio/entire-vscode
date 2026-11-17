import * as vscode from 'vscode';
import type { DetailTarget, TrailTarget } from '../../shared/protocol';
import type { Actions } from '../actions';
import type { RepoManager } from '../repoManager';
import type { DetailView } from '../views/nodes';
import { PanelController, readDetailTarget } from './panelController';
import { TrailPanelController, readTrailTarget } from './trailPanelController';

export const PANEL_VIEW_TYPE = 'entire.detail';
export const TRAIL_PANEL_VIEW_TYPE = 'entire.trail';

/** What a detail tab shows after it moved on without a click on a row, and the view it was opened from. */
export interface PanelShown {
  target: DetailTarget;
  origin?: DetailView;
}

/**
 * Opens detail panels. A click in a tree reuses one preview tab, the way
 * single-clicking a file does; Open in New Tab gives a tab that stays.
 *
 * Trails have a panel and a preview tab of their own. A checkpoint opened
 * from a trail's timeline therefore lands beside the trail, not in its place.
 */
export class PanelManager implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private preview?: PanelController;
  private readonly controllers = new Set<PanelController>();
  private trailPreview?: TrailPanelController;
  private readonly trailControllers = new Set<TrailPanelController>();
  private readonly shown = new vscode.EventEmitter<PanelShown>();
  /**
   * Fires when a detail tab shows something that no click on a row selected:
   * it stepped to another checkpoint, switched to another session, or was
   * opened from somewhere other than a row. The views select its row.
   */
  readonly onDidChangeShown = this.shown.event;

  /** Rebuilds a trail panel that was open when the window last closed. */
  readonly trailSerializer: vscode.WebviewPanelSerializer = {
    deserializeWebviewPanel: async (panel: vscode.WebviewPanel, state: unknown): Promise<void> => {
      const target = readTrailTarget(state);
      if (!target) {
        panel.dispose();
        return;
      }
      this.trackTrail(panel, target);
    },
  };

  constructor(
    private readonly manager: RepoManager,
    private readonly actions: Actions,
    private readonly extensionUri: vscode.Uri,
  ) {}

  dispose(): void {
    for (const controller of [...this.controllers, ...this.trailControllers]) controller.panel.dispose();
    this.shown.dispose();
  }

  /** The reusable trail preview panel, when one is open. */
  get currentTrail(): TrailPanelController | undefined {
    return this.trailPreview;
  }

  /** Every open trail panel, in the order it was opened. */
  get allTrails(): TrailPanelController[] {
    return [...this.trailControllers];
  }

  openTrail(target: TrailTarget, options: { newTab: boolean }): void {
    if (!options.newTab && this.trailPreview) {
      this.trailPreview.show(target);
      this.trailPreview.panel.reveal(undefined, true);
      return;
    }
    const controller = this.trackTrail(this.createPanel(TRAIL_PANEL_VIEW_TYPE, options), target);
    if (!options.newTab) this.trailPreview = controller;
  }

  /** The reusable preview panel, when one is open. */
  get current(): PanelController | undefined {
    return this.preview;
  }

  /** Every open panel, in the order it was opened. */
  get all(): PanelController[] {
    return [...this.controllers];
  }

  /**
   * Opens a tab on a checkpoint or a session. `origin` is the view whose row
   * was clicked. That click selected the row, so the views are told only
   * about a tab opened from somewhere else.
   */
  open(target: DetailTarget, options: { newTab: boolean; origin?: DetailView }): void {
    let controller: PanelController;
    if (!options.newTab && this.preview) {
      controller = this.preview;
      controller.show(target);
      controller.panel.reveal(undefined, true);
    } else {
      controller = this.track(this.createPanel(PANEL_VIEW_TYPE, options), target);
      if (!options.newTab) this.preview = controller;
    }
    controller.origin = options.origin;
    if (!options.origin) this.shown.fire({ target });
  }

  private createPanel(viewType: string, options: { newTab: boolean }): vscode.WebviewPanel {
    return vscode.window.createWebviewPanel(
      viewType,
      'Entire',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: !options.newTab },
      {
        enableScripts: true,
        enableFindWidget: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview')],
      },
    );
  }

  /** Rebuilds a panel that was open when the window last closed. */
  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const target = readDetailTarget(state);
    if (!target) {
      panel.dispose();
      return;
    }
    this.track(panel, target);
  }

  private track(panel: vscode.WebviewPanel, target: DetailTarget): PanelController {
    const controller = new PanelController(panel, this.manager, this.actions, this.extensionUri, target);
    this.controllers.add(controller);
    const moved = controller.onDidChangeShown((shown) => {
      this.shown.fire(controller.origin ? { target: shown, origin: controller.origin } : { target: shown });
    });
    controller.onDidDispose(() => {
      moved.dispose();
      this.controllers.delete(controller);
      if (this.preview === controller) this.preview = undefined;
    });
    return controller;
  }

  private trackTrail(panel: vscode.WebviewPanel, target: TrailTarget): TrailPanelController {
    const controller = new TrailPanelController(
      panel,
      this.manager,
      this.actions,
      this.extensionUri,
      target,
      // A checkpoint from the timeline opens in the checkpoint preview tab.
      (checkpoint) => this.open(checkpoint, { newTab: false }),
    );
    this.trailControllers.add(controller);
    controller.onDidDispose(() => {
      this.trailControllers.delete(controller);
      if (this.trailPreview === controller) this.trailPreview = undefined;
    });
    return controller;
  }
}
