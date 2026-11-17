import { describe, expect, it } from 'vitest';
import {
  readRemoteCheckpoints,
  readRemoteSessionPage,
  remoteRefusal,
  remoteSessionCheckpointsPath,
  remoteSessionsPath,
} from '../../src/core/remoteSessions';

/** One session as Entire's API lists it, with the fields the extension does not read left in. */
const listed = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  displayName: 'Rework the Parser and Fix Its Tests',
  customName: null,
  isPublic: false,
  agent: 'Claude Code',
  model: 'test-model',
  kind: null,
  prompt: 'Rework the parser',
  startedAt: '2026-03-01T09:00:00.000Z',
  lastActivityAt: '2026-03-02T10:00:00.000Z',
  checkpointCount: 12,
  subagentCount: 0,
  stepCount: 40,
  ...overrides,
});

describe('remoteSessionsPath', () => {
  it('asks for the sessions of every branch and leaves the repository for the CLI to fill in', () => {
    expect(remoteSessionsPath(50)).toBe('/api/v1/repos/{repo_id}/sessions?scope=all&limit=50');
  });

  it('escapes the cursor, which is opaque', () => {
    expect(remoteSessionsPath(50, 'a+b/c=&limit=1')).toBe(
      '/api/v1/repos/{repo_id}/sessions?scope=all&limit=50&cursor=a%2Bb%2Fc%3D%26limit%3D1',
    );
  });
});

describe('remoteSessionCheckpointsPath', () => {
  it('names the session in the path', () => {
    expect(remoteSessionCheckpointsPath('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')).toBe(
      '/api/v1/repos/{repo_id}/sessions/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/transcript',
    );
  });

  it('escapes a session ID that holds a character with a meaning in a path', () => {
    expect(remoteSessionCheckpointsPath('ses:1')).toBe('/api/v1/repos/{repo_id}/sessions/ses%3A1/transcript');
  });
});

describe('readRemoteSessionPage', () => {
  it('reads the name, agent, model, count, and times of each session', () => {
    const page = readRemoteSessionPage({ sessions: [listed()], next_cursor: 'abc', history_complete: true });
    expect(page).toEqual({
      sessions: [
        {
          sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          name: 'Rework the Parser and Fix Its Tests',
          agent: 'Claude Code',
          model: 'test-model',
          checkpointCount: 12,
          startedAt: '2026-03-01T09:00:00.000Z',
          lastActivityAt: '2026-03-02T10:00:00.000Z',
          prompt: 'Rework the parser',
        },
      ],
      nextCursor: 'abc',
    });
  });

  it('has no cursor on the last page', () => {
    expect(readRemoteSessionPage({ sessions: [], next_cursor: null })).toEqual({ sessions: [] });
  });

  it('prefers a name a person set', () => {
    const page = readRemoteSessionPage({ sessions: [listed({ customName: 'Release prep' })] });
    expect(page?.sessions[0]?.name).toBe('Release prep');
  });

  it('keeps a session that has no name, and drops one that has no ID or is listed twice', () => {
    const page = readRemoteSessionPage({
      sessions: [listed({ displayName: '  ' }), listed(), { displayName: 'No ID' }, 'text', null],
    });
    expect(page?.sessions).toHaveLength(1);
    expect(page?.sessions[0]?.name).toBeUndefined();
  });

  it('drops a count that is not a whole number', () => {
    const page = readRemoteSessionPage({ sessions: [listed({ checkpointCount: '12' })] });
    expect(page?.sessions[0]?.checkpointCount).toBeUndefined();
  });

  it('does not take another shape for a page', () => {
    expect(readRemoteSessionPage({ error: 'invalid cursor' })).toBeUndefined();
    expect(readRemoteSessionPage([])).toBeUndefined();
    expect(readRemoteSessionPage(null)).toBeUndefined();
  });
});

describe('readRemoteCheckpoints', () => {
  const checkpoint = (checkpointId: string, timestamp: string, message = 'Subject line\n\nBody.'): unknown => ({
    checkpointId,
    commitSha: '0123456789abcdef0123456789abcdef01234567',
    message,
    additions: 1,
    timestamp,
    authorUsername: 'someone',
  });

  it('lists the checkpoints newest first, each with the subject of its commit', () => {
    const checkpoints = readRemoteCheckpoints({
      sessionId: 's1',
      sessions: [{ messages: [] }],
      checkpoints: [
        checkpoint('a1b2c3d4e5f6', '2026-03-01T09:00:00Z'),
        checkpoint('01JAAAAAAAAAAAAAAAAAAAAAA1', '2026-03-02T10:00:00Z', 'Newest\n\nEntire-Checkpoint: x'),
      ],
    });
    expect(checkpoints).toEqual([
      {
        checkpointId: '01JAAAAAAAAAAAAAAAAAAAAAA1',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        message: 'Newest',
        date: '2026-03-02T10:00:00Z',
      },
      {
        checkpointId: 'a1b2c3d4e5f6',
        commitSha: '0123456789abcdef0123456789abcdef01234567',
        message: 'Subject line',
        date: '2026-03-01T09:00:00Z',
      },
    ]);
  });

  it('drops an entry whose ID is not a checkpoint ID, and one listed twice', () => {
    const checkpoints = readRemoteCheckpoints({
      checkpoints: [
        checkpoint('--help', '2026-03-01T09:00:00Z'),
        checkpoint('a1b2c3d4e5f6', '2026-03-01T09:00:00Z'),
        checkpoint('a1b2c3d4e5f6', '2026-03-01T09:00:00Z'),
        { timestamp: '2026-03-01T09:00:00Z' },
      ],
    });
    expect(checkpoints?.map((found) => found.checkpointId)).toEqual(['a1b2c3d4e5f6']);
  });

  it('drops a commit SHA that is not one', () => {
    const checkpoints = readRemoteCheckpoints({ checkpoints: [{ checkpointId: 'a1b2c3d4e5f6', commitSha: 'HEAD~1' }] });
    expect(checkpoints).toEqual([{ checkpointId: 'a1b2c3d4e5f6' }]);
  });

  it('does not take a reply with no checkpoint list for an empty one', () => {
    expect(readRemoteCheckpoints({ error: 'session transcript not found' })).toBeUndefined();
    expect(readRemoteCheckpoints({ checkpoints: [] })).toEqual([]);
  });
});

describe('remoteRefusal', () => {
  it('reads what the API said', () => {
    expect(remoteRefusal('{\n  "error": "session transcript not found"\n}')).toBe('session transcript not found');
    expect(remoteRefusal('{"title":"Unauthorized","detail":"token expired"}')).toBe('token expired: Unauthorized');
  });

  it('is undefined for output that is not a refusal', () => {
    expect(remoteRefusal('')).toBeUndefined();
    expect(remoteRefusal('not json')).toBeUndefined();
    expect(remoteRefusal('{"sessions":[]}')).toBeUndefined();
    expect(remoteRefusal('[1]')).toBeUndefined();
  });
});
