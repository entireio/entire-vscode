import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { brainDetails } from '../../core/brain';
import { BRAIN_PAGE_COMMANDS, brainPageHtml, type BrainPageSection } from '../../core/brainPage';
import { relativeTime } from '../../core/format';
import type { BrainService } from '../brainService';
import type { RepoManager } from '../repoManager';

export const BRAIN_VIEW_ID = 'entire.brain';

/**
 * The Brain view: what the entire-brain plugin reports about the brain of
 * the repository, and a button that opens the brain's graph in the browser.
 *
 * It is a page and not a tree. Every row of a tree looks clickable, and the
 * brain's details have nothing to click: they are text. Only the buttons act.
 *
 * The page has no script. Its buttons are links to commands, and the editor
 * runs only the commands listed for it. The view starts collapsed, and the
 * editor builds the page only when it is first opened, which is when the
 * brain is first read.
 */
export class BrainView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly nonce = randomBytes(16).toString('base64');
  private readonly subscriptions: vscode.Disposable[];
  private readonly shown = new vscode.EventEmitter<void>();
  /** Fires each time the view comes on screen. */
  readonly onDidShow = this.shown.event;
  /** The page as last drawn, for the extension-host tests. */
  html = '';

  constructor(
    private readonly manager: RepoManager,
    private readonly brain: BrainService,
  ) {
    const redraw = (): void => this.render();
    this.subscriptions = [manager.onDidChange(redraw), brain.onDidChange(redraw)];
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.shown.dispose();
  }

  /** Whether the view is open and on screen. */
  get visible(): boolean {
    return this.view?.visible === true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false, enableCommandUris: BRAIN_PAGE_COMMANDS, localResourceRoots: [] };
    view.onDidChangeVisibility(() => {
      if (!view.visible) return;
      this.shown.fire();
      this.render();
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.html = '';
    this.shown.fire();
    this.render();
  }

  /** What the page shows: one section for each repository that has Entire enabled. */
  sections(): BrainPageSection[] {
    if (this.manager.viewState !== 'ready') return [];
    return this.manager.enabledRepos.map((repo): BrainPageSection => {
      const state = this.brain.stateOf(repo.root);
      const status = this.brain.details(repo.root)?.status;
      const url = this.brain.url(repo.root);
      return {
        root: repo.root,
        name: repo.name,
        state,
        details: state === 'ready' && status ? brainDetails(status, relativeTime(status.generatedAt)) : [],
        ...(url ? { running: url.replace(/^http:\/\//, '') } : {}),
      };
    });
  }

  private render(): void {
    // Until the view has been opened there is no page to draw.
    if (!this.view) return;
    const html = brainPageHtml(this.sections(), this.nonce);
    // Setting the page reloads it, so it is set only when it has changed.
    if (html === this.html) return;
    this.html = html;
    this.view.webview.html = html;
  }
}
