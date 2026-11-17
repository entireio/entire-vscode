import type { CheckpointRow } from './schemas';
import type { CommitRecord } from './trailers';

/** Commits scanned per `git log` call. */
export const WINDOW_SIZE = 2000;
/** Rows a view shows per page, and how many more linked commits one page of scanning looks for. */
export const PAGE_SIZE = 50;
/** Upper bound on windows per page, so a repo with no linked commits stops scanning. */
export const MAX_WINDOWS_PER_PAGE = 10;
/** How many checkpoint rows to ask the Entire CLI for. */
export const LIST_LIMIT = 500;
/** How many commits of the current branch the Entire CLI walks when it lists checkpoints. */
const CLI_SCAN_DEPTH = 500;
/** A list whose oldest commit lies past this share of the CLI's walk is taken to have hit its limit. */
const EDGE_FRACTION = 0.8;
/** Sessions on this many of the oldest listed commits count as being at the edge of the list. */
const EDGE_COMMITS = 5;

export interface SessionCheckpoint {
  checkpointId: string;
  date?: string;
  message?: string;
}

/** A session as seen through the checkpoints that reference it. */
export interface IndexedSession {
  sessionId: string;
  agent?: string;
  /** Newest first. */
  checkpoints: SessionCheckpoint[];
  lastDate?: string;
  /** See {@link SessionPosition.mayHaveEarlier}. */
  mayHaveEarlier: boolean;
}

/** Where one checkpoint sits among the checkpoints of a session. */
export interface SessionPosition {
  /** 1 for the oldest checkpoint of the session that the CLI lists. */
  ordinal: number;
  /** How many checkpoints of the session the CLI lists. */
  total: number;
  /**
   * The session may have checkpoints older than the listed ones, which makes
   * `total` a lower bound and `ordinal` a count from the oldest listed one.
   */
  mayHaveEarlier: boolean;
  /** The session's checkpoint just before this one, if the CLI lists it. */
  previous?: string;
  /** The session's checkpoint just after this one. */
  next?: string;
}

/**
 * The commit-to-checkpoint map for one branch tip.
 *
 * Git history is the source of truth for which commits carry checkpoints.
 * Rows from the Entire CLI are joined on by checkpoint ID and only add detail
 * such as the agent and the sessions.
 */
export class CheckpointIndex {
  /** Commits that carry at least one checkpoint, newest first. */
  readonly commits: CommitRecord[] = [];
  /** How many commits of history have been scanned, linked or not. */
  scanned = 0;
  /** True once the scan has reached the root commit. */
  exhausted = false;

  private readonly byCheckpoint = new Map<string, CommitRecord[]>();
  /** How many commits lie between the branch tip and each linked commit. */
  private readonly depths = new Map<string, number>();
  private rows = new Map<string, CheckpointRow>();
  /** Derived from the rows and commits, and rebuilt when either changes. */
  private sessionCache?: { list: IndexedSession[]; byId: Map<string, IndexedSession> };

  constructor(readonly tipSha: string) {}

  /** Adds one scanned window and returns how many linked commits it contained. */
  addWindow(records: CommitRecord[], requested: number): number {
    let added = 0;
    records.forEach((record, offset) => {
      if (record.checkpointIds.length === 0) return;
      this.commits.push(record);
      this.depths.set(record.sha, this.scanned + offset);
      added += 1;
      for (const id of record.checkpointIds) {
        const commits = this.byCheckpoint.get(id);
        if (commits) commits.push(record);
        else this.byCheckpoint.set(id, [record]);
      }
    });
    this.scanned += records.length;
    if (records.length < requested) this.exhausted = true;
    this.sessionCache = undefined;
    return added;
  }

  setRows(rows: CheckpointRow[]): void {
    this.rows = new Map(rows.map((row) => [row.checkpointId, row]));
    this.sessionCache = undefined;
  }

  row(checkpointId: string): CheckpointRow | undefined {
    return this.rows.get(checkpointId);
  }

  allRows(): CheckpointRow[] {
    return [...this.rows.values()];
  }

  /** Every scanned commit that carries the checkpoint, newest first. */
  commitsFor(checkpointId: string): CommitRecord[] {
    return this.byCheckpoint.get(checkpointId) ?? [];
  }

  /** CLI rows whose checkpoint is on no scanned commit: imported, or on another branch. */
  unlinkedRows(): CheckpointRow[] {
    return [...this.rows.values()].filter((row) => !this.byCheckpoint.has(row.checkpointId));
  }

  /** Sessions referenced by the CLI rows, most recently checkpointed first. */
  sessions(): IndexedSession[] {
    return this.sessionIndex().list;
  }

  /**
   * Where a checkpoint sits in one of its sessions, or undefined when the CLI
   * rows do not place it there.
   */
  position(sessionId: string, checkpointId: string): SessionPosition | undefined {
    const session = this.sessionIndex().byId.get(sessionId);
    if (!session) return undefined;
    // `checkpoints` is newest first, so the one after it in the list is the one before it in time.
    const at = session.checkpoints.findIndex((checkpoint) => checkpoint.checkpointId === checkpointId);
    if (at < 0) return undefined;
    const position: SessionPosition = {
      ordinal: session.checkpoints.length - at,
      total: session.checkpoints.length,
      mayHaveEarlier: session.mayHaveEarlier,
    };
    const previous = session.checkpoints[at + 1]?.checkpointId;
    const next = session.checkpoints[at - 1]?.checkpointId;
    if (previous) position.previous = previous;
    if (next) position.next = next;
    return position;
  }

  private sessionIndex(): { list: IndexedSession[]; byId: Map<string, IndexedSession> } {
    if (this.sessionCache) return this.sessionCache;
    const edge = this.sessionsAtTheEdge();
    const byId = new Map<string, IndexedSession>();
    for (const row of this.rows.values()) {
      for (const sessionId of row.sessionIds) {
        let session = byId.get(sessionId);
        if (!session) {
          session = { sessionId, checkpoints: [], mayHaveEarlier: edge.has(sessionId) };
          byId.set(sessionId, session);
        }
        const entry: SessionCheckpoint = { checkpointId: row.checkpointId };
        if (row.date) entry.date = row.date;
        if (row.message) entry.message = row.message;
        session.checkpoints.push(entry);
        // A row's agent describes its primary session only.
        if (row.agent && row.sessionId === sessionId) session.agent = row.agent;
      }
    }
    // Compare instants, not text: the CLI's dates can carry different UTC offsets.
    const instant = (date?: string): number => (date ? Date.parse(date) : 0) || 0;
    const byDateDesc = (a?: string, b?: string): number => instant(b) - instant(a);
    for (const session of byId.values()) {
      session.checkpoints.sort((a, b) => byDateDesc(a.date, b.date));
      const newest = session.checkpoints[0]?.date;
      if (newest) session.lastDate = newest;
    }
    const list = [...byId.values()].sort((a, b) => byDateDesc(a.lastDate, b.lastDate));
    this.sessionCache = { list, byId };
    return this.sessionCache;
  }

  /**
   * Sessions that may have checkpoints older than the ones the CLI listed.
   *
   * The CLI lists the checkpoints of the newest 500 commits of the current
   * branch. On a feature branch it stops at the branch point, far short of
   * that. When the oldest commit it listed lies near that limit and history
   * goes on beyond it, a session on those oldest commits may have begun
   * earlier. This is inferred from the limit, since the CLI does not say
   * whether it stopped early, so it errs toward marking a session open-ended.
   */
  private sessionsAtTheEdge(): Set<string> {
    const edge = new Set<string>();
    const listed = this.commits.filter((commit) => commit.checkpointIds.some((id) => this.rows.has(id)));
    const oldest = listed.at(-1);
    if (!oldest) return edge;
    const hitLimit =
      (this.depths.get(oldest.sha) ?? 0) >= CLI_SCAN_DEPTH * EDGE_FRACTION || this.rows.size >= LIST_LIMIT;
    const historyBeyond = !this.exhausted || this.commits.at(-1) !== oldest;
    if (!hitLimit || !historyBeyond) return edge;
    for (const commit of listed.slice(-EDGE_COMMITS)) {
      for (const id of commit.checkpointIds) {
        for (const sessionId of this.rows.get(id)?.sessionIds ?? []) edge.add(sessionId);
      }
    }
    return edge;
  }
}

/**
 * Scans fixed-size windows until the index has `target` more linked commits,
 * history ends, or the window budget runs out. Windows are fixed-size so one
 * call has a bounded cost in a repo with long history and few checkpoints.
 *
 * Returns false when a window could not be read.
 */
export async function loadPage(
  index: CheckpointIndex,
  fetchWindow: (skip: number, count: number) => Promise<CommitRecord[] | undefined>,
  target = PAGE_SIZE,
): Promise<boolean> {
  let added = 0;
  for (let windows = 0; windows < MAX_WINDOWS_PER_PAGE && !index.exhausted && added < target; windows += 1) {
    const records = await fetchWindow(index.scanned, WINDOW_SIZE);
    if (!records) return false;
    added += index.addWindow(records, WINDOW_SIZE);
  }
  return true;
}
