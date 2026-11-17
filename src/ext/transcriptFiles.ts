import { rmSync } from 'node:fs';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type * as vscode from 'vscode';

/**
 * Temporary files that hold raw transcripts while they are open in an editor.
 *
 * A raw transcript is in the agent's own format and can run to hundreds of
 * megabytes, which is too much to hold in memory and hand to the editor as one
 * string. The Entire CLI's output goes straight to a file here, and the editor
 * opens that file with its own handling for large files.
 *
 * The files sit in a directory that only the current user can read, are made
 * read-only once written, and are deleted when the window closes.
 */
export class TranscriptFiles implements vscode.Disposable {
  private directory?: Promise<string>;
  /** Known once the directory exists, so `dispose` can remove it without waiting. */
  private created?: string;

  /** A path for `name` with nothing at it yet. A transcript opened earlier under that name is replaced. */
  async prepare(name: string): Promise<string> {
    // `mkdtemp` creates the directory with access for its owner only.
    this.directory ??= mkdtemp(path.join(os.tmpdir(), 'entire-transcripts-')).then((directory) => {
      this.created = directory;
      return directory;
    });
    const file = path.join(await this.directory, name.replace(/[^\w.-]/g, '_'));
    await rm(file, { force: true });
    return file;
  }

  /** Marks a finished file read-only, so the editor opens it read-only too. */
  async seal(file: string): Promise<void> {
    await chmod(file, 0o400);
  }

  async discard(file: string): Promise<void> {
    await rm(file, { force: true });
  }

  dispose(): void {
    if (this.created) rmSync(this.created, { recursive: true, force: true });
  }
}
