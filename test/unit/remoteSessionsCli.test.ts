import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntireCli } from '../../src/core/entireCli';
import { exec } from '../../src/core/exec';
import { Lane } from '../../src/core/scheduler';

const FAKE_ENTIRE = fileURLToPath(new URL('../fake-entire/entire', import.meta.url));
const SESSIONS = 'api --to cell /api/v1/repos/{repo_id}/sessions?scope=all&limit=50';
const SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CHECKPOINTS = `api --to cell /api/v1/repos/{repo_id}/sessions/${SESSION_ID}/transcript`;

interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

const json = (value: unknown, exitCode = 0): Reply => ({ stdout: `${JSON.stringify(value, null, 2)}\n`, exitCode });

describe('EntireCli calls to the Entire API against the fake CLI', () => {
  let dir: string;
  let logFile: string;
  let cli: EntireCli;

  const scenario = (replies: Record<string, Reply>): void => {
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(replies));
  };

  const invocations = (): string[][] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      : [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-api-test-')));
    logFile = path.join(dir, 'invocations.log');
    vi.stubEnv('FAKE_ENTIRE_SCENARIO', path.join(dir, 'scenario.json'));
    vi.stubEnv('FAKE_ENTIRE_LOG', logFile);
    cli = new EntireCli(FAKE_ENTIRE, exec, new Lane(4));
    scenario({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('remoteSessions', () => {
    it('reads one page of the sessions Entire lists', async () => {
      scenario({
        [SESSIONS]: json({
          sessions: [{ sessionId: SESSION_ID, displayName: 'Rework the Parser', agent: 'Claude Code', checkpointCount: 3 }],
          next_cursor: 'next',
        }),
      });
      const page = await cli.remoteSessions(dir, 50);
      expect(page).toEqual({
        ok: true,
        value: {
          sessions: [{ sessionId: SESSION_ID, name: 'Rework the Parser', agent: 'Claude Code', checkpointCount: 3 }],
          nextCursor: 'next',
        },
      });
    });

    it('sends a GET: a path, and no method, field, or body flag', async () => {
      scenario({ 'api *': json({ sessions: [] }) });
      await cli.remoteSessions(dir, 50);
      await cli.remoteSessions(dir, 50, 'abc=');
      await cli.remoteSessionCheckpoints(dir, SESSION_ID);
      const calls = invocations();
      expect(calls).toEqual([
        ['api', '--to', 'cell', '/api/v1/repos/{repo_id}/sessions?scope=all&limit=50'],
        ['api', '--to', 'cell', '/api/v1/repos/{repo_id}/sessions?scope=all&limit=50&cursor=abc%3D'],
        ['api', '--to', 'cell', `/api/v1/repos/{repo_id}/sessions/${SESSION_ID}/transcript`],
      ]);
      for (const call of calls) {
        expect(call.some((arg) => /^(-X|--method|-f|-F|--raw-field|--field|--input|-H|--header)/.test(arg))).toBe(false);
      }
    });

    it('refuses a page size or a cursor that could not be one, without running the CLI', async () => {
      for (const limit of [0, 201, 1.5, Number.NaN]) {
        expect((await cli.remoteSessions(dir, limit)).ok).toBe(false);
      }
      for (const cursor of ['', 'two words', 'line\nbreak']) {
        expect((await cli.remoteSessions(dir, 50, cursor)).ok).toBe(false);
      }
      expect(invocations()).toEqual([]);
    });

    it('reports that no login is saved', async () => {
      scenario({ [SESSIONS]: { stderr: "not logged in: run 'entire login' to authenticate\n", exitCode: 1 } });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure.kind).toBe('notLoggedIn');
    });

    it('reports a login the API no longer accepts', async () => {
      scenario({ [SESSIONS]: json({ error: 'unauthorized' }, 1) });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure).toMatchObject({ kind: 'notLoggedIn', detail: 'unauthorized' });
    });

    it('reports a repository that Entire does not have', async () => {
      scenario({ [SESSIONS]: { stderr: 'no active mirror for acme/widget to resolve {repo_id}\n', exitCode: 1 } });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure).toMatchObject({
        kind: 'noAccess',
        message: 'This repository is not on Entire, or your login cannot see it.',
      });
    });

    it('reads what the API said when it refused the call', async () => {
      scenario({ [SESSIONS]: json({ error: 'invalid cursor' }, 1) });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure).toEqual({
        kind: 'exit',
        message: 'The Entire CLI could not list the sessions on Entire.',
        detail: 'invalid cursor',
      });
    });

    it('does not take a reply of another shape for a page', async () => {
      scenario({ [SESSIONS]: json({ items: [] }) });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure.kind).toBe('unexpectedOutput');
    });

    it('does not take output that is not JSON for a page', async () => {
      scenario({ [SESSIONS]: { stdout: '<html>Bad gateway</html>' } });
      const page = await cli.remoteSessions(dir, 50);
      expect(page.ok ? undefined : page.failure.kind).toBe('unexpectedOutput');
    });
  });

  describe('remoteSessionCheckpoints', () => {
    it('lists the checkpoints of a session, newest first', async () => {
      scenario({
        [CHECKPOINTS]: json({
          sessions: [{ messages: [{ role: 'user', text: 'Hello' }] }],
          checkpoints: [
            { checkpointId: 'a1b2c3d4e5f6', message: 'First\n\nBody', timestamp: '2026-03-01T09:00:00Z' },
            { checkpointId: '0123456789ab', message: 'Second', timestamp: '2026-03-01T09:05:00Z' },
          ],
        }),
      });
      const checkpoints = await cli.remoteSessionCheckpoints(dir, SESSION_ID);
      expect(checkpoints).toEqual({
        ok: true,
        value: [
          { checkpointId: '0123456789ab', message: 'Second', date: '2026-03-01T09:05:00Z' },
          { checkpointId: 'a1b2c3d4e5f6', message: 'First', date: '2026-03-01T09:00:00Z' },
        ],
      });
    });

    it('reports a session Entire does not have', async () => {
      scenario({ [CHECKPOINTS]: json({ error: 'session transcript not found' }, 1) });
      const checkpoints = await cli.remoteSessionCheckpoints(dir, SESSION_ID);
      expect(checkpoints.ok ? undefined : checkpoints.failure).toEqual({
        kind: 'notFound',
        message: 'Entire could not find this session.',
        detail: 'session transcript not found',
      });
    });

    it('refuses a session ID that could be read as a flag or as a path, without running the CLI', async () => {
      for (const sessionId of ['--input', '-X', '../x', 'a/b', 'a b', '', '{repo_id}']) {
        expect((await cli.remoteSessionCheckpoints(dir, sessionId)).ok).toBe(false);
      }
      expect(invocations()).toEqual([]);
    });

    it('stops when the caller gives up', async () => {
      scenario({ [CHECKPOINTS]: { stdout: '', exitCode: 0 } });
      const abort = new AbortController();
      abort.abort();
      const checkpoints = await cli.remoteSessionCheckpoints(dir, SESSION_ID, abort.signal);
      expect(checkpoints.ok ? undefined : checkpoints.failure.kind).toBe('aborted');
    });
  });
});
