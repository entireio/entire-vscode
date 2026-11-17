import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CheckpointIndex,
  LIST_LIMIT,
  MAX_WINDOWS_PER_PAGE,
  PAGE_SIZE,
  WINDOW_SIZE,
  loadPage,
} from '../../src/core/checkpointIndex';
import { exec } from '../../src/core/exec';
import { Git } from '../../src/core/git';
import { Lane } from '../../src/core/scheduler';
import type { CheckpointRow } from '../../src/core/schemas';
import type { CommitRecord } from '../../src/core/trailers';
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixtureRepo';
import { commitRecord, fakeSha, isolateGitConfig } from './support';

const TIP = fakeSha(0);
const CP_A = 'aaaaaaaaaaaa';
const CP_B = 'bbbbbbbbbbbb';
const CP_C = 'cccccccccccc';

function row(checkpointId: string, extra: Partial<CheckpointRow> = {}): CheckpointRow {
  return { checkpointId, sessionIds: [], ...extra };
}

describe('CheckpointIndex.addWindow', () => {
  it('keeps only the commits that carry a checkpoint, in scan order', () => {
    const index = new CheckpointIndex(TIP);
    const linked1 = commitRecord(1, [CP_A]);
    const linked3 = commitRecord(3, [CP_B]);
    const added = index.addWindow([commitRecord(0), linked1, commitRecord(2), linked3], 4);

    expect(added).toBe(2);
    expect(index.commits).toEqual([linked1, linked3]);
    expect(index.tipSha).toBe(TIP);
  });

  it('counts every scanned commit, linked or not', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0), commitRecord(1, [CP_A]), commitRecord(2)], 3);
    expect(index.scanned).toBe(3);
    index.addWindow([commitRecord(3), commitRecord(4)], 2);
    expect(index.scanned).toBe(5);
  });

  it('counts a commit with several checkpoints once', () => {
    const index = new CheckpointIndex(TIP);
    const both = commitRecord(0, [CP_A, CP_B]);
    expect(index.addWindow([both], 1)).toBe(1);
    expect(index.commits).toEqual([both]);
    expect(index.commitsFor(CP_A)).toEqual([both]);
    expect(index.commitsFor(CP_B)).toEqual([both]);
  });

  it('appends later windows after earlier ones', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0, [CP_A]), commitRecord(1)], 2);
    index.addWindow([commitRecord(2, [CP_B]), commitRecord(3, [CP_C])], 2);
    expect(index.commits.map((commit) => commit.checkpointIds[0])).toEqual([CP_A, CP_B, CP_C]);
  });

  it('returns zero and adds nothing for a window with no linked commits', () => {
    const index = new CheckpointIndex(TIP);
    expect(index.addWindow([commitRecord(0), commitRecord(1)], 2)).toBe(0);
    expect(index.commits).toEqual([]);
    expect(index.commitsFor(CP_A)).toEqual([]);
  });
});

describe('CheckpointIndex.exhausted', () => {
  it('starts false', () => {
    expect(new CheckpointIndex(TIP).exhausted).toBe(false);
  });

  it('stays false while windows come back full', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0), commitRecord(1)], 2);
    expect(index.exhausted).toBe(false);
  });

  it('turns true when a window comes back short', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0), commitRecord(1)], 2);
    index.addWindow([commitRecord(2)], 2);
    expect(index.exhausted).toBe(true);
  });

  it('turns true on an empty window, which is how history of an exact window multiple ends', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0), commitRecord(1)], 2);
    index.addWindow([], 2);
    expect(index.exhausted).toBe(true);
    expect(index.scanned).toBe(2);
  });
});

describe('one checkpoint on several commits', () => {
  it('lists every carrying commit, newest first', () => {
    const index = new CheckpointIndex(TIP);
    const amended = commitRecord(0, [CP_A]);
    const other = commitRecord(1, [CP_B]);
    const original = commitRecord(2, [CP_A]);
    index.addWindow([amended, other, original], 3);

    expect(index.commitsFor(CP_A)).toEqual([amended, original]);
    expect(index.commitsFor(CP_B)).toEqual([other]);
    expect(index.commits).toEqual([amended, other, original]);
  });

  it('joins carrying commits that arrive in different windows', () => {
    const index = new CheckpointIndex(TIP);
    const newer = commitRecord(0, [CP_A]);
    const older = commitRecord(5, [CP_A]);
    index.addWindow([newer], 1);
    index.addWindow([older], 1);
    expect(index.commitsFor(CP_A)).toEqual([newer, older]);
  });

  it('returns an empty list for a checkpoint on no scanned commit', () => {
    expect(new CheckpointIndex(TIP).commitsFor(CP_A)).toEqual([]);
  });
});

describe('CheckpointIndex rows', () => {
  it('looks rows up by checkpoint ID', () => {
    const index = new CheckpointIndex(TIP);
    const a = row(CP_A, { agent: 'Claude Code' });
    index.setRows([a, row(CP_B)]);
    expect(index.row(CP_A)).toBe(a);
    expect(index.row(CP_C)).toBeUndefined();
    expect(index.allRows().map((entry) => entry.checkpointId)).toEqual([CP_A, CP_B]);
  });

  it('replaces the previous rows', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A)]);
    index.setRows([row(CP_B)]);
    expect(index.row(CP_A)).toBeUndefined();
    expect(index.allRows().map((entry) => entry.checkpointId)).toEqual([CP_B]);
  });

  it('does not let rows change which commits are linked', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0, [CP_A])], 1);
    index.setRows([row(CP_B)]);
    expect(index.commits.map((commit) => commit.checkpointIds)).toEqual([[CP_A]]);
    expect(index.commitsFor(CP_B)).toEqual([]);
  });
});

describe('CheckpointIndex.unlinkedRows', () => {
  it('returns the rows whose checkpoint is on no scanned commit', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0, [CP_A]), commitRecord(1)], 2);
    index.setRows([row(CP_A), row(CP_B), row(CP_C)]);
    expect(index.unlinkedRows().map((entry) => entry.checkpointId)).toEqual([CP_B, CP_C]);
  });

  it('returns every row before any history is scanned', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A), row(CP_B)]);
    expect(index.unlinkedRows()).toHaveLength(2);
  });

  it('stops listing a row once a later window links its checkpoint', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A), row(CP_B)]);
    index.addWindow([commitRecord(0, [CP_A])], 1);
    expect(index.unlinkedRows().map((entry) => entry.checkpointId)).toEqual([CP_B]);
    index.addWindow([commitRecord(1, [CP_C, CP_B])], 1);
    expect(index.unlinkedRows()).toEqual([]);
  });

  it('is empty when there are no rows', () => {
    const index = new CheckpointIndex(TIP);
    index.addWindow([commitRecord(0, [CP_A])], 1);
    expect(index.unlinkedRows()).toEqual([]);
  });
});

describe('CheckpointIndex.sessions', () => {
  it('groups checkpoints by session and lists each session once', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionId: 's1', sessionIds: ['s1', 's2'], date: '2026-03-01T10:00:00Z', message: 'First' }),
      row(CP_B, { sessionId: 's2', sessionIds: ['s2'], date: '2026-03-02T10:00:00Z', message: 'Second' }),
      row(CP_C, { sessionId: 's1', sessionIds: ['s1'], date: '2026-03-03T10:00:00Z' }),
    ]);

    const sessions = index.sessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(['s1', 's2']);
    const [s1, s2] = sessions;
    expect(s1?.checkpoints).toEqual([
      { checkpointId: CP_C, date: '2026-03-03T10:00:00Z' },
      { checkpointId: CP_A, date: '2026-03-01T10:00:00Z', message: 'First' },
    ]);
    expect(s2?.checkpoints).toEqual([
      { checkpointId: CP_B, date: '2026-03-02T10:00:00Z', message: 'Second' },
      { checkpointId: CP_A, date: '2026-03-01T10:00:00Z', message: 'First' },
    ]);
  });

  it('orders sessions by their most recent checkpoint, newest first', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionIds: ['old'], date: '2026-01-01T00:00:00Z' }),
      row(CP_B, { sessionIds: ['new'], date: '2026-02-01T00:00:00Z' }),
      row(CP_C, { sessionIds: ['middle'], date: '2026-01-15T00:00:00Z' }),
    ]);

    const sessions = index.sessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(['new', 'middle', 'old']);
    expect(sessions.map((session) => session.lastDate)).toEqual([
      '2026-02-01T00:00:00Z',
      '2026-01-15T00:00:00Z',
      '2026-01-01T00:00:00Z',
    ]);
  });

  it('orders the checkpoints of a session newest first, whatever the row order', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_B, { sessionIds: ['s'], date: '2026-01-02T00:00:00Z' }),
      row(CP_C, { sessionIds: ['s'], date: '2026-01-03T00:00:00Z' }),
      row(CP_A, { sessionIds: ['s'], date: '2026-01-01T00:00:00Z' }),
    ]);
    const [session] = index.sessions();
    expect(session?.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([CP_C, CP_B, CP_A]);
    expect(session?.lastDate).toBe('2026-01-03T00:00:00Z');
  });

  it('takes the agent only from rows where the session is the primary one', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionId: 'primary', sessionIds: ['primary', 'secondary'], agent: 'Claude Code', date: '2026-01-02T00:00:00Z' }),
      row(CP_B, { sessionId: 'other', sessionIds: ['other', 'never-primary'], agent: 'Codex', date: '2026-01-01T00:00:00Z' }),
    ]);
    const byId = new Map(index.sessions().map((session) => [session.sessionId, session]));
    expect(byId.get('primary')?.agent).toBe('Claude Code');
    expect(byId.get('other')?.agent).toBe('Codex');
    expect(byId.get('secondary')?.agent).toBeUndefined();
    expect(byId.get('never-primary')?.agent).toBeUndefined();
  });

  it('puts checkpoints and sessions with no date last', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionIds: ['undated'] }),
      row(CP_B, { sessionIds: ['dated', 'mixed'], date: '2026-01-01T00:00:00Z' }),
      row(CP_C, { sessionIds: ['mixed'] }),
    ]);
    const sessions = index.sessions();
    expect(sessions.map((session) => session.sessionId)).toEqual(['dated', 'mixed', 'undated']);
    const mixed = sessions[1];
    expect(mixed?.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([CP_B, CP_C]);
    expect(mixed?.lastDate).toBe('2026-01-01T00:00:00Z');
    expect(sessions[2]).toEqual({
      sessionId: 'undated',
      checkpoints: [{ checkpointId: CP_A }],
      mayHaveEarlier: false,
    });
  });

  it('returns nothing when no row names a session', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A), row(CP_B)]);
    expect(index.sessions()).toEqual([]);
  });

  // The CLI prints `date` as RFC 3339 with the offset of wherever the time
  // came from, so two rows can carry different offsets. 09:30Z is later than
  // 10:00+02:00 (which is 08:00Z), although it sorts earlier as text.
  it('orders by the instant, not by the text, when dates carry different UTC offsets', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionIds: ['earlier'], date: '2026-01-02T10:00:00+02:00' }),
      row(CP_B, { sessionIds: ['later'], date: '2026-01-02T09:30:00Z' }),
    ]);
    expect(index.sessions().map((session) => session.sessionId)).toEqual(['later', 'earlier']);
  });

  it('orders the checkpoints of one session by the instant when offsets differ', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionIds: ['s'], date: '2026-01-02T10:00:00+02:00' }),
      row(CP_B, { sessionIds: ['s'], date: '2026-01-02T09:30:00Z' }),
    ]);
    const [session] = index.sessions();
    expect(session?.checkpoints.map((checkpoint) => checkpoint.checkpointId)).toEqual([CP_B, CP_A]);
    expect(session?.lastDate).toBe('2026-01-02T09:30:00Z');
  });
});

describe('CheckpointIndex.position', () => {
  const day = (n: number): string => `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`;

  it('counts a checkpoint from the oldest of its session, whatever order the rows came in', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_B, { sessionIds: ['s'], date: day(2) }),
      row(CP_C, { sessionIds: ['s'], date: day(3) }),
      row(CP_A, { sessionIds: ['s'], date: day(1) }),
    ]);
    expect(index.position('s', CP_A)).toEqual({ ordinal: 1, total: 3, mayHaveEarlier: false, next: CP_B });
    expect(index.position('s', CP_B)).toEqual({ ordinal: 2, total: 3, mayHaveEarlier: false, previous: CP_A, next: CP_C });
    expect(index.position('s', CP_C)).toEqual({ ordinal: 3, total: 3, mayHaveEarlier: false, previous: CP_B });
  });

  it('gives the only checkpoint of a session no neighbors', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A, { sessionIds: ['s'], date: day(1) })]);
    expect(index.position('s', CP_A)).toEqual({ ordinal: 1, total: 1, mayHaveEarlier: false });
  });

  it('places a checkpoint separately in each of its sessions', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([
      row(CP_A, { sessionIds: ['long'], date: day(1) }),
      row(CP_B, { sessionIds: ['long', 'short'], date: day(2) }),
      row(CP_C, { sessionIds: ['long'], date: day(3) }),
    ]);
    expect(index.position('long', CP_B)).toMatchObject({ ordinal: 2, total: 3, previous: CP_A, next: CP_C });
    expect(index.position('short', CP_B)).toEqual({ ordinal: 1, total: 1, mayHaveEarlier: false });
  });

  it('returns undefined for a session or a checkpoint the rows do not connect', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A, { sessionIds: ['s'], date: day(1) }), row(CP_B, { sessionIds: ['other'], date: day(2) })]);
    expect(index.position('unknown', CP_A)).toBeUndefined();
    expect(index.position('s', CP_B)).toBeUndefined();
    expect(index.position('s', CP_C)).toBeUndefined();
  });

  it('follows the rows when they change', () => {
    const index = new CheckpointIndex(TIP);
    index.setRows([row(CP_A, { sessionIds: ['s'], date: day(1) })]);
    expect(index.position('s', CP_A)?.total).toBe(1);
    index.setRows([row(CP_A, { sessionIds: ['s'], date: day(1) }), row(CP_B, { sessionIds: ['s'], date: day(2) })]);
    expect(index.position('s', CP_A)).toMatchObject({ ordinal: 1, total: 2, next: CP_B });
    expect(index.sessions()[0]?.checkpoints).toHaveLength(2);
  });
});

/**
 * The Entire CLI lists the checkpoints of the newest 500 commits of the
 * branch and does not say whether it stopped there. A session on the oldest
 * commits it listed may have begun before them.
 */
describe('sessions that may have earlier checkpoints', () => {
  const id = (n: number): string => n.toString(16).padStart(12, '0');

  /**
   * A history in which commit `n` (0 is the tip) carries checkpoint `id(n)`
   * when `linked(n)` is true, with CLI rows for the commits `listed(n)`
   * accepts. `session(n)` names the session of a row.
   */
  function history(options: {
    commits: number;
    exhausted: boolean;
    linked: (n: number) => boolean;
    listed: (n: number) => boolean;
    session: (n: number) => string;
  }): CheckpointIndex {
    const index = new CheckpointIndex(TIP);
    const records = Array.from({ length: options.commits }, (_, n) => commitRecord(n, options.linked(n) ? [id(n)] : []));
    index.addWindow(records, options.exhausted ? options.commits + 1 : options.commits);
    const rows: CheckpointRow[] = [];
    for (let n = 0; n < options.commits; n += 1) {
      if (!options.linked(n) || !options.listed(n)) continue;
      // A commit further from the tip is older.
      const date = new Date(Date.UTC(2026, 0, 1) - n * 60_000).toISOString();
      rows.push(row(id(n), { sessionIds: [options.session(n)], sessionId: options.session(n), date }));
    }
    index.setRows(rows);
    return index;
  }
  const sessionNamed = (index: CheckpointIndex, name: string) =>
    index.sessions().find((session) => session.sessionId === name);

  it('marks the session at the old edge of a list that reached the limit, and not a newer one', () => {
    // The CLI listed commits 0 to 449 of a longer history that has checkpoints beyond.
    const index = history({
      commits: 700,
      exhausted: false,
      linked: () => true,
      listed: (n) => n < 450,
      session: (n) => (n < 100 ? 'recent' : 'old'),
    });
    expect(sessionNamed(index, 'old')?.mayHaveEarlier).toBe(true);
    expect(sessionNamed(index, 'recent')?.mayHaveEarlier).toBe(false);
    expect(index.position('old', id(449))).toMatchObject({ ordinal: 1, total: 350, mayHaveEarlier: true });
    expect(index.position('recent', id(0))).toMatchObject({ ordinal: 100, total: 100, mayHaveEarlier: false });
  });

  it('does not mark sessions on a feature branch, where the list stops at the branch point', () => {
    // Three commits on the branch are listed. The thousands below them belong to the main branch.
    const index = history({
      commits: 2000,
      exhausted: false,
      linked: () => true,
      listed: (n) => n < 3,
      session: () => 'branch-work',
    });
    expect(sessionNamed(index, 'branch-work')?.mayHaveEarlier).toBe(false);
    expect(index.position('branch-work', id(2))).toEqual({ ordinal: 1, total: 3, mayHaveEarlier: false, next: id(1) });
  });

  it('does not mark a session when the list reaches the first checkpoint in history', () => {
    const index = history({
      commits: 480,
      exhausted: true,
      linked: () => true,
      listed: () => true,
      session: () => 'from-the-start',
    });
    expect(sessionNamed(index, 'from-the-start')?.mayHaveEarlier).toBe(false);
  });

  it('marks a session at the edge when older commits exist but carry no row', () => {
    // History ends, and every commit is linked, but the CLI listed only the newest 450.
    const index = history({
      commits: 600,
      exhausted: true,
      linked: () => true,
      listed: (n) => n < 450,
      session: () => 'cut-off',
    });
    expect(sessionNamed(index, 'cut-off')?.mayHaveEarlier).toBe(true);
  });

  it('marks every session on the five oldest listed commits, and none above them', () => {
    const index = history({
      commits: 700,
      exhausted: false,
      linked: () => true,
      listed: (n) => n < 450,
      // Commits 445 to 449 are the five oldest listed ones.
      session: (n) => (n >= 445 ? `edge-${n}` : n === 444 ? 'just-above' : 'recent'),
    });
    for (let n = 445; n < 450; n += 1) expect(sessionNamed(index, `edge-${n}`)?.mayHaveEarlier).toBe(true);
    expect(sessionNamed(index, 'just-above')?.mayHaveEarlier).toBe(false);
  });

  it('treats a list that filled the row limit as cut off, even near the tip', () => {
    const index = new CheckpointIndex(TIP);
    // Ten linked commits near the tip and more history below them.
    index.addWindow(
      Array.from({ length: 50 }, (_, n) => commitRecord(n, n < 10 || n >= 40 ? [id(n)] : [])),
      50,
    );
    const rows: CheckpointRow[] = [];
    for (let n = 0; n < 10; n += 1) rows.push(row(id(n), { sessionIds: ['s'], date: `2026-01-01T00:${59 - n}:00Z` }));
    // The rest of the rows are checkpoints that no commit carries.
    for (let n = 0; rows.length < LIST_LIMIT; n += 1) rows.push(row(`f${n.toString(16).padStart(11, '0')}`, { sessionIds: ['imported'] }));
    index.setRows(rows);
    expect(index.sessions().find((session) => session.sessionId === 's')?.mayHaveEarlier).toBe(true);
  });

  it('recomputes when more history is scanned', () => {
    // 450 commits read so far, all listed, and history goes on: the session may reach further back.
    const index = history({
      commits: 450,
      exhausted: false,
      linked: () => true,
      listed: () => true,
      session: () => 's',
    });
    expect(sessionNamed(index, 's')?.mayHaveEarlier).toBe(true);

    // The next window is empty, so history ended at the oldest listed commit.
    index.addWindow([], 2000);
    expect(index.exhausted).toBe(true);
    expect(sessionNamed(index, 's')?.mayHaveEarlier).toBe(false);
  });
});

/**
 * A synthetic history of `total` commits, newest first. Commit `n` carries a
 * checkpoint when `n` is a multiple of `linkedEvery`.
 */
function history(total: number, linkedEvery = 0) {
  const calls: [number, number][] = [];
  const fetchWindow = async (skip: number, count: number): Promise<CommitRecord[]> => {
    calls.push([skip, count]);
    const records: CommitRecord[] = [];
    for (let n = skip; n < Math.min(skip + count, total); n += 1) {
      const linked = linkedEvery > 0 && n % linkedEvery === 0;
      records.push(commitRecord(n, linked ? [n.toString(16).padStart(12, '0')] : []));
    }
    return records;
  };
  return { calls, fetchWindow };
}

describe('loadPage', () => {
  it('asks for fixed-size windows, each starting where the last one ended', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(5000);
    await loadPage(index, fetchWindow);
    expect(calls).toEqual([
      [0, WINDOW_SIZE],
      [WINDOW_SIZE, WINDOW_SIZE],
      [2 * WINDOW_SIZE, WINDOW_SIZE],
    ]);
  });

  it('stops once it has found the target number of linked commits', async () => {
    const index = new CheckpointIndex(TIP);
    // 40 linked commits per window, so the default target of one page (50) needs two windows.
    const { calls, fetchWindow } = history(1_000_000, 50);

    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(PAGE_SIZE).toBe(50);
    expect(calls).toHaveLength(2);
    expect(index.commits).toHaveLength(80);
    expect(index.scanned).toBe(2 * WINDOW_SIZE);
    expect(index.exhausted).toBe(false);
  });

  it('stops after one window when that window alone reaches the target', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000, 10);
    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(index.commits).toHaveLength(200);
  });

  it('honors a custom target', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000, 1500);
    // Windows hold 2, 1, 1, 2 linked commits.
    expect(await loadPage(index, fetchWindow, 4)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(index.commits).toHaveLength(4);
  });

  it('counts the target per call, so a second page finds that many more', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000, 10);
    await loadPage(index, fetchWindow);
    await loadPage(index, fetchWindow);
    expect(calls).toEqual([
      [0, WINDOW_SIZE],
      [WINDOW_SIZE, WINDOW_SIZE],
    ]);
    expect(index.commits).toHaveLength(400);
    expect(new Set(index.commits.map((commit) => commit.sha)).size).toBe(400);
  });

  it('stops at the end of history', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(2500, 1000);

    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(index.exhausted).toBe(true);
    expect(index.scanned).toBe(2500);
    expect(index.commits.map((commit) => commit.sha)).toEqual([fakeSha(0), fakeSha(1000), fakeSha(2000)]);
  });

  it('stops at the end of a history that is an exact multiple of the window', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(WINDOW_SIZE);
    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(index.exhausted).toBe(true);
    expect(index.scanned).toBe(WINDOW_SIZE);
  });

  it('handles an empty history', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(0);
    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(index.exhausted).toBe(true);
    expect(index.commits).toEqual([]);
  });

  it('does not fetch again once history is exhausted', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(10, 2);
    await loadPage(index, fetchWindow);
    expect(calls).toHaveLength(1);
    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(index.commits).toHaveLength(5);
  });

  it('stops at the window budget in a long history with no linked commits', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000);

    expect(await loadPage(index, fetchWindow)).toBe(true);
    expect(calls).toHaveLength(MAX_WINDOWS_PER_PAGE);
    expect(index.scanned).toBe(MAX_WINDOWS_PER_PAGE * WINDOW_SIZE);
    expect(index.exhausted).toBe(false);
    expect(index.commits).toEqual([]);
  });

  it('continues after the window budget on the next call', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000);
    await loadPage(index, fetchWindow);
    await loadPage(index, fetchWindow);
    expect(calls).toHaveLength(2 * MAX_WINDOWS_PER_PAGE);
    expect(calls[MAX_WINDOWS_PER_PAGE]).toEqual([MAX_WINDOWS_PER_PAGE * WINDOW_SIZE, WINDOW_SIZE]);
    expect(index.scanned).toBe(2 * MAX_WINDOWS_PER_PAGE * WINDOW_SIZE);
  });

  it('returns false when the first window fails, and leaves the index untouched', async () => {
    const index = new CheckpointIndex(TIP);
    const fetchWindow = vi.fn(async () => undefined);

    expect(await loadPage(index, fetchWindow)).toBe(false);
    expect(fetchWindow).toHaveBeenCalledTimes(1);
    expect(index.scanned).toBe(0);
    expect(index.exhausted).toBe(false);
    expect(index.commits).toEqual([]);
  });

  it('returns false when a later window fails, keeps what it read, and retries that window next time', async () => {
    const index = new CheckpointIndex(TIP);
    const { calls, fetchWindow } = history(1_000_000, 1000);
    let failing = true;
    const flaky = async (skip: number, count: number): Promise<CommitRecord[] | undefined> => {
      if (failing && skip >= WINDOW_SIZE) {
        calls.push([skip, count]);
        return undefined;
      }
      return fetchWindow(skip, count);
    };

    expect(await loadPage(index, flaky)).toBe(false);
    expect(calls).toEqual([
      [0, WINDOW_SIZE],
      [WINDOW_SIZE, WINDOW_SIZE],
    ]);
    expect(index.scanned).toBe(WINDOW_SIZE);
    expect(index.commits).toHaveLength(2);
    expect(index.exhausted).toBe(false);

    failing = false;
    calls.length = 0;
    expect(await loadPage(index, flaky, 3)).toBe(true);
    expect(calls[0]).toEqual([WINDOW_SIZE, WINDOW_SIZE]);
    expect(index.commits.map((commit) => commit.sha).slice(0, 3)).toEqual([fakeSha(0), fakeSha(1000), fakeSha(2000)]);
  });
});

describe('loadPage over a real repository', () => {
  const git = new Git(exec, new Lane(4));
  let repo: FixtureRepo | undefined;

  beforeAll(() => isolateGitConfig());
  afterAll(() => vi.unstubAllEnvs());
  afterEach(() => repo?.dispose());

  it('indexes the linked commits of a short history and reaches its end', async () => {
    repo = createFixtureRepo();
    const root = repo.root;
    repo.commit('Initial commit');
    const first = repo.commit('First checkpoint', [`Entire-Checkpoint: ${CP_A}`]);
    repo.commit('Unrelated work');
    const second = repo.commit('Second checkpoint, and the first again', [
      `Entire-Checkpoint: ${CP_B}`,
      `Entire-Checkpoint: ${CP_A}`,
    ]);
    const tip = repo.commit('Tip with no checkpoint');

    const index = new CheckpointIndex(tip);
    const loaded = await loadPage(index, async (skip, count) => {
      const window = await git.logWindow(root, tip, skip, count);
      return window.ok ? window.value : undefined;
    });

    expect(loaded).toBe(true);
    expect(index.exhausted).toBe(true);
    expect(index.scanned).toBe(5);
    expect(index.commits.map((commit) => commit.sha)).toEqual([second, first]);
    expect(index.commitsFor(CP_A).map((commit) => commit.sha)).toEqual([second, first]);
    expect(index.commitsFor(CP_B).map((commit) => commit.sha)).toEqual([second]);
  });
});
