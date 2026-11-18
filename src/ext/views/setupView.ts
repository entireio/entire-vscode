import { randomBytes } from 'node:crypto';
import type * as vscode from 'vscode';
import { SETUP_PAGE_COMMANDS, setupPageHtml } from '../../core/setupPage';
import type { SetupService } from '../setupService';

export const SETUP_VIEW_ID = 'entire.setup';

/**
 * The Setup view: the steps that set up Entire, each with what is known
 * about it and a button that runs its command in a terminal.
 *
 * It is a page and not a tree, like the Brain view: what it says about each
 * step is text, and only its buttons act. The page has no script. Its
 * buttons are links to commands, and the editor runs only the commands
 * listed for it. Nothing is read for it until it is on screen.
 */
export class SetupView implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private readonly nonce = randomBytes(16).toString('base64');
  private readonly subscription: vscode.Disposable;
  /** The page as last drawn, for the extension-host tests. */
  html = '';

  constructor(private readonly setup: SetupService) {
    this.subscription = setup.onDidChange(() => this.render());
  }

  dispose(): void {
    this.subscription.dispose();
  }

  /** Whether the view is open and on screen. */
  get visible(): boolean {
    return this.view?.visible === true;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: false, enableCommandUris: SETUP_PAGE_COMMANDS, localResourceRoots: [] };
    view.onDidChangeVisibility(() => {
      this.setup.visible = view.visible;
      if (!view.visible) return;
      this.render();
      this.setup.viewShown();
    });
    view.onDidDispose(() => {
      if (this.view !== view) return;
      this.view = undefined;
      this.setup.visible = false;
    });
    this.html = '';
    this.setup.visible = view.visible;
    this.render();
    if (view.visible) this.setup.viewShown();
  }

  private render(): void {
    // Until the view has been opened there is no page to draw.
    if (!this.view) return;
    const html = setupPageHtml(this.setup.page(), this.nonce);
    // Setting the page reloads it, so it is set only when it has changed.
    if (html === this.html) return;
    this.html = html;
    this.view.webview.html = html;
  }
}
