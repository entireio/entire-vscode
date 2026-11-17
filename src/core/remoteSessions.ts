/**
 * A repository's sessions as Entire lists them, which is what the Sessions
 * page of entire.com shows: each session with the name Entire gave it, its
 * agent and model, and how many checkpoints it has.
 *
 * They are read through `entire api`, the CLI's authenticated GET. The CLI
 * calls these endpoints internal and says their shape can change without
 * notice, so the readers here take what they recognize, and every caller
 * falls back to what the clone knows when a read fails.
 */
import { isCheckpointId } from './trailers';

/** Sessions Entire returns for one call. Its own default, and what one page of the Sessions view shows. */
export const REMOTE_SESSIONS_PAGE = 50;

export interface RemoteSession {
  sessionId: string;
  /** The name entire.com shows: one a person set, or else the title Entire wrote for the session. */
  name?: string;
  agent?: string;
  model?: string;
  /** How many checkpoints Entire counts for the session. */
  checkpointCount?: number;
  startedAt?: string;
  lastActivityAt?: string;
  /** The prompt that opened the session. */
  prompt?: string;
}

/** One page of a repository's sessions, most recent activity first. */
export interface RemoteSessionPage {
  sessions: RemoteSession[];
  /** Asks for the page after this one. Absent on the last page. */
  nextCursor?: string;
}

/** A checkpoint of a session, as the session's page on entire.com lists it. */
export interface RemoteCheckpoint {
  checkpointId: string;
  commitSha?: string;
  /** The subject of the commit that carries the checkpoint. */
  message?: string;
  date?: string;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The path of one page of the repository's sessions, on every branch. `{repo_id}` is the CLI's to fill in. */
export function remoteSessionsPath(limit: number, cursor?: string): string {
  const after = cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`;
  return `/api/v1/repos/{repo_id}/sessions?scope=all&limit=${limit}${after}`;
}

/**
 * The path that lists a session's checkpoints. Entire has no lighter one: the
 * list comes with the session's transcript, which the caller throws away.
 */
export function remoteSessionCheckpointsPath(sessionId: string): string {
  return `/api/v1/repos/{repo_id}/sessions/${encodeURIComponent(sessionId)}/transcript`;
}

export function readRemoteSessionPage(value: unknown): RemoteSessionPage | undefined {
  if (!isObject(value) || !Array.isArray(value.sessions)) return undefined;
  const sessions: RemoteSession[] = [];
  const seen = new Set<string>();
  for (const item of value.sessions) {
    if (!isObject(item)) continue;
    const sessionId = text(item.sessionId);
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const session: RemoteSession = { sessionId };
    // A name a person set comes back as the display name too. Read it first in case it one day does not.
    const name = text(item.customName) ?? text(item.displayName);
    if (name) session.name = name;
    const agent = text(item.agent);
    if (agent) session.agent = agent;
    const model = text(item.model);
    if (model) session.model = model;
    const checkpointCount = count(item.checkpointCount);
    if (checkpointCount !== undefined) session.checkpointCount = checkpointCount;
    const startedAt = text(item.startedAt);
    if (startedAt) session.startedAt = startedAt;
    const lastActivityAt = text(item.lastActivityAt);
    if (lastActivityAt) session.lastActivityAt = lastActivityAt;
    const prompt = text(item.prompt);
    if (prompt) session.prompt = prompt;
    sessions.push(session);
  }
  const page: RemoteSessionPage = { sessions };
  const nextCursor = text(value.next_cursor);
  if (nextCursor) page.nextCursor = nextCursor;
  return page;
}

/** The checkpoints in a session's transcript reply, newest first. */
export function readRemoteCheckpoints(value: unknown): RemoteCheckpoint[] | undefined {
  if (!isObject(value) || !Array.isArray(value.checkpoints)) return undefined;
  const checkpoints: RemoteCheckpoint[] = [];
  const seen = new Set<string>();
  for (const item of value.checkpoints) {
    if (!isObject(item)) continue;
    const checkpointId = text(item.checkpointId);
    if (!checkpointId || !isCheckpointId(checkpointId) || seen.has(checkpointId)) continue;
    seen.add(checkpointId);
    const checkpoint: RemoteCheckpoint = { checkpointId };
    const commitSha = text(item.commitSha);
    if (commitSha && /^[0-9a-f]{7,64}$/i.test(commitSha)) checkpoint.commitSha = commitSha;
    const subject = text(item.message)?.split('\n')[0]?.trim();
    if (subject) checkpoint.message = subject;
    const date = text(item.timestamp);
    if (date) checkpoint.date = date;
    checkpoints.push(checkpoint);
  }
  const instant = (date?: string): number => (date ? Date.parse(date) : 0) || 0;
  return checkpoints.sort((a, b) => instant(b.date) - instant(a.date));
}

/** What the API said when it refused a call. It answers a refusal with a small JSON object. */
export function remoteRefusal(output: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isObject(value)) return undefined;
  const said = [value.error, value.detail, value.title, value.message].map(text).filter((part) => part !== undefined);
  return said.length > 0 ? said.join(': ').slice(0, 400) : undefined;
}
