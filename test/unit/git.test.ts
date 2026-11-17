import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../../src/core/exec';
import { Git, parseNameStatus } from '../../src/core/git';
import { Lane } from '../../src/core/scheduler';
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixtureRepo';
import { fakeSha, isolateGitConfig } from './support';

const HEX = 'abcdef012345';

describe('Git', () => {
  const git = new Git(exec, new Lane(4));
  let repo: FixtureRepo;
  const scratch: string[] = [];

  /** A directory outside the fixture repo, removed after the test. */
  const scratchDir = (): string => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-git-test-')));
    scratch.push(dir);
    return dir;
  };

  beforeAll(() => isolateGitConfig());
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => {
    repo = createFixtureRepo();
  });
  afterEach(() => {
    repo.dispose();
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  describe('repoPaths', () => {
    it('finds the root and the git directories of a repository', async () => {
      const paths = await git.repoPaths(repo.root);
      expect(paths).toEqual({
        ok: true,
        value: { root: repo.root, gitDir: path.join(repo.root, '.git'), commonDir: path.join(repo.root, '.git') },
      });
    });

    it('finds the same paths from a subdirectory, as absolute paths', async () => {
      const nested = path.join(repo.root, 'packages', 'deep');
      mkdirSync(nested, { recursive: true });
      const paths = await git.repoPaths(nested);
      expect(paths).toEqual({
        ok: true,
        value: { root: repo.root, gitDir: path.join(repo.root, '.git'), commonDir: path.join(repo.root, '.git') },
      });
    });

    it('tells a linked worktree apart from the directory that every worktree shares', async () => {
      repo.commit('Initial commit');
      const worktree = path.join(scratchDir(), 'linked');
      repo.git('worktree', 'add', '--quiet', '-b', 'linked', worktree);

      const paths = await git.repoPaths(worktree);
      expect(paths.ok).toBe(true);
      if (!paths.ok) return;
      expect(paths.value.root).toBe(worktree);
      expect(paths.value.commonDir).toBe(path.join(repo.root, '.git'));
      expect(paths.value.gitDir).toBe(path.join(repo.root, '.git', 'worktrees', 'linked'));
    });

    it('reports a folder that is not a repository', async () => {
      const dir = scratchDir();
      vi.stubEnv('GIT_CEILING_DIRECTORIES', path.dirname(dir));
      try {
        const paths = await git.repoPaths(dir);
        expect(paths.ok).toBe(false);
        if (paths.ok) return;
        expect(paths.failure.kind).toBe('notGit');
        expect(paths.failure.message).not.toBe('');
      } finally {
        vi.stubEnv('GIT_CEILING_DIRECTORIES', '');
      }
    });

    it('reports a bare repository, which has no working tree, as not usable', async () => {
      const bare = path.join(scratchDir(), 'bare.git');
      repo.git('init', '--quiet', '--bare', bare);
      const paths = await git.repoPaths(bare);
      expect(paths.ok).toBe(false);
      expect(!paths.ok && paths.failure.kind).toBe('notGit');
    });

    it('reports a missing git binary as a spawn failure', async () => {
      const missing = new Git(exec, new Lane(1), path.join(repo.root, 'no-such-git'));
      const paths = await missing.repoPaths(repo.root);
      expect(paths.ok).toBe(false);
      expect(!paths.ok && paths.failure.kind).toBe('spawn');
    });
  });

  describe('head, branch, and originUrl', () => {
    it('has no head in a repository with no commits', async () => {
      expect(await git.head(repo.root)).toBeUndefined();
    });

    it('returns the commit that HEAD points at', async () => {
      repo.commit('First');
      const second = repo.commit('Second');
      expect(await git.head(repo.root)).toBe(second);
    });

    it('returns the head of a detached checkout', async () => {
      const first = repo.commit('First');
      repo.commit('Second');
      repo.git('checkout', '--quiet', '--detach', first);
      expect(await git.head(repo.root)).toBe(first);
      expect(await git.branch(repo.root)).toBeUndefined();
    });

    it('names the current branch, also before its first commit', async () => {
      expect(await git.branch(repo.root)).toBe('main');
      repo.commit('First');
      repo.git('checkout', '--quiet', '-b', 'feature/login');
      expect(await git.branch(repo.root)).toBe('feature/login');
    });

    it('returns the origin URL, or undefined when there is no origin', async () => {
      expect(await git.originUrl(repo.root)).toBeUndefined();
      repo.git('remote', 'add', 'origin', 'entire://us-east.entire.io/gh/entireio/cli');
      expect(await git.originUrl(repo.root)).toBe('entire://us-east.entire.io/gh/entireio/cli');
    });
  });

  describe('logWindow', () => {
    it('pages through history with skip and count, newest first', async () => {
      const shas = [1, 2, 3, 4, 5].map((n) => repo.commit(`Commit ${n}`));
      const tip = shas[4] ?? '';
      const newestFirst = [...shas].reverse();

      const page = async (skip: number, count: number): Promise<string[]> => {
        const window = await git.logWindow(repo.root, tip, skip, count);
        if (!window.ok) throw new Error(window.failure.message);
        return window.value.map((record) => record.sha);
      };

      expect(await page(0, 2)).toEqual(newestFirst.slice(0, 2));
      expect(await page(2, 2)).toEqual(newestFirst.slice(2, 4));
      expect(await page(4, 2)).toEqual(newestFirst.slice(4));
      expect(await page(5, 2)).toEqual([]);
      expect(await page(0, 100)).toEqual(newestFirst);
    });

    it('includes commits with no checkpoint, so the caller can count what was scanned', async () => {
      repo.commit('No trailer');
      const tip = repo.commit('With trailer', [`Entire-Checkpoint: ${HEX}`]);
      const window = await git.logWindow(repo.root, tip, 0, 10);
      expect(window.ok && window.value.map((record) => record.checkpointIds)).toEqual([[HEX], []]);
    });

    it('starts at the given tip, not at HEAD', async () => {
      const first = repo.commit('First');
      const second = repo.commit('Second');
      repo.commit('Third');
      const window = await git.logWindow(repo.root, second, 0, 10);
      expect(window.ok && window.value.map((record) => record.sha)).toEqual([second, first]);
    });

    it.each(['HEAD', 'main', '', 'abc1234', '--all', `${'a'.repeat(40)} --all`])(
      'refuses the tip %j, which is not a full commit SHA',
      async (tip) => {
        repo.commit('First');
        const window = await git.logWindow(repo.root, tip, 0, 10);
        expect(window.ok).toBe(false);
        expect(!window.ok && window.failure.kind).toBe('unexpectedOutput');
      },
    );

    it('fails for a commit that the repository does not have', async () => {
      repo.commit('First');
      const window = await git.logWindow(repo.root, fakeSha(1), 0, 10);
      expect(window.ok).toBe(false);
      expect(!window.ok && window.failure.kind).toBe('exit');
    });

    it('reports a cancelled call as aborted', async () => {
      const tip = repo.commit('First');
      const window = await git.logWindow(repo.root, tip, 0, 10, AbortSignal.abort());
      expect(window.ok).toBe(false);
      expect(!window.ok && window.failure.kind).toBe('aborted');
    });
  });

  describe('commit', () => {
    it('reads one commit by SHA', async () => {
      const first = repo.commit('First', [`Entire-Checkpoint: ${HEX}`]);
      repo.commit('Second');
      const record = await git.commit(repo.root, first);
      expect(record).toMatchObject({ sha: first, subject: 'First', author: 'Fixture Author', checkpointIds: [HEX] });
    });

    it('returns undefined for a SHA that is unknown or malformed', async () => {
      repo.commit('First');
      expect(await git.commit(repo.root, fakeSha(1))).toBeUndefined();
      expect(await git.commit(repo.root, 'HEAD')).toBeUndefined();
    });
  });

  describe('parent', () => {
    it('has no parent for a root commit', async () => {
      const root = repo.commit('Root');
      expect(await git.parent(repo.root, root)).toBeUndefined();
    });

    it('returns the parent of a later commit', async () => {
      const root = repo.commit('Root');
      const child = repo.commit('Child');
      expect(await git.parent(repo.root, child)).toBe(root);
    });

    it('returns the first parent of a merge commit', async () => {
      repo.commitFiles('Root', { 'a.txt': 'a\n' });
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.commitFiles('Side work', { 'side.txt': 'side\n' });
      repo.git('checkout', '--quiet', 'main');
      const mainTip = repo.commitFiles('Main work', { 'main.txt': 'main\n' });
      repo.git('merge', '--quiet', '--no-ff', 'side', '-m', 'Merge side');
      const merge = repo.git('rev-parse', 'HEAD');
      expect(await git.parent(repo.root, merge)).toBe(mainTip);
    });

    it('returns undefined for a SHA that is unknown or malformed', async () => {
      repo.commit('Root');
      expect(await git.parent(repo.root, fakeSha(1))).toBeUndefined();
      expect(await git.parent(repo.root, 'HEAD')).toBeUndefined();
    });
  });

  describe('isOnRemote', () => {
    it('is false when there are no remote-tracking refs', async () => {
      const tip = repo.commit('First');
      expect(await git.isOnRemote(repo.root, tip)).toBe(false);
    });

    it('is true for a commit that a remote-tracking ref points at or contains', async () => {
      const first = repo.commit('First');
      const second = repo.commit('Second');
      repo.git('update-ref', 'refs/remotes/origin/main', second);
      expect(await git.isOnRemote(repo.root, second)).toBe(true);
      expect(await git.isOnRemote(repo.root, first)).toBe(true);
    });

    it('is false for a commit made after the remote-tracking ref', async () => {
      const pushed = repo.commit('Pushed');
      repo.git('update-ref', 'refs/remotes/origin/main', pushed);
      const local = repo.commit('Local only');
      expect(await git.isOnRemote(repo.root, local)).toBe(false);
    });

    it('does not count local branches and tags', async () => {
      const tip = repo.commit('First');
      repo.git('branch', 'other', tip);
      repo.git('tag', 'v1', tip);
      expect(await git.isOnRemote(repo.root, tip)).toBe(false);
    });

    it('counts a ref of any remote', async () => {
      const tip = repo.commit('First');
      repo.git('update-ref', 'refs/remotes/upstream/feature/x', tip);
      expect(await git.isOnRemote(repo.root, tip)).toBe(true);
    });

    it('is false for a SHA that is unknown or malformed', async () => {
      const tip = repo.commit('First');
      repo.git('update-ref', 'refs/remotes/origin/main', tip);
      expect(await git.isOnRemote(repo.root, fakeSha(1))).toBe(false);
      expect(await git.isOnRemote(repo.root, 'main')).toBe(false);
    });
  });

  describe('commitFiles', () => {
    it('lists added, modified, and deleted files', async () => {
      repo.commitFiles('Add files', { 'keep.txt': 'one\n', 'remove.txt': 'gone soon\n' });
      const sha = repo.commitFiles('Change files', { 'keep.txt': 'two\n', 'remove.txt': null, 'src/new.ts': 'export {};\n' });

      const changes = await git.commitFiles(repo.root, sha);
      expect([...changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { status: 'M', path: 'keep.txt' },
        { status: 'D', path: 'remove.txt' },
        { status: 'A', path: 'src/new.ts' },
      ]);
    });

    it('reports a rename with both paths', async () => {
      const content = Array.from({ length: 20 }, (_, n) => `line ${n}`).join('\n');
      repo.commitFiles('Add a file', { 'docs/old-name.md': content });
      const sha = repo.commitFiles('Rename it', { 'docs/old-name.md': null, 'docs/new-name.md': content });

      expect(await git.commitFiles(repo.root, sha)).toEqual([
        { status: 'R', path: 'docs/new-name.md', oldPath: 'docs/old-name.md' },
      ]);
    });

    it('reports a rename with an edit as a rename', async () => {
      const lines = Array.from({ length: 40 }, (_, n) => `line ${n}`);
      repo.commitFiles('Add a file', { 'old.txt': lines.join('\n') });
      const sha = repo.commitFiles('Rename and edit', { 'old.txt': null, 'new.txt': [...lines, 'one more line'].join('\n') });

      expect(await git.commitFiles(repo.root, sha)).toEqual([{ status: 'R', path: 'new.txt', oldPath: 'old.txt' }]);
    });

    it('lists the files of a root commit as added', async () => {
      const root = repo.commitFiles('Root', { 'a.txt': 'a\n', 'dir/b.txt': 'b\n' });
      const changes = await git.commitFiles(repo.root, root);
      expect([...changes].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
        { status: 'A', path: 'a.txt' },
        { status: 'A', path: 'dir/b.txt' },
      ]);
    });

    it('keeps spaces and non-ASCII characters in paths', async () => {
      const sha = repo.commitFiles('Odd names', { 'my notes/übersicht 1.md': 'x\n' });
      expect(await git.commitFiles(repo.root, sha)).toEqual([{ status: 'A', path: 'my notes/übersicht 1.md' }]);
    });

    it('returns nothing for a commit that changed no files', async () => {
      repo.commitFiles('Root', { 'a.txt': 'a\n' });
      const empty = repo.commit('Empty commit');
      expect(await git.commitFiles(repo.root, empty)).toEqual([]);
    });

    it('returns nothing for a SHA that is unknown or malformed', async () => {
      repo.commitFiles('Root', { 'a.txt': 'a\n' });
      expect(await git.commitFiles(repo.root, fakeSha(1))).toEqual([]);
      expect(await git.commitFiles(repo.root, 'HEAD')).toEqual([]);
    });

    // `git diff-tree <merge>` prints nothing unless it is told how to diff a
    // merge, so a merge commit comes back with no files.
    it('lists what a merge commit changed relative to its first parent', async () => {
      repo.commitFiles('Root', { 'a.txt': 'a\n' });
      repo.git('checkout', '--quiet', '-b', 'side');
      repo.commitFiles('Side work', { 'side.txt': 'side\n' });
      repo.git('checkout', '--quiet', 'main');
      repo.commitFiles('Main work', { 'main.txt': 'main\n' });
      repo.git('merge', '--quiet', '--no-ff', 'side', '-m', 'Merge side');
      const merge = repo.git('rev-parse', 'HEAD');

      expect(await git.commitFiles(repo.root, merge)).toEqual([{ status: 'A', path: 'side.txt' }]);
    });
  });

  describe('blob, exists, and refs', () => {
    const REF = 'refs/entire/checkpoints/45/abcdef012345';

    beforeEach(() => {
      repo.writeRef(REF, {
        'metadata.json': '{"checkpoint_id":"abcdef012345"}',
        '0/transcript.jsonl': 'line one\nline two — with ünïcode\n',
        '0/empty.txt': '',
      });
    });

    it('reads the whole of a short file when asked for its start', async () => {
      const head = await git.blobHead(repo.root, REF, '0/transcript.jsonl', 64 * 1024);
      expect(head?.whole).toBe(true);
      expect(head?.data.toString('utf8')).toBe('line one\nline two — with ünïcode\n');
      expect(await git.blobHead(repo.root, REF, '0/empty.txt', 64 * 1024)).toEqual({ data: Buffer.alloc(0), whole: true });
    });

    it('reads only the start of a long file, and says that it is not the whole', async () => {
      const line = `${'x'.repeat(99)}\n`;
      const big = repo.writeRef('refs/entire/checkpoints/45/big', { 'transcript.jsonl': `first line\n${line.repeat(40_000)}` });
      expect(big).toMatch(/^[0-9a-f]{40}$/);
      const head = await git.blobHead(repo.root, 'refs/entire/checkpoints/45/big', 'transcript.jsonl', 256 * 1024);
      expect(head?.whole).toBe(false);
      // No more than was asked for, and enough to hold the lines at the start.
      expect(head?.data.length).toBeLessThanOrEqual(256 * 1024);
      expect(head?.data.length).toBeGreaterThan(0);
      expect(head?.data.toString('utf8').startsWith('first line\n')).toBe(true);
    });

    it('returns undefined for the start of a file that does not exist', async () => {
      expect(await git.blobHead(repo.root, REF, '0/missing.jsonl', 64 * 1024)).toBeUndefined();
      expect(await git.blobHead(repo.root, 'refs/entire/checkpoints/00/missing', 'metadata.json', 64 * 1024)).toBeUndefined();
    });

    it('reads a file from a tree', async () => {
      const blob = await git.blob(repo.root, REF, '0/transcript.jsonl');
      expect(blob).toBeInstanceOf(Buffer);
      expect(blob?.toString('utf8')).toBe('line one\nline two — with ünïcode\n');
    });

    it('reads an empty file as an empty buffer, not as missing', async () => {
      const blob = await git.blob(repo.root, REF, '0/empty.txt');
      expect(blob).toBeInstanceOf(Buffer);
      expect(blob).toHaveLength(0);
    });

    it('returns undefined for a missing file, a directory, or a missing ref', async () => {
      expect(await git.blob(repo.root, REF, '0/missing.jsonl')).toBeUndefined();
      expect(await git.blob(repo.root, REF, '0')).toBeUndefined();
      expect(await git.blob(repo.root, 'refs/entire/checkpoints/00/missing', 'metadata.json')).toBeUndefined();
    });

    it('returns undefined when the read is cancelled', async () => {
      expect(await git.blob(repo.root, REF, 'metadata.json', AbortSignal.abort())).toBeUndefined();
    });

    it('reads from a commit SHA as well as from a ref', async () => {
      const sha = repo.git('rev-parse', REF);
      expect((await git.blob(repo.root, sha, 'metadata.json'))?.toString('utf8')).toBe('{"checkpoint_id":"abcdef012345"}');
    });

    it('says whether a path exists in a tree', async () => {
      expect(await git.exists(repo.root, REF, 'metadata.json')).toBe(true);
      expect(await git.exists(repo.root, REF, '0/transcript.jsonl')).toBe(true);
      expect(await git.exists(repo.root, REF, '0')).toBe(true);
      expect(await git.exists(repo.root, REF, '1/transcript.jsonl')).toBe(false);
      expect(await git.exists(repo.root, 'refs/heads/missing', 'metadata.json')).toBe(false);
    });

    it('lists the refs that match a pattern', async () => {
      repo.writeRef('refs/entire/checkpoints/1B/01HZXK3M5N7P9R2T4V6W8Y0A1B', { 'metadata.json': '{}' });
      repo.writeRef('refs/remotes/origin/entire/checkpoints/v1', { 'README.md': 'x' });

      expect(await git.refs(repo.root, ['refs/entire/checkpoints/*/abcdef012345'])).toEqual([REF]);
      // The order of the list is not part of the contract.
      expect((await git.refs(repo.root, ['refs/entire/checkpoints/'])).sort()).toEqual(
        [REF, 'refs/entire/checkpoints/1B/01HZXK3M5N7P9R2T4V6W8Y0A1B'].sort(),
      );
      expect(await git.refs(repo.root, ['refs/heads/entire/checkpoints/v1', 'refs/remotes/*/entire/checkpoints/v1'])).toEqual([
        'refs/remotes/origin/entire/checkpoints/v1',
      ]);
    });

    it('returns no refs when nothing matches', async () => {
      expect(await git.refs(repo.root, ['refs/entire/checkpoints/*/ffffffffffff'])).toEqual([]);
      expect(await git.refs(repo.root, ['refs/nothing/'])).toEqual([]);
    });
  });
});

describe('parseNameStatus', () => {
  it('reads plain changes', () => {
    expect(parseNameStatus('M\x00src/a.ts\x00A\x00src/b.ts\x00D\x00old.txt\x00T\x00link\x00')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'A', path: 'src/b.ts' },
      { status: 'D', path: 'old.txt' },
      { status: 'T', path: 'link' },
    ]);
  });

  it('reads renames and copies, which carry a score and two paths', () => {
    expect(parseNameStatus('R100\x00old.txt\x00new.txt\x00C75\x00base.txt\x00copy.txt\x00M\x00other.txt\x00')).toEqual([
      { status: 'R', path: 'new.txt', oldPath: 'old.txt' },
      { status: 'C', path: 'copy.txt', oldPath: 'base.txt' },
      { status: 'M', path: 'other.txt' },
    ]);
  });

  it('keeps paths with spaces, newlines, and non-ASCII characters', () => {
    expect(parseNameStatus('A\x00my notes/übersicht 1.md\x00A\x00odd\nname.txt\x00')).toEqual([
      { status: 'A', path: 'my notes/übersicht 1.md' },
      { status: 'A', path: 'odd\nname.txt' },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseNameStatus('')).toEqual([]);
  });

  it('ignores a record that is cut off', () => {
    expect(parseNameStatus('M\x00a.txt\x00R100\x00old.txt')).toEqual([{ status: 'M', path: 'a.txt' }]);
  });
});
