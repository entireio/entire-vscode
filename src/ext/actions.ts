import { existsSync } from 'node:fs';
import path from 'node:path';
import * as vscode from 'vscode';
import type { EntireCli } from '../core/entireCli';
import type { Result } from '../core/errors';
import type { FileChange } from '../core/git';
import { commitUrl, repoUrl, sessionUrl } from '../core/webLinks';
import { gitFileUri, type TextProvider } from './gitContent';
import type { RepoContext, RepoManager } from './repoManager';
import type { TranscriptFiles } from './transcriptFiles';

const NO_WEB =
  'Links to entire.com are available when the origin remote uses the entire:// scheme.';

/** User-facing operations shared by the tree views and the detail panel. */
export class Actions {
  constructor(
    private readonly manager: RepoManager,
    private readonly text: TextProvider,
    private readonly transcripts: TranscriptFiles,
  ) {}

  async openRepoOnWeb(repo: RepoContext): Promise<void> {
    if (!repo.entireRepo) return void vscode.window.showInformationMessage(NO_WEB);
    await this.openExternal(repoUrl(this.manager.webBase(), repo.entireRepo));
  }

  /** Opens the commit page, which is where entire.com shows a commit's checkpoint. */
  async openCommitOnWeb(repo: RepoContext, sha: string): Promise<void> {
    if (!repo.entireRepo) return void vscode.window.showInformationMessage(NO_WEB);
    if (!(await this.manager.git.isOnRemote(repo.root, sha))) {
      const choice = await vscode.window.showWarningMessage(
        'This commit is not on a remote yet, so entire.com may not have it.',
        'Open Anyway',
      );
      if (choice !== 'Open Anyway') return;
    }
    await this.openExternal(commitUrl(this.manager.webBase(), repo.entireRepo, sha));
  }

  async openSessionOnWeb(repo: RepoContext, sessionId: string): Promise<void> {
    if (!repo.entireRepo) return void vscode.window.showInformationMessage(NO_WEB);
    await this.openExternal(sessionUrl(this.manager.webBase(), repo.entireRepo, sessionId));
  }

  /** Opens a trail's page. The address comes from the CLI, which may have to look it up first. */
  async openTrailOnWeb(repo: RepoContext, trail: number): Promise<void> {
    const url = await this.trailUrl(repo, trail);
    if (url) await this.openExternal(url);
  }

  async copyTrailLink(repo: RepoContext, trail: number): Promise<void> {
    const url = await this.trailUrl(repo, trail);
    if (url) await this.copy(url, 'trail link');
  }

  private async trailUrl(repo: RepoContext, trail: number): Promise<string | undefined> {
    if (!repo.entireRepo) return void vscode.window.showInformationMessage(NO_WEB);
    const url = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Entire: looking up the trail' },
      () => this.manager.trailUrl(repo, trail),
    );
    if (!url) void vscode.window.showErrorMessage('Entire could not look up the web page of this trail.');
    return url;
  }

  /** Opens http and https links only. Transcript text can contain any URL. */
  async openExternal(href: string): Promise<void> {
    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    await vscode.env.openExternal(vscode.Uri.parse(url.toString(), true));
  }

  async showCommitDiff(repo: RepoContext, sha: string): Promise<void> {
    const files = await this.manager.git.commitFiles(repo.root, sha);
    if (files.length === 0) {
      return void vscode.window.showInformationMessage('This commit changed no files.');
    }
    const parent = await this.manager.git.parent(repo.root, sha);
    const title = `Commit ${sha.slice(0, 8)}`;
    const resources = files.map((file) => [
      vscode.Uri.file(path.join(repo.root, file.path)),
      ...this.sides(repo, sha, parent, file),
    ]);
    try {
      await vscode.commands.executeCommand('vscode.changes', title, resources);
    } catch {
      // Editors without the multi-file diff editor get a picker instead.
      const pick = await vscode.window.showQuickPick(
        files.map((file) => ({ label: file.path, description: file.status, file })),
        { title, placeHolder: 'Select a file to compare' },
      );
      if (pick) await this.diffFile(repo, sha, parent, pick.file);
    }
  }

  /** Shows what a commit did to one file, or opens the file when the commit did not change it. */
  async openFile(repo: RepoContext, sha: string | undefined, filePath: string): Promise<void> {
    if (sha) {
      const files = await this.manager.git.commitFiles(repo.root, sha);
      const change = files.find((file) => file.path === filePath);
      if (change) {
        await this.diffFile(repo, sha, await this.manager.git.parent(repo.root, sha), change);
        return;
      }
    }
    const absolute = path.join(repo.root, filePath);
    // Stay inside the repository: a transcript can name any path.
    const relative = path.relative(repo.root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !existsSync(absolute)) {
      return void vscode.window.showInformationMessage(`${filePath} is not in the working tree.`);
    }
    await vscode.window.showTextDocument(vscode.Uri.file(absolute), { preview: true });
  }

  async openRawCheckpointTranscript(repo: RepoContext, checkpointId: string, sessionIndex: number): Promise<void> {
    await this.openRawTranscript(`${checkpointId}-session-${sessionIndex}.jsonl`, (cli, file) =>
      cli.rawTranscript(repo.root, checkpointId, sessionIndex, file),
    );
  }

  async openRawSessionTranscript(repo: RepoContext, sessionId: string): Promise<void> {
    await this.openRawTranscript(`session-${sessionId}.jsonl`, (cli, file) =>
      cli.sessionRawTranscript(repo.root, sessionId, file),
    );
  }

  /**
   * Has the CLI write a raw transcript to a temporary file, then opens the
   * file. A raw transcript can be far too large to pass around in memory.
   */
  private async openRawTranscript(
    name: string,
    write: (cli: EntireCli, file: string) => Promise<Result<number>>,
  ): Promise<void> {
    const cli = this.manager.cli;
    if (!cli) return void vscode.window.showErrorMessage('The Entire CLI is not available.');
    const file = await this.transcripts.prepare(name);
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: 'Entire: reading the raw transcript' },
      () => write(cli, file),
    );
    if (!result.ok) {
      await this.transcripts.discard(file);
      return void vscode.window.showErrorMessage(result.failure.message);
    }
    await this.transcripts.seal(file);
    // `vscode.open` hands the file to the editor without loading it into the
    // extension host, which refuses documents over 50 MB.
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { preview: true });
  }

  async openText(title: string, text: string): Promise<void> {
    await this.showDocument(this.text.add(title, text));
  }

  async copy(value: string, label: string): Promise<void> {
    await vscode.env.clipboard.writeText(value);
    vscode.window.setStatusBarMessage(`Copied ${label}`, 2000);
  }

  private sides(
    repo: RepoContext,
    sha: string,
    parent: string | undefined,
    file: FileChange,
  ): [vscode.Uri, vscode.Uri] {
    const before = file.status === 'A' ? '' : (parent ?? '');
    const after = file.status === 'D' ? '' : sha;
    return [gitFileUri(repo.root, before, file.oldPath ?? file.path), gitFileUri(repo.root, after, file.path)];
  }

  private async diffFile(
    repo: RepoContext,
    sha: string,
    parent: string | undefined,
    file: FileChange,
  ): Promise<void> {
    const [left, right] = this.sides(repo, sha, parent, file);
    await vscode.commands.executeCommand(
      'vscode.diff',
      left,
      right,
      `${path.basename(file.path)} (${sha.slice(0, 8)})`,
      { preview: true },
    );
  }

  private async showDocument(uri: vscode.Uri): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Entire could not open that document.');
    }
  }
}
