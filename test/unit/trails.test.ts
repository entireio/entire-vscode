import { describe, expect, it } from 'vitest';
import type { TrailChange, TrailEvent, TrailPage, TrailSummary } from '../../src/core/schemas';
import {
  addTrailPage,
  changeRef,
  DEFAULT_TRAIL_FILTER,
  inTrailFilter,
  MAX_TRAIL_PAGES_PER_READ,
  noTrailsText,
  OPEN_PHASES,
  readTrailFilter,
  readTrailPages,
  trailFilterKey,
  trailFilterLabel,
  trailFilters,
  type TrailFilter,
  type TrailPages,
  checkDetail,
  checkOutcome,
  eventText,
  gateLabel,
  gateOutcome,
  isCheckedOut,
  isInRepo,
  isTrailId,
  outcomeSummary,
  primaryChange,
  sameChange,
  trailProject,
  trailRepo,
  words,
  type HostedRepo,
} from '../../src/core/trails';

const WIDGET: HostedRepo = { forge: 'gh', owner: 'acme', repo: 'widget' };

function change(repository: string, number: number, branch?: string): TrailChange {
  return { repository, number, hasCodeChanges: true, ...(branch ? { branch } : {}) };
}

function event(kind: string, extra: Partial<TrailEvent> = {}): TrailEvent {
  return { kind, agents: [], ...extra };
}

describe('trailProject and trailRepo', () => {
  it('name a GitHub mirror by its owner', () => {
    expect(trailProject(WIDGET)).toBe('gh/acme');
    expect(trailRepo(WIDGET)).toBe('gh/acme/widget');
  });

  it('name an Entire-native repository by its project', () => {
    const native: HostedRepo = { forge: 'et', owner: 'platform', repo: 'api' };
    expect(trailProject(native)).toBe('et/platform');
    expect(trailRepo(native)).toBe('et/platform/api');
  });
});

describe('isTrailId', () => {
  it('accepts a ULID, which is what entire.io issues', () => {
    expect(isTrailId('01JT0000000000000000000042')).toBe(true);
  });

  it.each([
    ['a trail number', 2825],
    ['a number as text', '2825'],
    ['a flag', '--json'],
    ['lower case', '01m72fq3n64n4fjx81dzbv2567'],
    ['a letter that Crockford base 32 leaves out', '01M72FQ3N64N4FJX81DZBV256U'],
    ['one character short', '01M72FQ3N64N4FJX81DZBV256'],
    ['one character long', '01JT00000000000000000000420'],
    ['a ULID with a line break after it', '01JT0000000000000000000042\n'],
    ['nothing', undefined],
  ])('rejects %s', (_label, value) => {
    expect(isTrailId(value)).toBe(false);
  });
});

describe('changeRef and sameChange', () => {
  it('names a change by its repository and number, and nothing else', () => {
    expect(changeRef(change('widget', 7, 'main'))).toEqual({ repository: 'widget', number: 7 });
  });

  it('tells changes apart by repository and by number', () => {
    expect(sameChange(change('widget', 7, 'main'), { repository: 'widget', number: 7 })).toBe(true);
    expect(sameChange(change('widget', 7), change('widget', 8))).toBe(false);
    // Changes are numbered inside their repository, so two repositories can share a number.
    expect(sameChange(change('widget', 7), change('docs', 7))).toBe(false);
  });
});

describe('isInRepo', () => {
  it('matches the short repository name, whatever its case', () => {
    expect(isInRepo(change('widget', 1), WIDGET)).toBe(true);
    expect(isInRepo(change('Widget', 1), WIDGET)).toBe(true);
    expect(isInRepo(change('widget-docs', 1), WIDGET)).toBe(false);
    expect(isInRepo(change('docs', 1), WIDGET)).toBe(false);
  });
});

describe('isCheckedOut', () => {
  it('is true for the change on the checked-out branch of this repository', () => {
    expect(isCheckedOut(change('widget', 1, 'feature/parser'), WIDGET, 'feature/parser')).toBe(true);
  });

  it('is false for a branch of the same name in another repository', () => {
    expect(isCheckedOut(change('docs', 1, 'feature/parser'), WIDGET, 'feature/parser')).toBe(false);
  });

  it('is false on a detached HEAD, even for a change with no branch', () => {
    expect(isCheckedOut(change('widget', 1, 'feature/parser'), WIDGET, undefined)).toBe(false);
    expect(isCheckedOut(change('widget', 1), WIDGET, undefined)).toBe(false);
  });

  it('is false for another branch', () => {
    expect(isCheckedOut(change('widget', 1, 'feature/parser'), WIDGET, 'main')).toBe(false);
  });
});

describe('primaryChange', () => {
  const changes = [
    change('docs', 4, 'feature/parser'),
    change('widget', 7, 'feature/lexer'),
    change('widget', 8, 'feature/parser'),
  ];

  it('prefers the change on the checked-out branch of this repository', () => {
    expect(primaryChange(changes, WIDGET, 'feature/parser')).toBe(2);
  });

  it('falls back to the first change in this repository', () => {
    expect(primaryChange(changes, WIDGET, 'main')).toBe(1);
    expect(primaryChange(changes, WIDGET, undefined)).toBe(1);
  });

  it('falls back to the first change when none is in this repository', () => {
    expect(primaryChange([change('docs', 4), change('api', 5)], WIDGET, 'main')).toBe(0);
  });

  it('is -1 for a trail with no changes', () => {
    expect(primaryChange([], WIDGET, 'main')).toBe(-1);
  });
});

describe('gateOutcome', () => {
  it.each([
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['skipped', 'skipped'],
    ['pending', 'pending'],
    ['running', 'pending'],
    ['stale', 'pending'],
  ] as const)('reads status %s as %s', (status, outcome) => {
    expect(gateOutcome({ key: 'checks', blocking: true, status })).toBe(outcome);
  });

  it('reads a gate with no status as pending', () => {
    expect(gateOutcome({ key: 'checks', blocking: true })).toBe('pending');
  });
});

describe('checkOutcome and checkDetail', () => {
  it.each([
    ['completed', 'success', 'passed', 'success'],
    ['completed', 'failure', 'failed', 'failure'],
    ['completed', 'timed_out', 'failed', 'timed out'],
    ['completed', 'cancelled', 'failed', 'cancelled'],
    ['completed', 'action_required', 'failed', 'action required'],
    ['completed', 'skipped', 'skipped', 'skipped'],
    ['completed', 'neutral', 'skipped', 'neutral'],
    ['in_progress', undefined, 'pending', 'in progress'],
    ['queued', undefined, 'pending', 'queued'],
  ] as const)('reads %s with conclusion %s as %s', (status, conclusion, outcome, detail) => {
    const run = { name: 'build', status, ...(conclusion ? { conclusion } : {}) };
    expect(checkOutcome(run)).toBe(outcome);
    expect(checkDetail(run)).toBe(detail);
  });

  it('counts a completed run with no conclusion as failed, so it is not taken for a pass', () => {
    expect(checkOutcome({ name: 'build', status: 'completed' })).toBe('failed');
    expect(checkDetail({ name: 'build', status: 'completed' })).toBe('completed');
  });

  it('reads a run with no status as pending', () => {
    expect(checkOutcome({ name: 'build' })).toBe('pending');
    expect(checkDetail({ name: 'build' })).toBe('pending');
  });

  it('does not let a conclusion stand for a run that has not completed', () => {
    expect(checkOutcome({ name: 'build', status: 'in_progress', conclusion: 'success' })).toBe('pending');
  });
});

describe('gateLabel', () => {
  it('names the gates this extension knows', () => {
    expect(gateLabel('approvals')).toBe('Approvals');
    expect(gateLabel('checks')).toBe('Checks');
    expect(gateLabel('findings')).toBe('Findings');
    expect(gateLabel('up_to_date')).toBe('Up to date with base');
  });

  it('spells out the key of a gate it does not know', () => {
    expect(gateLabel('signed_commits')).toBe('Signed commits');
    expect(gateLabel('linear-history')).toBe('Linear history');
  });

  it('does not read a gate named like an object member as one', () => {
    expect(gateLabel('constructor')).toBe('Constructor');
  });
});

describe('words', () => {
  it('replaces underscores and dashes with spaces', () => {
    expect(words('in_progress')).toBe('in progress');
    expect(words('not-evaluated')).toBe('not evaluated');
    expect(words('a__b')).toBe('a b');
    expect(words('clean')).toBe('clean');
  });
});

describe('outcomeSummary', () => {
  it('lists the outcomes that occurred, with what needs attention first', () => {
    expect(outcomeSummary(['passed', 'skipped', 'failed', 'passed', 'pending'])).toBe(
      '1 failed, 1 pending, 2 passed, 1 skipped',
    );
  });

  it('leaves out the outcomes that did not occur', () => {
    expect(outcomeSummary(['passed', 'passed'])).toBe('2 passed');
  });

  it('is empty for no runs', () => {
    expect(outcomeSummary([])).toBe('');
  });
});

describe('eventText', () => {
  it('shows a commit by its subject', () => {
    expect(eventText(event('commit', { title: 'Add the parser' }))).toBe('Add the parser');
    expect(eventText(event('commit'))).toBe('Commit');
  });

  it('counts the findings of a review', () => {
    expect(eventText(event('review_posted'))).toBe('Posted a review');
    expect(eventText(event('review_posted', { findingCount: 0 }))).toBe('Posted a review with no findings');
    expect(eventText(event('review_posted', { findingCount: 1 }))).toBe('Posted a review with 1 finding');
    expect(eventText(event('review_posted', { findingCount: 1200 }))).toBe('Posted a review with 1,200 findings');
  });

  it('names the lifecycle entries', () => {
    expect(eventText(event('trail_created'))).toBe('Created the trail');
    expect(eventText(event('finding_resolved'))).toBe('Resolved a finding');
  });

  it('shows a kind it does not know by its title, or by its name', () => {
    expect(eventText(event('approval_granted'))).toBe('Approval granted');
    expect(eventText(event('approval_granted', { title: 'Approved by a maintainer' }))).toBe('Approved by a maintainer');
  });
});

function trail(number: number, phase = 'building'): TrailSummary {
  return { number, title: `Trail ${number}`, status: phase === 'closed' ? 'closed' : 'open', phase, assignees: [], changes: [] };
}

function page(numbers: number[], nextPageToken?: string, total?: number): TrailPage {
  return {
    trails: numbers.map((number) => trail(number)),
    ...(nextPageToken ? { nextPageToken } : {}),
    ...(total === undefined ? {} : { total }),
  };
}

describe('trail filters', () => {
  const ALL: TrailFilter[] = [
    { status: 'all' },
    { status: 'open' },
    { status: 'closed' },
    { status: 'open', phase: 'planning' },
    { status: 'open', phase: 'building' },
    { status: 'open', phase: 'complete' },
  ];

  it('start on open trails', () => {
    expect(DEFAULT_TRAIL_FILTER).toEqual({ status: 'open' });
  });

  it('offer every status the CLI lists by, then each phase of an open trail', () => {
    expect(trailFilters()).toEqual(ALL);
    expect(OPEN_PHASES).toEqual(['planning', 'building', 'complete']);
  });

  it('have a key that reads back to the same filter', () => {
    expect(ALL.map(trailFilterKey)).toEqual(['all', 'open', 'closed', 'open:planning', 'open:building', 'open:complete']);
    for (const filter of ALL) expect(readTrailFilter(trailFilterKey(filter))).toEqual(filter);
  });

  it('have a name for the view to show', () => {
    expect(ALL.map(trailFilterLabel)).toEqual(['All', 'Open', 'Closed', 'Planning', 'Building', 'Complete']);
    expect(trailFilterLabel({ status: 'open', phase: 'in_review' })).toBe('In review');
  });

  it('say what is missing when nothing matches', () => {
    expect(ALL.map(noTrailsText)).toEqual([
      'No trails touch this repository.',
      'No open trails touch this repository.',
      'No closed trails touch this repository.',
      'No open trails in the planning phase touch this repository.',
      'No open trails in the building phase touch this repository.',
      'No open trails in the complete phase touch this repository.',
    ]);
    expect(noTrailsText({ status: 'open', phase: 'in_review' })).toBe(
      'No open trails in the in review phase touch this repository.',
    );
  });

  it('add a phase that trails are in and the list does not name', () => {
    const filters = trailFilters(['building', 'in_review', undefined, 'closed', 'in_review', 'awaiting-merge']);
    expect(filters.slice(ALL.length)).toEqual([
      { status: 'open', phase: 'awaiting-merge' },
      { status: 'open', phase: 'in_review' },
    ]);
    // The closed phase is the closed status, which is already offered.
    expect(filters.some((filter) => filter.phase === 'closed')).toBe(false);
    expect(filters.filter((filter) => filter.phase === 'building')).toHaveLength(1);
  });

  it('do not offer a phase whose name could not be a key', () => {
    expect(trailFilters(['Has Spaces', 'a:b', '', '-flag', 'x'.repeat(60)])).toEqual(ALL);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 1],
    ['an object', { status: 'open' }],
    ['an empty string', ''],
    ['an unknown status', 'merged'],
    ['a status that differs in case', 'Open'],
    ['a phase of closed trails', 'closed:planning'],
    ['a phase of all trails', 'all:building'],
    ['an empty phase', 'open:'],
    ['a phase with a space', 'open:in review'],
    ['a phase in capitals', 'open:Building'],
    ['two phases', 'open:planning:building'],
    ['an inherited property name', 'constructor'],
  ])('do not read %s as a filter', (_label, key) => {
    expect(readTrailFilter(key)).toBeUndefined();
  });

  it('keep every trail when no phase is asked for', () => {
    expect(inTrailFilter(trail(1, 'planning'), { status: 'open' })).toBe(true);
    expect(inTrailFilter(trail(1, 'closed'), { status: 'all' })).toBe(true);
    expect(inTrailFilter({}, { status: 'open' })).toBe(true);
  });

  it('keep only the trails in the phase asked for', () => {
    const filter: TrailFilter = { status: 'open', phase: 'building' };
    expect(inTrailFilter(trail(1, 'building'), filter)).toBe(true);
    expect(inTrailFilter(trail(1, 'planning'), filter)).toBe(false);
    expect(inTrailFilter(trail(1, 'complete'), filter)).toBe(false);
    // A trail whose phase the CLI did not report is in no phase.
    expect(inTrailFilter({}, filter)).toBe(false);
  });
});

describe('addTrailPage', () => {
  it('appends a page and takes its token and total', () => {
    const list: TrailPages = { trails: [] };
    expect(addTrailPage(list, page([3, 2], 'next', 120))).toBe(2);
    expect(list.trails.map((item) => item.number)).toEqual([3, 2]);
    expect(list.nextPageToken).toBe('next');
    expect(list.total).toBe(120);
  });

  it('drops the token on the last page and keeps the total it knew', () => {
    const list: TrailPages = { trails: [trail(3)], nextPageToken: 'next', total: 120 };
    expect(addTrailPage(list, page([2]))).toBe(1);
    expect(list.nextPageToken).toBeUndefined();
    expect('nextPageToken' in list).toBe(false);
    expect(list.total).toBe(120);
  });

  it('skips a trail it already holds, which moved to a later page after new activity', () => {
    const list: TrailPages = { trails: [trail(5), trail(4)] };
    expect(addTrailPage(list, page([4, 3, 5, 2]))).toBe(2);
    expect(list.trails.map((item) => item.number)).toEqual([5, 4, 3, 2]);
  });
});

describe('readTrailPages', () => {
  /** A source of `pages` pages of two trails each, numbered down from 100, that records the tokens asked for. */
  function source(pages: number): { asked: string[]; fetch: (token: string) => Promise<TrailPage> } {
    const asked: string[] = [];
    return {
      asked,
      fetch: async (token) => {
        asked.push(token);
        const index = Number(token);
        const first = 100 - index * 2;
        return page([first, first - 1], index + 1 < pages ? String(index + 1) : undefined);
      },
    };
  }

  it('reads nothing when the list already holds enough', async () => {
    const { asked, fetch } = source(5);
    const list: TrailPages = { trails: [], nextPageToken: '0' };
    expect(await readTrailPages(list, fetch, () => true)).toBe(true);
    expect(asked).toEqual([]);
  });

  it('reads nothing when the CLI has no more', async () => {
    const { asked, fetch } = source(5);
    expect(await readTrailPages({ trails: [trail(1)] }, fetch, () => false)).toBe(true);
    expect(asked).toEqual([]);
  });

  it('reads until the list holds enough, continuing from each token', async () => {
    const { asked, fetch } = source(10);
    const list: TrailPages = { trails: [], nextPageToken: '0' };
    expect(await readTrailPages(list, fetch, () => list.trails.length >= 6)).toBe(true);
    expect(asked).toEqual(['0', '1', '2']);
    expect(list.trails).toHaveLength(6);
    expect(list.nextPageToken).toBe('3');
  });

  it('stops at the last page', async () => {
    const { asked, fetch } = source(2);
    const list: TrailPages = { trails: [], nextPageToken: '0' };
    expect(await readTrailPages(list, fetch, () => false)).toBe(true);
    expect(asked).toEqual(['0', '1']);
    expect(list.nextPageToken).toBeUndefined();
  });

  it('reads no more than one read\'s worth of pages when little matches', async () => {
    const { asked, fetch } = source(50);
    const list: TrailPages = { trails: [], nextPageToken: '0' };
    // A filter that nothing passes never has enough.
    expect(await readTrailPages(list, fetch, () => false)).toBe(true);
    expect(asked).toHaveLength(MAX_TRAIL_PAGES_PER_READ);
    expect(list.nextPageToken).toBe(String(MAX_TRAIL_PAGES_PER_READ));
    // The next read carries on from there.
    await readTrailPages(list, fetch, () => false, { maxPages: 2 });
    expect(asked).toEqual(['0', '1', '2', '3', '4', '5']);
  });

  it('reports a page that could not be read and keeps what it has', async () => {
    const list: TrailPages = { trails: [trail(9)], nextPageToken: 'a' };
    const asked: string[] = [];
    const okay = await readTrailPages(
      list,
      async (token) => {
        asked.push(token);
        return token === 'a' ? page([8], 'b') : undefined;
      },
      () => false,
    );
    expect(okay).toBe(false);
    expect(asked).toEqual(['a', 'b']);
    expect(list.trails.map((item) => item.number)).toEqual([9, 8]);
    // The token stays, so a retry asks for the same page.
    expect(list.nextPageToken).toBe('b');
  });

  it('does not loop on a page that brings nothing new and points back at itself', async () => {
    const list: TrailPages = { trails: [trail(9)], nextPageToken: 'same' };
    let calls = 0;
    const okay = await readTrailPages(
      list,
      async () => {
        calls += 1;
        return page([9], 'same');
      },
      () => false,
      { maxPages: 50 },
    );
    expect(okay).toBe(true);
    expect(calls).toBe(1);
    expect(list.nextPageToken).toBeUndefined();
  });

  it('keeps reading past a page of repeats when the token moves on', async () => {
    const list: TrailPages = { trails: [trail(9)], nextPageToken: 'a' };
    const okay = await readTrailPages(
      list,
      async (token) => (token === 'a' ? page([9], 'b') : page([8])),
      () => false,
    );
    expect(okay).toBe(true);
    expect(list.trails.map((item) => item.number)).toEqual([9, 8]);
  });

  it('tells the caller after each page, so rows can appear as they arrive', async () => {
    const { fetch } = source(3);
    const list: TrailPages = { trails: [], nextPageToken: '0' };
    const seen: number[] = [];
    await readTrailPages(list, fetch, () => false, { onPage: () => seen.push(list.trails.length) });
    expect(seen).toEqual([2, 4, 6]);
  });
});
