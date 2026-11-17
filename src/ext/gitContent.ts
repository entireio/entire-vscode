import * as vscode from 'vscode';
import { isCommitSha } from '../core/trailers';
import type { RepoManager } from './repoManager';

export const GIT_SCHEME = 'entire-git';
export const TEXT_SCHEME = 'entire-text';

function readQuery(uri: vscode.Uri): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(uri.query);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A file as it was at a commit. An empty `ref` stands for "did not exist". */
export function gitFileUri(root: string, ref: string, filePath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: GIT_SCHEME, path: `/${filePath}`, query: JSON.stringify({ root, ref }) });
}

/** Read-only documents for file versions at a commit, so `vscode.diff` can compare them. */
export class GitContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly manager: RepoManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, ref } = readQuery(uri);
    if (typeof root !== 'string' || typeof ref !== 'string' || ref === '') return '';
    if (!this.manager.repoFor(root) || !isCommitSha(ref)) return '';
    const blob = await this.manager.git.blob(root, ref, uri.path.slice(1));
    return blob?.toString('utf8') ?? '';
  }
}

/** Holds text that is too long for the panel, such as a large tool result. */
export class TextProvider implements vscode.TextDocumentContentProvider {
  private readonly documents = new Map<string, string>();
  private counter = 0;

  /** Stores the text and returns a URI that opens it. Keeps the 20 most recent. */
  add(title: string, text: string): vscode.Uri {
    const key = String(++this.counter);
    this.documents.set(key, text);
    if (this.documents.size > 20) {
      const oldest = this.documents.keys().next().value;
      if (oldest !== undefined) this.documents.delete(oldest);
    }
    const name = title.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'text';
    return vscode.Uri.from({ scheme: TEXT_SCHEME, path: `/${name}-${key}.txt`, query: key });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.documents.get(uri.query) ?? '';
  }
}
