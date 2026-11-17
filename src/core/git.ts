import path from 'node:path';
import { fail, ok, type Result } from './errors';
import type { Exec, ExecResult } from './exec';
import type { Lane } from './scheduler';
import { LOG_FORMAT, isCommitSha, parseLogRecords, type CommitRecord } from './trailers';

export interface RepoPaths {
  /** Working tree root. */
  root: string;
  /** This worktree's git directory, which holds HEAD. */
  gitDir: string;
  /** The git directory shared by every worktree, which holds refs and session state. */
  commonDir: string;
}

export interface FileChange {
  /** First letter of the git status: A, M, D, R, C, or T. */
  status: string;
  path: string;
  /** Previous path for a rename or copy. */
  oldPath?: string;
}

interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Read-only git queries. Nothing here writes to the repository. */
export class Git {
  constructor(
    private readonly exec: Exec,
    private readonly lane: Lane,
    private readonly gitPath = 'git',
  ) {}

  private run(cwd: string, args: string[], options: RunOptions = {}): Promise<ExecResult> {
    return this.lane.run(() =>
      this.exec(this.gitPath, args, {
        cwd,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
      }),
    );
  }

  private async line(cwd: string, args: string[], options?: RunOptions): Promise<string | undefined> {
    const result = await this.run(cwd, args, options);
    if (result.code !== 0) return undefined;
    const value = result.stdout.toString('utf8').trim();
    return value === '' ? undefined : value;
  }

  async repoPaths(cwd: string): Promise<Result<RepoPaths>> {
    const result = await this.run(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
    if (result.spawnError) {
      return fail('spawn', 'Git is not installed, or it is not on your PATH.', result.spawnError.message);
    }
    if (result.code !== 0) return fail('notGit', 'This folder is not a Git repository.', result.stderr);
    const [root, gitDir, commonDir] = result.stdout.toString('utf8').split('\n');
    if (!root || !gitDir || !commonDir) {
      return fail('notGit', 'This folder is not a Git repository with a working tree.', result.stderr);
    }
    return ok({ root, gitDir: path.resolve(cwd, gitDir), commonDir: path.resolve(cwd, commonDir) });
  }

  /** The commit HEAD points at, or undefined on a branch with no commits. */
  head(cwd: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.line(cwd, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], signal ? { signal } : {});
  }

  branch(cwd: string): Promise<string | undefined> {
    return this.line(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
  }

  originUrl(cwd: string): Promise<string | undefined> {
    return this.line(cwd, ['config', '--get', 'remote.origin.url']);
  }

  /** One window of history starting at `tip`, including commits with no checkpoint. */
  async logWindow(
    cwd: string,
    tip: string,
    skip: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<Result<CommitRecord[]>> {
    if (!isCommitSha(tip)) return fail('unexpectedOutput', 'The branch tip is not a commit.');
    const result = await this.run(
      cwd,
      ['log', tip, `--skip=${skip}`, `--max-count=${count}`, '-z', '--no-show-signature', `--format=${LOG_FORMAT}`],
      { timeoutMs: 30_000, maxBytes: 64 * 1024 * 1024, ...(signal ? { signal } : {}) },
    );
    if (result.aborted) return fail('aborted', 'Cancelled.');
    if (result.timedOut) return fail('timeout', 'Reading the commit history took too long.');
    if (result.code !== 0) return fail('exit', 'Git could not read the commit history.', result.stderr);
    return ok(parseLogRecords(result.stdout.toString('utf8')));
  }

  /** A single commit, for commits outside the windows already loaded. */
  async commit(cwd: string, sha: string): Promise<CommitRecord | undefined> {
    if (!isCommitSha(sha)) return undefined;
    const result = await this.run(cwd, [
      'log',
      sha,
      '--max-count=1',
      '-z',
      '--no-show-signature',
      `--format=${LOG_FORMAT}`,
    ]);
    if (result.code !== 0) return undefined;
    return parseLogRecords(result.stdout.toString('utf8'))[0];
  }

  /** SHA of the commit's first parent, or undefined for a root commit. */
  async parent(cwd: string, sha: string): Promise<string | undefined> {
    if (!isCommitSha(sha)) return undefined;
    const parent = await this.line(cwd, ['rev-parse', '--verify', '-q', `${sha}^`]);
    return parent && isCommitSha(parent) ? parent : undefined;
  }

  /** Whether a remote-tracking ref contains the commit, so a web page for it can exist. */
  async isOnRemote(cwd: string, sha: string): Promise<boolean> {
    if (!isCommitSha(sha)) return false;
    const ref = await this.line(cwd, [
      'for-each-ref',
      '--contains',
      sha,
      '--count=1',
      '--format=%(refname)',
      'refs/remotes/',
    ]);
    return ref !== undefined;
  }

  /** Files a commit changed relative to its first parent, or all its files for a root commit. */
  async commitFiles(cwd: string, sha: string): Promise<FileChange[]> {
    if (!isCommitSha(sha)) return [];
    const parent = await this.parent(cwd, sha);
    // Comparing two trees also works for a merge commit, where the
    // one-commit form of diff-tree prints nothing.
    const range = parent ? [parent, sha] : ['--root', sha];
    const result = await this.run(cwd, ['diff-tree', '-r', '--no-commit-id', '--name-status', '-z', '-M', ...range]);
    if (result.code !== 0) return [];
    return parseNameStatus(result.stdout.toString('utf8'));
  }

  /** Contents of `<treeish>:<path>`, or undefined when it does not exist. */
  async blob(cwd: string, treeish: string, filePath: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    const result = await this.run(cwd, ['cat-file', 'blob', `${treeish}:${filePath}`], {
      timeoutMs: 30_000,
      maxBytes: 128 * 1024 * 1024,
      ...(signal ? { signal } : {}),
    });
    if (result.code !== 0 || result.truncated) return undefined;
    return result.stdout;
  }

  /**
   * The start of `<treeish>:<path>`: about `maxBytes` of it, or all of it
   * when it is shorter. Undefined when the file does not exist. This is for
   * a large file of which only the first lines are wanted: git is stopped
   * once it has written that much.
   */
  async blobHead(
    cwd: string,
    treeish: string,
    filePath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<{ data: Buffer; whole: boolean } | undefined> {
    const result = await this.run(cwd, ['cat-file', 'blob', `${treeish}:${filePath}`], {
      timeoutMs: 30_000,
      maxBytes,
      ...(signal ? { signal } : {}),
    });
    if (result.truncated) return { data: result.stdout, whole: false };
    return result.code === 0 ? { data: result.stdout, whole: true } : undefined;
  }

  async exists(cwd: string, treeish: string, filePath: string): Promise<boolean> {
    const result = await this.run(cwd, ['cat-file', '-e', `${treeish}:${filePath}`]);
    return result.code === 0;
  }

  /** Full names of the refs that match the given `for-each-ref` patterns. */
  async refs(cwd: string, patterns: string[]): Promise<string[]> {
    const result = await this.run(cwd, ['for-each-ref', '--format=%(refname)', ...patterns]);
    if (result.code !== 0) return [];
    return result.stdout
      .toString('utf8')
      .split('\n')
      .filter((ref) => ref !== '');
  }
}

export function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split('\x00');
  const changes: FileChange[] = [];
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (!status) break;
    const letter = status.charAt(0);
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i + 1];
      const newPath = tokens[i + 2];
      if (oldPath && newPath) changes.push({ status: letter, path: newPath, oldPath });
      i += 3;
    } else {
      const filePath = tokens[i + 1];
      if (filePath) changes.push({ status: letter, path: filePath });
      i += 2;
    }
  }
  return changes;
}
