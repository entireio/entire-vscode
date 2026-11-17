import { describe, expect, it } from 'vitest';
import {
  readCheckpointDetail,
  readCheckpointRows,
  readSessionRows,
  readStatus,
  totalTokens,
} from '../../src/core/schemas';

const WRONG_TYPES: [string, unknown][] = [
  ['undefined', undefined],
  ['null', null],
  ['a string', 'enabled'],
  ['a number', 1],
  ['a boolean', true],
];

describe('readStatus', () => {
  it('reads a full status payload', () => {
    const status = readStatus({
      enabled: true,
      agents: ['claude-code', 'codex'],
      active_sessions: [
        {
          agent: 'Claude Code',
          session_id: '11111111-2222-4333-8444-555555555555',
          worktree_path: '/repo',
          branch: 'main',
          model: 'claude-fable-5',
          status: 'active',
          capture_degraded: false,
        },
      ],
      hooks_outdated: ['claude-code'],
    });
    expect(status).toStrictEqual({
      enabled: true,
      agents: ['claude-code', 'codex'],
      activeSessions: [
        {
          sessionId: '11111111-2222-4333-8444-555555555555',
          agent: 'Claude Code',
          model: 'claude-fable-5',
          status: 'active',
          branch: 'main',
          worktreePath: '/repo',
        },
      ],
    });
  });

  it('defaults the lists and leaves optional fields absent', () => {
    expect(readStatus({ enabled: false })).toStrictEqual({ enabled: false, agents: [], activeSessions: [] });
  });

  it('keeps the error text of a repo the CLI could not evaluate', () => {
    expect(readStatus({ enabled: false, error: 'not a git repository' })).toStrictEqual({
      enabled: false,
      error: 'not a git repository',
      agents: [],
      activeSessions: [],
    });
  });

  it('drops list entries of the wrong type instead of rejecting the payload', () => {
    const status = readStatus({
      enabled: true,
      agents: ['claude-code', 7, null, '', { name: 'x' }],
      active_sessions: ['oops', null, [], { session_id: 's1', agent: 3, status: '' }],
    });
    expect(status).toStrictEqual({ enabled: true, agents: ['claude-code'], activeSessions: [{ sessionId: 's1' }] });
  });

  it('defaults lists that have the wrong type', () => {
    expect(readStatus({ enabled: true, agents: 'claude-code', active_sessions: {} })).toStrictEqual({
      enabled: true,
      agents: [],
      activeSessions: [],
    });
  });

  it.each([...WRONG_TYPES, ['an array', [{ enabled: true }]]])('returns undefined for %s', (_label, value) => {
    expect(readStatus(value)).toBeUndefined();
  });

  it.each([
    ['missing', {}],
    ['a string', { enabled: 'true' }],
    ['a number', { enabled: 1 }],
    ['null', { enabled: null }],
  ])('returns undefined when `enabled` is %s', (_label, value) => {
    expect(readStatus(value)).toBeUndefined();
  });
});

describe('readCheckpointRows', () => {
  it('reads a full row', () => {
    const rows = readCheckpointRows([
      {
        checkpoint_id: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
        session_id: 's1',
        agent: 'Claude Code',
        date: '2026-03-04T12:20:14+02:00',
        message: 'docs: tidy the changelog',
        session_count: 2,
        session_ids: ['s1', 's2'],
        is_logs_only: true,
      },
    ]);
    expect(rows).toStrictEqual([
      {
        checkpointId: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
        sessionId: 's1',
        agent: 'Claude Code',
        date: '2026-03-04T12:20:14+02:00',
        message: 'docs: tidy the changelog',
        sessionIds: ['s1', 's2'],
        sessionCount: 2,
      },
    ]);
  });

  it('defaults missing fields', () => {
    expect(readCheckpointRows([{ checkpoint_id: 'abcdef012345' }])).toStrictEqual([
      { checkpointId: 'abcdef012345', sessionIds: [] },
    ]);
  });

  it('drops entries without an ID and keeps the rest in order', () => {
    const rows = readCheckpointRows([
      { checkpoint_id: 'aaaaaaaaaaaa' },
      { session_id: 's1', message: 'no id' },
      { checkpoint_id: '' },
      { checkpoint_id: 42 },
      { checkpoint_id: null },
      'bbbbbbbbbbbb',
      null,
      ['cccccccccccc'],
      { checkpoint_id: 'dddddddddddd' },
    ]);
    expect(rows?.map((row) => row.checkpointId)).toEqual(['aaaaaaaaaaaa', 'dddddddddddd']);
  });

  it('merges session_id into sessionIds when the list is missing', () => {
    const [row] = readCheckpointRows([{ checkpoint_id: 'abcdef012345', session_id: 's1' }]) ?? [];
    expect(row?.sessionIds).toEqual(['s1']);
    expect(row?.sessionId).toBe('s1');
  });

  it('puts session_id first when the list does not include it', () => {
    const [row] = readCheckpointRows([{ checkpoint_id: 'abcdef012345', session_id: 's1', session_ids: ['s2', 's3'] }]) ?? [];
    expect(row?.sessionIds).toEqual(['s1', 's2', 's3']);
  });

  it('does not repeat session_id when the list already includes it', () => {
    const [row] = readCheckpointRows([{ checkpoint_id: 'abcdef012345', session_id: 's2', session_ids: ['s1', 's2'] }]) ?? [];
    expect(row?.sessionIds).toEqual(['s1', 's2']);
  });

  it('keeps the list when there is no session_id', () => {
    const [row] = readCheckpointRows([{ checkpoint_id: 'abcdef012345', session_ids: ['s1', 7, '', 's2'] }]) ?? [];
    expect(row?.sessionIds).toEqual(['s1', 's2']);
    expect(row).not.toHaveProperty('sessionId');
  });

  it('ignores fields of the wrong type', () => {
    expect(
      readCheckpointRows([
        { checkpoint_id: 'abcdef012345', agent: 1, date: false, message: ['x'], session_count: '2', session_ids: 's1' },
      ]),
    ).toStrictEqual([{ checkpointId: 'abcdef012345', sessionIds: [] }]);
  });

  it('returns an empty list for an empty array', () => {
    expect(readCheckpointRows([])).toEqual([]);
  });

  it.each([...WRONG_TYPES, ['an object', { checkpoint_id: 'abcdef012345' }]])('returns undefined for %s', (_label, value) => {
    expect(readCheckpointRows(value)).toBeUndefined();
  });
});

describe('readCheckpointDetail', () => {
  it('reads a full detail payload', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
      strategy: 'manual-commit',
      branch: 'main',
      checkpoints_count: 3,
      files_touched: ['CHANGELOG.md', 'README.md'],
      session_count: 1,
      sessions: [
        {
          index: 0,
          session_id: 's1',
          agent: 'Claude Code',
          model: 'claude-fable-5',
          kind: 'review',
          created_at: '2026-03-04T12:20:14Z',
          files_touched: ['CHANGELOG.md'],
          token_usage: {
            input_tokens: 10,
            cache_creation_tokens: 20,
            cache_read_tokens: 30,
            output_tokens: 40,
            api_call_count: 5,
          },
          summary: { intent: 'Drop the entry', outcome: 'Dropped', friction: ['none'] },
        },
      ],
      tasks: [
        {
          tool_use_id: 'toolu_1',
          agent_id: 'agent-1',
          subagent_type: 'Explore',
          task_description: 'Find the changelog',
          started_at: '2026-03-04T12:00:00Z',
          completed_at: '2026-03-04T12:01:00Z',
        },
      ],
    });
    expect(detail).toStrictEqual({
      checkpointId: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
      branch: 'main',
      promptCount: 3,
      filesTouched: ['CHANGELOG.md', 'README.md'],
      sessions: [
        {
          index: 0,
          sessionId: 's1',
          agent: 'Claude Code',
          model: 'claude-fable-5',
          kind: 'review',
          createdAt: '2026-03-04T12:20:14Z',
          filesTouched: ['CHANGELOG.md'],
          tokenUsage: { input: 10, cacheCreation: 20, cacheRead: 30, output: 40, apiCalls: 5 },
          summary: { intent: 'Drop the entry', outcome: 'Dropped' },
        },
      ],
      tasks: [
        {
          toolUseId: 'toolu_1',
          agentId: 'agent-1',
          subagentType: 'Explore',
          description: 'Find the changelog',
          startedAt: '2026-03-04T12:00:00Z',
          completedAt: '2026-03-04T12:01:00Z',
        },
      ],
      partial: false,
    });
  });

  it('defaults everything except the ID', () => {
    expect(readCheckpointDetail({ checkpoint_id: 'abcdef012345' })).toStrictEqual({
      checkpointId: 'abcdef012345',
      filesTouched: [],
      sessions: [],
      tasks: [],
      partial: false,
    });
  });

  it('marks a partial checkpoint', () => {
    expect(readCheckpointDetail({ checkpoint_id: 'abcdef012345', partial: true })?.partial).toBe(true);
  });

  it.each(['true', 1, null, {}])('does not treat partial: %j as partial', (partial) => {
    expect(readCheckpointDetail({ checkpoint_id: 'abcdef012345', partial })?.partial).toBe(false);
  });

  it('defaults a session with no fields, and numbers it by position', () => {
    const detail = readCheckpointDetail({ checkpoint_id: 'abcdef012345', sessions: [{ index: 0 }, {}, { agent: 'Codex' }] });
    expect(detail?.sessions).toStrictEqual([
      { index: 0, filesTouched: [] },
      { index: 1, filesTouched: [] },
      { index: 2, agent: 'Codex', filesTouched: [] },
    ]);
  });

  it('keeps the index the CLI reports when it differs from the position', () => {
    const detail = readCheckpointDetail({ checkpoint_id: 'abcdef012345', sessions: [{ index: 2, session_id: 's3' }] });
    expect(detail?.sessions[0]?.index).toBe(2);
  });

  it('defaults missing token counts to zero', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: 'abcdef012345',
      sessions: [{ token_usage: { input_tokens: 7, output_tokens: 'many' } }],
    });
    expect(detail?.sessions[0]?.tokenUsage).toStrictEqual({ input: 7, cacheCreation: 0, cacheRead: 0, output: 0, apiCalls: 0 });
  });

  it('leaves token usage absent when it is missing or not an object', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: 'abcdef012345',
      sessions: [{}, { token_usage: null }, { token_usage: 12 }, { token_usage: [1, 2] }],
    });
    for (const session of detail?.sessions ?? []) expect(session).not.toHaveProperty('tokenUsage');
    expect(detail?.sessions).toHaveLength(4);
  });

  it('leaves the summary absent when it has neither intent nor outcome', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: 'abcdef012345',
      sessions: [{ summary: {} }, { summary: { intent: '', outcome: '' } }, { summary: 'text' }, { summary: { outcome: 'Done' } }],
    });
    expect(detail?.sessions.map((session) => session.summary)).toEqual([undefined, undefined, undefined, { outcome: 'Done' }]);
    expect(detail?.sessions[0]).not.toHaveProperty('summary');
  });

  it('drops tasks without a tool-use ID', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: 'abcdef012345',
      tasks: [{ agent_id: 'a' }, { tool_use_id: '' }, 'toolu_x', null, { tool_use_id: 'toolu_2' }],
    });
    expect(detail?.tasks).toStrictEqual([{ toolUseId: 'toolu_2' }]);
  });

  it('drops session entries that are not objects', () => {
    const detail = readCheckpointDetail({ checkpoint_id: 'abcdef012345', sessions: ['s1', null, 3, { session_id: 's1' }] });
    expect(detail?.sessions.map((session) => session.sessionId)).toEqual(['s1']);
  });

  it('ignores fields of the wrong type', () => {
    expect(
      readCheckpointDetail({
        checkpoint_id: 'abcdef012345',
        branch: 7,
        checkpoints_count: '3',
        files_touched: 'CHANGELOG.md',
        sessions: {},
        tasks: 'none',
      }),
    ).toStrictEqual({ checkpointId: 'abcdef012345', filesTouched: [], sessions: [], tasks: [], partial: false });
  });

  it('does not accept a count that is not a finite number', () => {
    const detail = readCheckpointDetail({ checkpoint_id: 'abcdef012345', checkpoints_count: Number.NaN });
    expect(detail).not.toHaveProperty('promptCount');
  });

  it.each([...WRONG_TYPES, ['an array', [{ checkpoint_id: 'abcdef012345' }]]])('returns undefined for %s', (_label, value) => {
    expect(readCheckpointDetail(value)).toBeUndefined();
  });

  it.each([{}, { checkpoint_id: '' }, { checkpoint_id: 12 }, { checkpointId: 'abcdef012345' }])(
    'returns undefined when the ID is missing: %j',
    (value) => {
      expect(readCheckpointDetail(value)).toBeUndefined();
    },
  );
});

describe('readSessionRows', () => {
  it('reads a full row', () => {
    const rows = readSessionRows([
      {
        session_id: 's1',
        agent: 'Claude Code',
        model: 'claude-fable-5',
        status: 'idle',
        kind: 'review',
        started_at: '2026-03-04T10:00:00Z',
        ended_at: '2026-03-04T12:00:00Z',
        last_active: '2026-03-04T11:59:00Z',
        turns: 12,
        pending_turns: 0,
        last_checkpoint_id: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
        tokens: { total: 100, input: 10, cache_read: 60, cache_write: 20, output: 10 },
        last_prompt: 'tidy the changelog',
        worktree: '/repo',
      },
    ]);
    expect(rows).toStrictEqual([
      {
        sessionId: 's1',
        agent: 'Claude Code',
        model: 'claude-fable-5',
        status: 'idle',
        kind: 'review',
        startedAt: '2026-03-04T10:00:00Z',
        endedAt: '2026-03-04T12:00:00Z',
        lastActive: '2026-03-04T11:59:00Z',
        turns: 12,
        pendingTurns: 0,
        lastCheckpointId: '01HZXK3M5N7P9R2T4V6W8Y0A1B',
        tokens: { total: 100, input: 10, cacheRead: 60, cacheWrite: 20, output: 10 },
        lastPrompt: 'tidy the changelog',
      },
    ]);
  });

  it('defaults missing fields', () => {
    expect(readSessionRows([{ session_id: 's1' }])).toStrictEqual([{ sessionId: 's1' }]);
  });

  it('defaults missing token counts to zero', () => {
    const [row] = readSessionRows([{ session_id: 's1', tokens: { total: 5 } }]) ?? [];
    expect(row?.tokens).toStrictEqual({ total: 5, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });

  it('drops entries without an ID and keeps the rest in order', () => {
    const rows = readSessionRows([{ session_id: 's1' }, { agent: 'Codex' }, { session_id: '' }, { session_id: 9 }, 's2', null, { session_id: 's3' }]);
    expect(rows?.map((row) => row.sessionId)).toEqual(['s1', 's3']);
  });

  it('ignores fields of the wrong type', () => {
    expect(readSessionRows([{ session_id: 's1', turns: '12', pending_turns: null, tokens: 100, status: 3 }])).toStrictEqual([
      { sessionId: 's1' },
    ]);
  });

  it('returns an empty list for an empty array', () => {
    expect(readSessionRows([])).toEqual([]);
  });

  it.each([...WRONG_TYPES, ['an object', { session_id: 's1' }]])('returns undefined for %s', (_label, value) => {
    expect(readSessionRows(value)).toBeUndefined();
  });
});

describe('totalTokens', () => {
  it('adds input, output, cache reads, and cache writes', () => {
    expect(totalTokens({ input: 1, cacheCreation: 20, cacheRead: 300, output: 4000, apiCalls: 99 })).toBe(4321);
  });

  it('does not count API calls', () => {
    expect(totalTokens({ input: 0, cacheCreation: 0, cacheRead: 0, output: 0, apiCalls: 50 })).toBe(0);
  });

  it('totals usage read from a CLI payload', () => {
    const detail = readCheckpointDetail({
      checkpoint_id: 'abcdef012345',
      sessions: [{ token_usage: { input_tokens: 100, cache_read_tokens: 10_000_000, output_tokens: 7_798, cache_creation_tokens: 400_000 } }],
    });
    const usage = detail?.sessions[0]?.tokenUsage;
    expect(usage && totalTokens(usage)).toBe(10_407_898);
  });
});
