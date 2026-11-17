import { describe, expect, it } from 'vitest';
import { readTrailDetail, readTrailPage, readTrailTimeline } from '../../src/core/schemas';

const WRONG_TYPES: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a string', 'items'],
  ['a number', 1],
  ['an array', []],
];

/** A trail the way `entire trail list --json` prints one. */
function listItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JT0000000000000000000042',
    projectId: 'project-1',
    number: 42,
    title: 'Rework the parser',
    body: 'Why and how.',
    status: 'open',
    phase: 'building',
    metadata: {},
    type: 'feature',
    priority: 'none',
    assignees: ['fixture-author'],
    assigneeAccountIds: ['account-1'],
    repoIds: ['repo-1'],
    authorAccountId: 'account-1',
    createdAt: '2026-03-01T00:00:00Z',
    lastActivityAt: '2026-03-02T00:00:00Z',
    closedAt: null,
    changes: [
      {
        id: 'change-1',
        repositoryId: 'repo-1',
        repository: 'widget',
        branch: 'feature/parser',
        base: 'main',
        number: 7,
        title: 'Rework the parser',
        status: 'open',
        hasCodeChanges: true,
        createdAt: '2026-03-01T00:00:00Z',
        updatedAt: '2026-03-02T00:00:00Z',
      },
    ],
    isPossiblyPartial: false,
    ...overrides,
  };
}

describe('readTrailPage', () => {
  it('reads a page with its token and its total', () => {
    const page = readTrailPage({
      items: [listItem()],
      nextPageToken: 'next',
      groups: [{ rank: 0, key: '', label: 'All trails', totalCount: 1240, itemCount: 1 }],
      groupTotals: [{ rank: 0, key: '', label: 'All trails', totalCount: 1240 }],
      groupBy: 'none',
      capabilities: { canManageTrails: false },
    });
    expect(page).toEqual({
      trails: [
        {
          number: 42,
          id: '01JT0000000000000000000042',
          title: 'Rework the parser',
          body: 'Why and how.',
          status: 'open',
          phase: 'building',
          type: 'feature',
          priority: 'none',
          assignees: ['fixture-author'],
          createdAt: '2026-03-01T00:00:00Z',
          lastActivityAt: '2026-03-02T00:00:00Z',
          changes: [
            {
              repository: 'widget',
              number: 7,
              title: 'Rework the parser',
              status: 'open',
              branch: 'feature/parser',
              base: 'main',
              hasCodeChanges: true,
              updatedAt: '2026-03-02T00:00:00Z',
            },
          ],
        },
      ],
      nextPageToken: 'next',
      total: 1240,
    });
  });

  it('has no token on the last page', () => {
    expect(readTrailPage({ items: [], nextPageToken: null })).toEqual({ trails: [] });
    expect(readTrailPage({ items: [], nextPageToken: '' })).toEqual({ trails: [] });
    expect(readTrailPage({ items: [] })).toEqual({ trails: [] });
  });

  it('reads a trail that has no changes, which the CLI prints with no `changes` key', () => {
    const item = listItem();
    delete item.changes;
    expect(readTrailPage({ items: [item] })?.trails[0]?.changes).toEqual([]);
  });

  it.each([
    ['is missing', undefined],
    ['is not text', 42],
    ['is not a ULID', 'trail-1'],
    ['reads as a flag', '--json'],
  ])('keeps the trail and drops its ID when the ID %s', (_label, id) => {
    const [trail] = readTrailPage({ items: [listItem({ id })] })?.trails ?? [];
    expect(trail?.number).toBe(42);
    expect(trail && 'id' in trail).toBe(false);
  });

  it('adds up the totals of a grouped list', () => {
    const page = readTrailPage({
      items: [],
      groupTotals: [
        { key: 'building', totalCount: 30 },
        { key: 'complete', totalCount: 12 },
      ],
    });
    expect(page?.total).toBe(42);
  });

  it('falls back to the groups of the page when there are no group totals', () => {
    expect(readTrailPage({ items: [], groups: [{ totalCount: 7, itemCount: 0 }] })?.total).toBe(7);
  });

  it('reports no total when the CLI gives none', () => {
    expect(readTrailPage({ items: [], groups: [{ label: 'All trails' }] })).toEqual({ trails: [] });
  });

  it('skips a trail with no number and keeps the rest', () => {
    const page = readTrailPage({ items: [listItem({ number: undefined }), listItem({ number: 9 }), 'not a trail', null] });
    expect(page?.trails.map((trail) => trail.number)).toEqual([9]);
  });

  it('gives an untitled trail a title that names it', () => {
    expect(readTrailPage({ items: [listItem({ title: '' })] })?.trails[0]?.title).toBe('Trail 42');
  });

  it('reads the older `updatedAt` as the last activity', () => {
    const item = listItem({ lastActivityAt: undefined, updatedAt: '2026-02-01T00:00:00Z' });
    expect(readTrailPage({ items: [item] })?.trails[0]?.lastActivityAt).toBe('2026-02-01T00:00:00Z');
  });

  it('skips a change with no repository or no number', () => {
    const page = readTrailPage({
      items: [
        listItem({
          changes: [{ repository: 'widget' }, { number: 3 }, { repository: 'docs', number: 3 }, 'not a change'],
        }),
      ],
    });
    expect(page?.trails[0]?.changes).toEqual([{ repository: 'docs', number: 3, hasCodeChanges: false }]);
  });

  it('drops fields of the wrong type instead of the trail', () => {
    const page = readTrailPage({
      items: [listItem({ id: 42, title: 7, status: {}, phase: [], assignees: 'someone', body: null, changes: {} })],
    });
    expect(page?.trails[0]).toEqual({
      number: 42,
      title: 'Trail 42',
      type: 'feature',
      priority: 'none',
      assignees: [],
      createdAt: '2026-03-01T00:00:00Z',
      lastActivityAt: '2026-03-02T00:00:00Z',
      changes: [],
    });
  });

  it.each(WRONG_TYPES)('rejects %s', (_label, value) => {
    expect(readTrailPage(value)).toBeUndefined();
  });

  it('rejects an object with no list of items', () => {
    expect(readTrailPage({})).toBeUndefined();
    expect(readTrailPage({ items: 'none' })).toBeUndefined();
    expect(readTrailPage({ error: 'not logged in' })).toBeUndefined();
  });
});

describe('readTrailDetail', () => {
  const mergeability = {
    head_sha: 'a'.repeat(40),
    mergeable: false,
    conflict_status: 'clean',
    checks: {
      availability: 'available',
      runs: [
        {
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://ci.example.test/runs/1',
          started_at: '2026-03-02T00:00:00Z',
          completed_at: '2026-03-02T00:01:00Z',
          app_name: 'CI',
        },
        { name: 'deploy', status: 'in_progress', conclusion: null, details_url: null, app_name: null },
      ],
    },
    gates: [
      {
        id: 'gate-1',
        gate_key: 'approvals',
        gate_type: 'approvals',
        blocking: true,
        status: 'failed',
        state: 'evaluated',
        outcome: 'failed',
        rationale: '0 of 1 required approvals.',
        finding_count: null,
        value: { required: 1, approved: 0 },
      },
      { gate_key: 'findings', gate_type: 'findings', blocking: true, status: 'passed', rationale: null, finding_count: 0 },
      { gate_key: 'up_to_date', gate_type: 'up_to_date', blocking: false, status: 'skipped', state: 'disabled' },
    ],
  };

  it('reads the trail with its address, its project, and the merge state of each change', () => {
    const item = listItem();
    const detail = readTrailDetail({
      ...item,
      project: { id: 'project-1', name: 'acme', provider: 'github' },
      url: 'https://entire.example.test/gh/acme/-/trails/42',
      changes: [
        {
          ...(item.changes as Record<string, unknown>[])[0],
          url: 'https://entire.example.test/gh/acme/-/trails/42/changes/widget/7',
          mergeability,
        },
      ],
    });
    expect(detail?.url).toBe('https://entire.example.test/gh/acme/-/trails/42');
    expect(detail?.projectName).toBe('acme');
    expect(detail?.number).toBe(42);
    const [change] = detail?.changes ?? [];
    expect(change?.url).toBe('https://entire.example.test/gh/acme/-/trails/42/changes/widget/7');
    expect(change?.mergeability).toEqual({
      mergeable: false,
      headSha: 'a'.repeat(40),
      conflictStatus: 'clean',
      checksAvailability: 'available',
      checks: [
        {
          name: 'build',
          status: 'completed',
          conclusion: 'success',
          detailsUrl: 'https://ci.example.test/runs/1',
          appName: 'CI',
        },
        { name: 'deploy', status: 'in_progress' },
      ],
      gates: [
        { key: 'approvals', blocking: true, status: 'failed', rationale: '0 of 1 required approvals.' },
        { key: 'findings', blocking: true, status: 'passed', findingCount: 0 },
        { key: 'up_to_date', blocking: false, status: 'skipped' },
      ],
    });
  });

  it('reads a trail that reports no address or project', () => {
    const detail = readTrailDetail(listItem());
    expect(detail?.url).toBeUndefined();
    expect(detail?.projectName).toBeUndefined();
    expect(detail?.changes[0]?.mergeability).toBeUndefined();
  });

  it('treats a change as not mergeable unless the CLI says it is', () => {
    const detail = readTrailDetail(
      listItem({ changes: [{ repository: 'widget', number: 7, mergeability: { mergeable: 'yes' } }] }),
    );
    expect(detail?.changes[0]?.mergeability).toEqual({ mergeable: false, checks: [], gates: [] });
  });

  it('skips a CI run with no name and a gate with no key', () => {
    const detail = readTrailDetail(
      listItem({
        changes: [
          {
            repository: 'widget',
            number: 7,
            mergeability: {
              mergeable: true,
              checks: { runs: [{ status: 'completed' }, { name: 'lint' }, 'not a run'] },
              gates: [{ status: 'passed' }, { gate_type: 'checks', status: 'passed' }, null],
            },
          },
        ],
      }),
    );
    expect(detail?.changes[0]?.mergeability?.checks).toEqual([{ name: 'lint' }]);
    // A gate with no key is named by its type.
    expect(detail?.changes[0]?.mergeability?.gates).toEqual([{ key: 'checks', blocking: false, status: 'passed' }]);
  });

  it.each(WRONG_TYPES)('rejects %s', (_label, value) => {
    expect(readTrailDetail(value)).toBeUndefined();
  });

  it('rejects an object with no trail number', () => {
    expect(readTrailDetail({ title: 'A trail' })).toBeUndefined();
    expect(readTrailDetail({ number: '42' })).toBeUndefined();
  });
});

describe('readTrailTimeline', () => {
  it('reads commits, reviews, and lifecycle entries', () => {
    const timeline = readTrailTimeline({
      $schema: 'https://entire.example.test/schema.json',
      items: [
        {
          id: 'event-1',
          kind: 'commit',
          actor: {
            login: 'fixture-author',
            identity: { kind: 'user', account_id: 'account-1', display_name: 'Fixture Author', handles: [] },
          },
          occurredAt: '2026-03-02T09:00:00Z',
          title: 'Add the parser',
          commitSha: 'b'.repeat(40),
          additions: 12,
          deletions: 3,
          filesChanged: 2,
          statsPending: false,
          checkpointCount: 1,
          sessionCount: 2,
          agents: ['Claude Code', { name: 'Codex' }, { id: 'no-name' }, 7],
        },
        {
          id: 'event-2',
          kind: 'review_posted',
          actor: { login: null, label: 'Review Agent', identity: { kind: 'agent', display_name: null } },
          occurredAt: '2026-03-02T10:00:00Z',
          findingCount: 2,
          commentId: 'comment-1',
        },
        { id: 'event-3', kind: 'trail_created', actor: { login: 'fixture-author' }, occurredAt: '2026-03-01T00:00:00Z' },
      ],
      nextPageToken: 'next',
      commitCount: 11,
      incomplete: false,
    });
    expect(timeline).toEqual({
      events: [
        {
          kind: 'commit',
          actor: 'Fixture Author',
          occurredAt: '2026-03-02T09:00:00Z',
          title: 'Add the parser',
          commitSha: 'b'.repeat(40),
          additions: 12,
          deletions: 3,
          filesChanged: 2,
          checkpointCount: 1,
          agents: ['Claude Code', 'Codex'],
        },
        {
          kind: 'review_posted',
          actor: 'Review Agent',
          occurredAt: '2026-03-02T10:00:00Z',
          agents: [],
          findingCount: 2,
        },
        { kind: 'trail_created', actor: 'fixture-author', occurredAt: '2026-03-01T00:00:00Z', agents: [] },
      ],
      nextPageToken: 'next',
      commitCount: 11,
      incomplete: false,
    });
  });

  it('keeps an entry of a kind it does not know', () => {
    const timeline = readTrailTimeline({ items: [{ kind: 'approval_granted' }], nextPageToken: null });
    expect(timeline).toEqual({ events: [{ kind: 'approval_granted', agents: [] }], incomplete: false });
  });

  it('skips an entry with no kind', () => {
    expect(readTrailTimeline({ items: [{ title: 'No kind' }, 'text', null] })?.events).toEqual([]);
  });

  it('reads an entry with no actor', () => {
    expect(readTrailTimeline({ items: [{ kind: 'commit', actor: null }] })?.events[0]?.actor).toBeUndefined();
    expect(readTrailTimeline({ items: [{ kind: 'commit', actor: {} }] })?.events[0]?.actor).toBeUndefined();
  });

  it('says when the CLI could not read the whole history', () => {
    expect(readTrailTimeline({ items: [], incomplete: true })?.incomplete).toBe(true);
    expect(readTrailTimeline({ items: [], incomplete: 'true' })?.incomplete).toBe(false);
  });

  it.each(WRONG_TYPES)('rejects %s', (_label, value) => {
    expect(readTrailTimeline(value)).toBeUndefined();
  });

  it('rejects an object with no list of items', () => {
    expect(readTrailTimeline({ commitCount: 3 })).toBeUndefined();
  });
});
