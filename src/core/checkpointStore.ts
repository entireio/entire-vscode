import type { Git } from './git';
import { isCheckpointId } from './trailers';
import { parseCompactTranscript } from './transcript/normalize';
import { openingPrompt } from './transcript/prompts';

/**
 * Where a checkpoint's files live in git.
 *
 * This is the only module that knows the on-disk checkpoint layout. The
 * extension reads it for one reason: the normalized transcript
 * (`transcript.jsonl`) is stored there and no CLI command outputs it. The
 * transcript is read whole to show it, and its first lines are read to name
 * a session by its opening prompt. Every reader returns undefined on any
 * surprise, and callers fall back to the CLI.
 */
export interface CheckpointTree {
  /** A ref whose tree contains the checkpoint. */
  treeish: string;
  /** Directory of the checkpoint inside that tree, with a trailing slash, or empty. */
  prefix: string;
}

export interface StoredSession {
  index: number;
  /** Path of `transcript.jsonl` from the tree root. Absent when none was stored. */
  compactTranscriptPath?: string;
  metadataPath?: string;
}

/** The first prompt of a stored transcript. */
export interface OpeningPrompt {
  text: string;
  /** The transcript holds the session from its start, so this prompt is the one that opened the session. */
  fromSessionStart: boolean;
}

export interface StoredSessionMeta {
  /** The session the slot belongs to. A checkpoint can hold several. */
  sessionId?: string;
  /**
   * 0-based line in `transcript.jsonl` where this checkpoint's portion begins.
   * Null or absent means the file holds only this checkpoint's portion.
   */
  compactTranscriptStart?: number | null;
}

const LEGACY_BRANCH_PATTERNS = ['refs/heads/entire/checkpoints/v1', 'refs/remotes/*/entire/checkpoints/v1'];
/**
 * How much of a transcript is read to find the prompt that opens it. In 219
 * sessions of two real repositories that prompt ended within 3 KB of the
 * start. This leaves room for a long one, and for a pasted document.
 */
const OPENING_BYTES = 256 * 1024;

/** Turns a stored path such as `/0/transcript.jsonl` into a safe tree-relative path. */
export function safeTreePath(stored: unknown): string | undefined {
  if (typeof stored !== 'string') return undefined;
  const relative = stored.replace(/^\/+/, '');
  if (relative === '' || !/^[\w./-]+$/.test(relative)) return undefined;
  if (relative.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')) return undefined;
  return relative;
}

function parseJson(buffer: Buffer | undefined): Record<string, unknown> | undefined {
  if (!buffer) return undefined;
  try {
    const value: unknown = JSON.parse(buffer.toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export class CheckpointStore {
  constructor(private readonly git: Git) {}

  /**
   * Finds the checkpoint in the local clone.
   *
   * The git-refs backend keeps one ref per checkpoint at
   * `refs/entire/checkpoints/<shard>/<id>`, and that ref's tree is the
   * checkpoint. The legacy backend keeps every checkpoint in the
   * `entire/checkpoints/v1` branch under `<id[:2]>/<id[2:]>/`; a clone often
   * has only the remote-tracking copy of that branch.
   */
  async locate(cwd: string, checkpointId: string): Promise<CheckpointTree | undefined> {
    if (!isCheckpointId(checkpointId)) return undefined;

    const [ref] = await this.git.refs(cwd, [`refs/entire/checkpoints/*/${checkpointId}`]);
    if (ref) return { treeish: ref, prefix: '' };

    const prefix = `${checkpointId.slice(0, 2)}/${checkpointId.slice(2)}/`;
    for (const branch of await this.git.refs(cwd, LEGACY_BRANCH_PATTERNS)) {
      if (await this.git.exists(cwd, branch, `${prefix}metadata.json`)) return { treeish: branch, prefix };
    }
    return undefined;
  }

  /** Session slots listed in the checkpoint's root `metadata.json`. */
  async sessions(cwd: string, tree: CheckpointTree): Promise<StoredSession[]> {
    const root = parseJson(await this.git.blob(cwd, tree.treeish, `${tree.prefix}metadata.json`));
    if (!root || !Array.isArray(root.sessions)) return [];
    return root.sessions.map((entry: unknown, index): StoredSession => {
      const session: StoredSession = { index };
      if (typeof entry !== 'object' || entry === null) return session;
      const paths = entry as Record<string, unknown>;
      // Stored paths are relative to the tree root and already include the prefix.
      const compact = safeTreePath(paths.compact_transcript);
      const metadata = safeTreePath(paths.metadata);
      if (compact) session.compactTranscriptPath = compact;
      if (metadata) session.metadataPath = metadata;
      return session;
    });
  }

  async sessionMeta(cwd: string, tree: CheckpointTree, session: StoredSession): Promise<StoredSessionMeta | undefined> {
    if (!session.metadataPath) return undefined;
    const meta = parseJson(await this.git.blob(cwd, tree.treeish, session.metadataPath));
    if (!meta) return undefined;
    const found: StoredSessionMeta = {};
    if (typeof meta.session_id === 'string' && meta.session_id !== '') found.sessionId = meta.session_id;
    const start = meta.compact_transcript_start;
    if (start === null) found.compactTranscriptStart = null;
    else if (typeof start === 'number' && Number.isInteger(start) && start >= 0) found.compactTranscriptStart = start;
    return found;
  }

  /**
   * The first prompt in the transcript that a checkpoint stores for a
   * session, read from the start of the file. Undefined when the checkpoint
   * stores no normalized transcript for the session.
   *
   * Most transcripts hold the whole conversation up to the checkpoint, and
   * say where the checkpoint's own part begins. Their first prompt opens the
   * session, so every checkpoint of the session gives the same one, and
   * `fromSessionStart` is true. An older transcript holds only its
   * checkpoint's part. Its first prompt opens the session only if the
   * checkpoint is the session's first, which the caller has to know.
   */
  async openingPrompt(
    cwd: string,
    tree: CheckpointTree,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<OpeningPrompt | undefined> {
    // Each slot's metadata names its session. A checkpoint can hold several.
    let found: { slot: StoredSession; meta: StoredSessionMeta } | undefined;
    for (const slot of await this.sessions(cwd, tree)) {
      const meta = await this.sessionMeta(cwd, tree, slot);
      if (meta?.sessionId === sessionId) {
        found = { slot, meta };
        break;
      }
    }
    if (!found?.slot.compactTranscriptPath) return undefined;
    const head = await this.git.blobHead(cwd, tree.treeish, found.slot.compactTranscriptPath, OPENING_BYTES, signal);
    if (!head) return undefined;
    const text = head.data.toString('utf8');
    // A cut goes through a line. Everything up to the last line break is whole.
    const lines = head.whole ? text : text.slice(0, text.lastIndexOf('\n') + 1);
    const prompt = openingPrompt(parseCompactTranscript(lines, null).turns);
    return prompt === undefined
      ? undefined
      : { text: prompt, fromSessionStart: typeof found.meta.compactTranscriptStart === 'number' };
  }

  /** The normalized transcript of one session, or undefined when none was stored. */
  async compactTranscript(
    cwd: string,
    tree: CheckpointTree,
    session: StoredSession,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (!session.compactTranscriptPath) return undefined;
    const buffer = await this.git.blob(cwd, tree.treeish, session.compactTranscriptPath, signal);
    return buffer?.toString('utf8');
  }

  /**
   * An image that the CLI moved out of the transcript, addressed by a
   * placeholder such as `entire-asset:assets/img-ab12.png`. Assets sit beside
   * the session's transcript.
   */
  async asset(cwd: string, tree: CheckpointTree, session: StoredSession, assetPath: string): Promise<Buffer | undefined> {
    const relative = safeTreePath(assetPath);
    const anchor = session.compactTranscriptPath ?? session.metadataPath;
    if (!relative || !relative.startsWith('assets/') || !anchor) return undefined;
    const sessionDir = anchor.slice(0, anchor.lastIndexOf('/') + 1);
    return this.git.blob(cwd, tree.treeish, `${sessionDir}${relative}`);
  }
}
