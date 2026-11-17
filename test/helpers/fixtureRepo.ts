import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Builds throwaway git repositories that hold Entire checkpoint data, using
 * git plumbing only. Tests read them with the real `git`, so no Entire
 * install is needed.
 */
export interface FixtureRepo {
  root: string;
  /** Runs git in the repository and returns trimmed stdout. */
  git(...args: string[]): string;
  /** Creates an empty commit whose message ends with the given trailer lines. */
  commit(subject: string, trailers?: string[]): string;
  /** Writes files into the working tree and commits them. A null value deletes the file. */
  commitFiles(subject: string, files: Record<string, string | null>, trailers?: string[]): string;
  /**
   * Adds one empty commit per message on top of HEAD, oldest first, in a
   * single `git fast-import` run. Use it for histories of thousands of commits.
   * Returns the new tip.
   */
  bulkCommits(messages: string[]): string;
  /** Points `ref` at a new parentless commit whose tree holds `files`. */
  writeRef(ref: string, files: Record<string, string>): string;
  /** Stores a checkpoint the way the git-refs backend does: one ref per checkpoint. */
  addRefCheckpoint(checkpointId: string, files: Record<string, string>, shard?: string): string;
  /** Stores checkpoints the way the legacy backend does: one branch, sharded by ID prefix. */
  addLegacyCheckpoints(ref: string, checkpoints: Record<string, Record<string, string>>): string;
  dispose(): void;
}

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture Author',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  // Ignore the developer's own git configuration, such as commit signing.
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

export function createFixtureRepo(): FixtureRepo {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-fixture-')));
  let clock = 1_700_000_000;

  const run = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, ...IDENTITY, ...options.env },
      ...(options.input === undefined ? {} : { input: options.input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

  const stamp = (): NodeJS.ProcessEnv => {
    clock += 60;
    return { GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` };
  };

  run(['init', '--quiet', '--initial-branch=main']);

  const writeRef = (ref: string, files: Record<string, string>): string => {
    const indexFile = path.join(root, '.git', `fixture-index-${Math.random().toString(16).slice(2)}`);
    const env = { GIT_INDEX_FILE: indexFile };
    for (const [filePath, content] of Object.entries(files)) {
      const blob = run(['hash-object', '-w', '--stdin'], { input: content });
      run(['update-index', '--add', '--cacheinfo', `100644,${blob},${filePath}`], { env });
    }
    const tree = run(['write-tree'], { env });
    rmSync(indexFile, { force: true });
    const commit = run(['commit-tree', tree, '-m', `Checkpoint data for ${ref}`], { env: stamp() });
    run(['update-ref', ref, commit]);
    return commit;
  };

  return {
    root,
    git: (...args) => run(args),
    commit(subject, trailers = []) {
      const message = trailers.length > 0 ? `${subject}\n\n${trailers.join('\n')}\n` : subject;
      run(['commit', '--quiet', '--allow-empty', '-m', message], { env: stamp() });
      return run(['rev-parse', 'HEAD']);
    },
    commitFiles(subject, files, trailers = []) {
      for (const [filePath, content] of Object.entries(files)) {
        const absolute = path.join(root, filePath);
        if (content === null) {
          rmSync(absolute, { force: true });
        } else {
          mkdirSync(path.dirname(absolute), { recursive: true });
          writeFileSync(absolute, content);
        }
      }
      run(['add', '--all']);
      const message = trailers.length > 0 ? `${subject}\n\n${trailers.join('\n')}\n` : subject;
      run(['commit', '--quiet', '-m', message], { env: stamp() });
      return run(['rev-parse', 'HEAD']);
    },
    bulkCommits(messages) {
      if (messages.length === 0) return run(['rev-parse', 'HEAD']);
      let parent: string | undefined;
      try {
        parent = run(['rev-parse', '--verify', '-q', 'HEAD']);
      } catch {
        parent = undefined;
      }
      const person = `${IDENTITY.GIT_AUTHOR_NAME} <${IDENTITY.GIT_AUTHOR_EMAIL}>`;
      const stream: string[] = [];
      messages.forEach((text, position) => {
        clock += 60;
        const mark = position + 1;
        const from = position === 0 ? parent : `:${position}`;
        stream.push(
          'commit refs/heads/main',
          `mark :${mark}`,
          `author ${person} ${clock} +0000`,
          `committer ${person} ${clock} +0000`,
          `data ${Buffer.byteLength(text)}`,
          text,
          ...(from ? [`from ${from}`] : []),
          '',
        );
      });
      run(['fast-import', '--quiet', '--date-format=raw'], { input: `${stream.join('\n')}\n` });
      return run(['rev-parse', 'HEAD']);
    },
    writeRef,
    addRefCheckpoint(checkpointId, files, shard = checkpointId.slice(-2)) {
      return writeRef(`refs/entire/checkpoints/${shard}/${checkpointId}`, files);
    },
    addLegacyCheckpoints(ref, checkpoints) {
      const files: Record<string, string> = {};
      for (const [checkpointId, entries] of Object.entries(checkpoints)) {
        const prefix = `${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}/`;
        for (const [filePath, content] of Object.entries(entries)) files[`${prefix}${filePath}`] = content;
      }
      return writeRef(ref, files);
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One line of the Entire Transcript Format v1. */
export function transcriptLine(type: 'user' | 'assistant', content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ v: 1, agent: 'claude-code', type, ts: '2026-01-02T03:04:05Z', content, ...extra });
}

/**
 * Files for a checkpoint with one session per entry. A session with
 * `transcript` gets a `transcript.jsonl` and a `compact_transcript` path in
 * the root metadata; a session without one gets neither, like sessions from
 * agents that have no normalized transcript.
 *
 * `prefix` is the checkpoint's directory inside its tree: empty for the
 * git-refs backend, `<id[:2]>/<id[2:]>/` for the legacy branch. Stored paths
 * are relative to the tree root, so they include it.
 */
export function checkpointFiles(
  checkpointId: string,
  sessions: { transcript?: string[]; start?: number | null; agent?: string }[],
  prefix = '',
): Record<string, string> {
  const files: Record<string, string> = {};
  const entries = sessions.map((session, index) => {
    const dir = `${index}/`;
    const stored = `/${prefix}${dir}`;
    files[`${dir}metadata.json`] = JSON.stringify({
      checkpoint_id: checkpointId,
      session_id: `session-${index}`,
      agent: session.agent ?? 'Claude Code',
      ...(session.start === undefined ? {} : { compact_transcript_start: session.start }),
    });
    files[`${dir}full.jsonl`] = '{"type":"raw"}\n';
    const entry: Record<string, string> = {
      metadata: `${stored}metadata.json`,
      transcript: `${stored}full.jsonl`,
    };
    if (session.transcript) {
      files[`${dir}transcript.jsonl`] = `${session.transcript.join('\n')}\n`;
      entry.compact_transcript = `${stored}transcript.jsonl`;
    }
    return entry;
  });
  files['metadata.json'] = JSON.stringify({ checkpoint_id: checkpointId, sessions: entries });
  return files;
}
