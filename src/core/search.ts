/**
 * Search over checkpoints, sessions, and trails.
 *
 * Two sources answer a search. Entire's search service, through
 * `entire search --json`, ranks the checkpoints, commits, and sessions it
 * holds for the repository. The extension also matches what it has already
 * read: the commits and checkpoints of the branch, the sessions it knows,
 * and the trails. Trails have no search command, so they are only ever
 * matched here.
 */
import type { TrailSummary } from './schemas';
import { isCheckpointId, isCommitSha, isSessionId, parseCheckpointIds } from './trailers';

/** What a search looks through. A search with no scope looks through all three. */
export type SearchScope = 'checkpoints' | 'sessions' | 'trails';

export const SEARCH_SCOPES: readonly SearchScope[] = ['checkpoints', 'sessions', 'trails'];

export function readSearchScope(value: unknown): SearchScope | undefined {
  return typeof value === 'string' && (SEARCH_SCOPES as readonly string[]).includes(value)
    ? (value as SearchScope)
    : undefined;
}

/** A commit that Entire's search found. Its message names the checkpoints it carries. */
export interface CommitHit {
  kind: 'commit';
  sha: string;
  subject: string;
  checkpointIds: string[];
  branch?: string;
  author?: string;
  /** ISO time. */
  createdAt?: string;
}

/** A session that Entire's search found, with the checkpoint whose transcript matched. */
export interface SessionHit {
  kind: 'session';
  sessionId: string;
  checkpointId?: string;
  /** The name Entire gave the session. */
  name?: string;
  /** The prompt that opened it. */
  prompt?: string;
  agent?: string;
  branch?: string;
  author?: string;
  createdAt?: string;
  /** The part of the transcript that matched, on one line. */
  snippet?: string;
}

/** A checkpoint that Entire's search found. Read with care: the service has not returned one in testing. */
export interface CheckpointHit {
  kind: 'checkpoint';
  checkpointId: string;
  title?: string;
  sessionId?: string;
  commitSha?: string;
  branch?: string;
  agent?: string;
  author?: string;
  createdAt?: string;
  snippet?: string;
}

export type SearchHit = CommitHit | SessionHit | CheckpointHit;

/** One page of `entire search --json`, best match first. */
export interface SearchPage {
  hits: SearchHit[];
  /** How many results the service has in all, when it says. */
  total?: number;
}

/** Longest query the extension passes to the CLI. */
const MAX_QUERY = 500;

/**
 * The query to pass to `entire search`, or undefined when there is none. It
 * is trimmed, and it has no control characters, so it is one argument on one
 * line. The caller passes it after `--`, so a query that starts with a dash
 * is never read as a flag.
 */
export function searchQuery(text: string): string | undefined {
  const query = text.trim();
  if (query === '' || query.length > MAX_QUERY) return undefined;
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(query) ? undefined : query;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Text on one line, with runs of white space as one space. */
export function oneLine(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/g, ' ').trim();
  return line === '' ? undefined : line;
}

/** Copies only the defined entries, so optional fields stay absent instead of `undefined`. */
function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

function readHit(type: string | undefined, data: Json, snippet: string | undefined): SearchHit | undefined {
  if (type === 'commit') {
    const sha = str(data.commitSha) ?? str(data.id);
    if (!sha || !isCommitSha(sha)) return undefined;
    const message = str(data.commitMessage) ?? '';
    return compact<CommitHit>({
      kind: 'commit',
      sha,
      subject: str(data.commitSubject) ?? oneLine(message.split('\n')[0]) ?? sha.slice(0, 7),
      checkpointIds: parseCheckpointIds(message),
      branch: str(data.branch),
      author: str(data.author) ?? str(data.authorUsername),
      createdAt: str(data.createdAt),
    });
  }
  if (type === 'session') {
    const sessionId = str(data.sessionId) ?? str(data.id);
    if (!sessionId || !isSessionId(sessionId)) return undefined;
    const checkpointId = str(data.matchedCheckpointId) ?? str(data.checkpointId);
    return compact<SessionHit>({
      kind: 'session',
      sessionId,
      checkpointId: checkpointId && isCheckpointId(checkpointId) ? checkpointId : undefined,
      name: oneLine(str(data.displayName) ?? str(data.name)),
      prompt: oneLine(str(data.prompt)),
      agent: str(data.agent),
      branch: str(data.branch),
      author: str(data.authorUsername) ?? str(data.author),
      createdAt: str(data.createdAt),
      snippet,
    });
  }
  if (type === 'checkpoint') {
    const checkpointId = str(data.checkpointId) ?? str(data.id);
    if (!checkpointId || !isCheckpointId(checkpointId)) return undefined;
    const sessionId = str(data.sessionId);
    const commitSha = str(data.commitSha);
    return compact<CheckpointHit>({
      kind: 'checkpoint',
      checkpointId,
      title: oneLine(str(data.title) ?? str(data.displayName) ?? str(data.commitSubject) ?? str(data.prompt)),
      sessionId: sessionId && isSessionId(sessionId) ? sessionId : undefined,
      commitSha: commitSha && isCommitSha(commitSha) ? commitSha : undefined,
      branch: str(data.branch),
      agent: str(data.agent),
      author: str(data.authorUsername) ?? str(data.author),
      createdAt: str(data.createdAt),
      snippet,
    });
  }
  // Pull requests and repositories are not things the extension can open.
  return undefined;
}

/**
 * Reads `entire search --json`. Each result is a `type` and its `data`, and
 * the reader keeps the commits, sessions, and checkpoints whose IDs it can
 * check, in the order the service ranked them. Anything else is skipped.
 */
export function readSearchPage(value: unknown): SearchPage | undefined {
  if (!isObject(value) || !Array.isArray(value.results)) return undefined;
  const hits: SearchHit[] = [];
  for (const result of value.results) {
    if (!isObject(result) || !isObject(result.data)) continue;
    const meta = isObject(result.searchMeta) ? result.searchMeta : {};
    const hit = readHit(str(result.type), result.data, oneLine(str(meta.snippet)));
    if (hit) hits.push(hit);
  }
  const total = typeof value.total === 'number' && Number.isInteger(value.total) && value.total >= 0 ? value.total : undefined;
  return total === undefined ? { hits } : { hits, total };
}

/** A query as the local matcher reads it. */
export interface SearchTerms {
  /** Lower-case words, every one of which has to appear. */
  words: string[];
  /** From `branch:<name>`: only rows on a branch whose name contains this. */
  branch?: string;
}

/** The inline filters that Entire's search understands. The local matcher reads `branch` and skips the rest. */
const FILTERS = new Set(['author', 'branch', 'date', 'repo']);

export function searchTerms(query: string): SearchTerms {
  const terms: SearchTerms = { words: [] };
  for (const token of query.toLowerCase().split(/\s+/)) {
    if (token === '') continue;
    const filter = /^([a-z]+):(.*)$/.exec(token);
    if (filter && FILTERS.has(filter[1] ?? '')) {
      if (filter[1] === 'branch' && filter[2]) terms.branch = filter[2];
      continue;
    }
    terms.words.push(token);
  }
  return terms;
}

/**
 * Whether the local matcher has anything to go on. A query of filters that
 * only Entire's search reads, such as `author:alice`, matches nothing here
 * rather than everything.
 */
export function hasLocalTerms(terms: SearchTerms): boolean {
  return terms.words.length > 0 || terms.branch !== undefined;
}

/** Whether every word appears in one of the fields, and the branch passes a `branch:` filter. */
export function matchesTerms(terms: SearchTerms, fields: readonly (string | undefined)[], branch?: string): boolean {
  if (!hasLocalTerms(terms)) return false;
  if (terms.branch !== undefined && !(branch ?? '').toLowerCase().includes(terms.branch)) return false;
  const haystack = fields
    .filter((field): field is string => !!field)
    .join('\n')
    .toLowerCase();
  return terms.words.every((word) => haystack.includes(word));
}

/**
 * Whether a trail matches. A word such as `#2923` or `2923` matches the
 * trail's number. The other words are looked for in its title, description,
 * status, phase, and type, and in the branch and title of each change.
 */
export function trailMatches(terms: SearchTerms, trail: TrailSummary): boolean {
  if (!hasLocalTerms(terms)) return false;
  const number = String(trail.number);
  const words = terms.words.filter((word) => word.replace(/^#/, '') !== number);
  if (terms.branch !== undefined) {
    const wanted = terms.branch;
    if (!trail.changes.some((change) => (change.branch ?? '').toLowerCase().includes(wanted))) return false;
  }
  const fields = [
    trail.title,
    trail.body,
    trail.status,
    trail.phase,
    trail.type,
    ...trail.changes.flatMap((change) => [change.branch, change.title, change.repository]),
  ];
  const haystack = fields
    .filter((field): field is string => !!field)
    .join('\n')
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}
