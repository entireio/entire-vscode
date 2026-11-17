import path from 'node:path';
import * as vscode from 'vscode';
import type { RepoContext, RepoManager } from './repoManager';

const GIT_DEBOUNCE_MS = 500;
const SESSION_DEBOUNCE_MS = 1000;
/** On window focus, data older than this is checked again. */
const FOCUS_MAX_AGE_MS = 60_000;

interface Pending {
  git: boolean;
  status: boolean;
  timer?: NodeJS.Timeout;
}

/**
 * Keeps the views current without polling.
 *
 * File watchers report when HEAD moves and when Entire's session state
 * changes. Work is deferred while no Entire view is visible. Automatic
 * refreshes read git and `entire status --json` only: `entire session list`
 * prunes old session state as it loads, so it stays behind a user gesture.
 */
export class RefreshController implements vscode.Disposable {
  private watchers: vscode.Disposable[] = [];
  private watched = '';
  private readonly pending = new Map<RepoContext, Pending>();
  private readonly subscriptions: vscode.Disposable[];

  constructor(
    private readonly manager: RepoManager,
    private readonly isVisible: () => boolean,
  ) {
    this.subscriptions = [
      manager.onDidChange(() => this.syncWatchers()),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) this.onFocus();
      }),
    ];
    this.syncWatchers();
  }

  dispose(): void {
    this.disposeWatchers();
    for (const subscription of this.subscriptions) subscription.dispose();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  /** Runs the work that was deferred while no view was visible. */
  flush(): void {
    for (const [repo, entry] of this.pending) {
      if (entry.git || entry.status) this.schedule(repo, {}, 0);
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
  }

  /** Rebuilds the watchers when the set of enabled repositories changes. */
  private syncWatchers(): void {
    const repos = this.manager.enabledRepos;
    const key = repos.map((repo) => `${repo.paths.gitDir}|${repo.paths.commonDir}`).join('\n');
    if (key === this.watched) return;
    this.watched = key;
    this.disposeWatchers();
    for (const repo of repos) {
      const { gitDir, commonDir } = repo.paths;
      // HEAD changes on a branch switch; the reflog changes on every commit,
      // reset, and rebase. Each watcher covers one directory, not the whole
      // git directory with its object store.
      this.watch(gitDir, 'HEAD', () => this.schedule(repo, { git: true }, GIT_DEBOUNCE_MS));
      this.watch(path.join(gitDir, 'logs'), 'HEAD', () => this.schedule(repo, { git: true }, GIT_DEBOUNCE_MS));
      this.watch(path.join(commonDir, 'entire-sessions'), '*.json', () =>
        this.schedule(repo, { status: true }, SESSION_DEBOUNCE_MS),
      );
    }
  }

  private watch(directory: string, pattern: string, onEvent: () => void): void {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(directory), pattern),
    );
    this.watchers.push(
      watcher,
      watcher.onDidChange(onEvent),
      watcher.onDidCreate(onEvent),
      watcher.onDidDelete(onEvent),
    );
  }

  private onFocus(): void {
    const now = Date.now();
    for (const repo of this.manager.enabledRepos) {
      if (now - repo.lastRefresh > FOCUS_MAX_AGE_MS) this.schedule(repo, { git: true, status: true }, 0);
    }
  }

  private schedule(repo: RepoContext, what: { git?: boolean; status?: boolean }, delay: number): void {
    let entry = this.pending.get(repo);
    if (!entry) {
      entry = { git: false, status: false };
      this.pending.set(repo, entry);
    }
    entry.git ||= what.git === true;
    entry.status ||= what.status === true;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.run(repo), delay);
  }

  private async run(repo: RepoContext): Promise<void> {
    const entry = this.pending.get(repo);
    if (!entry || !this.isVisible()) return;
    if (!this.manager.repos.includes(repo)) {
      this.pending.delete(repo);
      return;
    }
    const { git, status } = entry;
    entry.git = false;
    entry.status = false;
    if (git) await this.manager.refreshGit(repo);
    if (status) await this.manager.refreshStatus(repo);
  }
}
