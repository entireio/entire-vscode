import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntireCli } from '../../src/core/entireCli';
import { exec, type Exec, type ExecResult } from '../../src/core/exec';
import { Lane } from '../../src/core/scheduler';

const FAKE_ENTIRE = fileURLToPath(new URL('../fake-entire/entire', import.meta.url));
const HEX = 'abcdef012345';
const ULID = '01HZXK3M5N7P9R2T4V6W8Y0A1B';
const SESSION = '11111111-2222-4333-8444-555555555555';
/** What the CLI prints, with exit code 0, in a repository where Entire is turned off. */
const DISABLED_PROSE = 'Entire is disabled. Run `entire enable` to re-enable.\n';

interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  hang?: boolean;
  repeat?: { text: string; times: number };
}

describe('EntireCli against the fake CLI', () => {
  let dir: string;
  let logFile: string;
  let cli: EntireCli;
  let logLines: string[];

  /** Tells the fake CLI what to reply, keyed by its arguments joined with spaces. */
  const scenario = (replies: Record<string, Reply>): void => {
    writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(replies));
  };

  /** Every invocation of the fake CLI so far, as argument lists. */
  const invocations = (): string[][] =>
    existsSync(logFile)
      ? readFileSync(logFile, 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as string[])
      : [];

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-cli-test-')));
    logFile = path.join(dir, 'invocations.log');
    vi.stubEnv('FAKE_ENTIRE_SCENARIO', path.join(dir, 'scenario.json'));
    vi.stubEnv('FAKE_ENTIRE_LOG', logFile);
    logLines = [];
    cli = new EntireCli(FAKE_ENTIRE, exec, new Lane(4), (line) => logLines.push(line));
    scenario({});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('version', () => {
    it('reads the version', async () => {
      scenario({ version: { stdout: 'Entire CLI 0.13.3\nGo version: go1.27.4\nOS/Arch: darwin/arm64\n' } });
      expect(await cli.version(dir)).toEqual({ ok: true, value: { raw: '0.13.3', major: 0, minor: 13, patch: 3 } });
      expect(invocations()).toEqual([['version']]);
    });

    it('fails when the output names no version', async () => {
      scenario({ version: { stdout: 'something else entirely\n' } });
      const result = await cli.version(dir);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it('fails when the command exits with an error', async () => {
      scenario({ version: { stderr: 'panic: boom\n', exitCode: 2 } });
      const result = await cli.version(dir);
      expect(!result.ok && result.failure.kind).toBe('exit');
    });
  });

  describe('status', () => {
    it('reads a healthy status', async () => {
      scenario({
        'status --json': {
          stdout: JSON.stringify({
            enabled: true,
            agents: ['claude-code'],
            active_sessions: [{ agent: 'Claude Code', session_id: SESSION, status: 'active', branch: 'main' }],
          }),
        },
      });
      expect(await cli.status(dir)).toEqual({
        ok: true,
        value: {
          enabled: true,
          agents: ['claude-code'],
          activeSessions: [{ sessionId: SESSION, agent: 'Claude Code', status: 'active', branch: 'main' }],
        },
      });
      expect(invocations()).toEqual([['status', '--json']]);
    });

    it('reads a status that says Entire is off', async () => {
      scenario({ 'status --json': { stdout: '{"enabled":false,"agents":[],"active_sessions":[]}\n' } });
      expect(await cli.status(dir)).toEqual({ ok: true, value: { enabled: false, agents: [], activeSessions: [] } });
    });

    it('maps prose from a disabled repository, printed with exit code 0, to notEnabled', async () => {
      scenario({ 'status --json': { stdout: DISABLED_PROSE } });
      const result = await cli.status(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('notEnabled');
      expect(result.failure.message).not.toBe('');
    });

    it.each([
      'Entire is not enabled in this repository.\n',
      'Entire is not configured in this repository yet. Run `entire enable` first.\n',
      "○ not set up (run `entire enable` to get started)\n",
    ])('maps the prose %j to notEnabled', async (prose) => {
      scenario({ 'status --json': { stdout: prose } });
      const result = await cli.status(dir);
      expect(!result.ok && result.failure.kind).toBe('notEnabled');
    });

    it('maps garbage output with exit code 0 to unexpectedOutput', async () => {
      scenario({ 'status --json': { stdout: '<html><body>502 Bad Gateway</body></html>\n' } });
      const result = await cli.status(dir);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it.each([
      ['a JSON array', '[]'],
      ['an object without `enabled`', '{"agents":[]}'],
      ['a JSON string', '"enabled"'],
      ['JSON null', 'null'],
    ])('maps valid JSON of the wrong shape (%s) to unexpectedOutput', async (_label, stdout) => {
      scenario({ 'status --json': { stdout } });
      const result = await cli.status(dir);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it('maps empty output with exit code 0 to unexpectedOutput', async () => {
      scenario({ 'status --json': {} });
      const result = await cli.status(dir);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it('maps garbage output with a failing exit code to an exit failure that carries stderr', async () => {
      scenario({ 'status --json': { stdout: 'oops', stderr: 'line 1\nline 2\nError: settings file is corrupt\n', exitCode: 1 } });
      const result = await cli.status(dir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('exit');
      expect(result.failure.detail).toContain('settings file is corrupt');
    });

    it('shares one process between identical calls that overlap', async () => {
      scenario({ 'status --json': { stdout: '{"enabled":true}', delayMs: 300 } });
      const results = await Promise.all([cli.status(dir), cli.status(dir), cli.status(dir)]);
      expect(results.map((result) => result.ok)).toEqual([true, true, true]);
      expect(invocations()).toEqual([['status', '--json']]);
    });

    it('runs again for a call made after the first one finished', async () => {
      scenario({ 'status --json': { stdout: '{"enabled":true}' } });
      await cli.status(dir);
      await cli.status(dir);
      expect(invocations()).toHaveLength(2);
    });

    it('does not share a process between different working directories', async () => {
      const other = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-cli-test-other-')));
      try {
        scenario({ 'status --json': { stdout: '{"enabled":true}', delayMs: 200 } });
        await Promise.all([cli.status(dir), cli.status(other)]);
        expect(invocations()).toHaveLength(2);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  describe('a missing binary', () => {
    it('maps to cliMissing for every kind of call', async () => {
      const missing = new EntireCli(path.join(dir, 'no-such-entire'), exec, new Lane(4));
      const results = await Promise.all([
        missing.version(dir),
        missing.status(dir),
        missing.listCheckpoints(dir, 10),
        missing.explainCheckpoint(dir, ULID),
        missing.fullText(dir, ULID),
        missing.checkpointAuthor(dir, ULID),
        missing.brainStatus(dir),
        missing.startBrainViz(dir),
        missing.rawTranscript(dir, ULID, 0, path.join(dir, 'raw.jsonl')),
        missing.sessionList(dir),
        missing.sessionRawTranscript(dir, SESSION, path.join(dir, 'live.jsonl')),
      ]);
      for (const result of results) {
        expect(result.ok).toBe(false);
        expect(!result.ok && result.failure.kind).toBe('cliMissing');
      }
    });
  });

  describe('listCheckpoints', () => {
    it('asks for JSON rows with the given limit and no pager', async () => {
      scenario({
        'checkpoint explain --json *': {
          stdout: JSON.stringify([
            { checkpoint_id: ULID, session_id: SESSION, agent: 'Claude Code', date: '2026-03-04T12:20:14Z', message: 'Drop the entry' },
            { message: 'row with no id' },
            { checkpoint_id: HEX },
          ]),
        },
      });
      const result = await cli.listCheckpoints(dir, 250);
      expect(result.ok && result.value.map((row) => row.checkpointId)).toEqual([ULID, HEX]);

      const [args] = invocations();
      expect(args?.slice(0, 2)).toEqual(['checkpoint', 'explain']);
      expect(args).toContain('--json');
      expect(args).toContain('--no-pager');
      expect(args?.[(args?.indexOf('--limit') ?? -1) + 1]).toBe('250');
      expect(args).not.toContain('--checkpoint');
    });

    it('reads an empty list', async () => {
      scenario({ 'checkpoint explain --json *': { stdout: '[]\n' } });
      expect(await cli.listCheckpoints(dir, 10)).toEqual({ ok: true, value: [] });
    });

    it('maps prose from a disabled repository to notEnabled', async () => {
      scenario({ 'checkpoint explain --json *': { stdout: DISABLED_PROSE } });
      const result = await cli.listCheckpoints(dir, 10);
      expect(!result.ok && result.failure.kind).toBe('notEnabled');
    });
  });

  describe('explainCheckpoint', () => {
    const detail = { checkpoint_id: ULID, branch: 'main', sessions: [{ index: 0, session_id: SESSION, agent: 'Claude Code' }] };

    it('passes the ID with --checkpoint, so a hex ID is not read as a commit', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: JSON.stringify({ ...detail, checkpoint_id: HEX }) } });
      const result = await cli.explainCheckpoint(dir, HEX);
      expect(result.ok && result.value.checkpointId).toBe(HEX);

      const [args] = invocations();
      expect(args?.slice(0, 2)).toEqual(['checkpoint', 'explain']);
      expect(args?.[(args?.indexOf('--checkpoint') ?? -1) + 1]).toBe(HEX);
      expect(args).toContain('--json');
      expect(args).toContain('--no-pager');
      // The ID appears once, as the value of --checkpoint, never as a bare argument.
      expect(args?.filter((arg) => arg === HEX)).toHaveLength(1);
    });

    it('reads the detail of a ULID checkpoint', async () => {
      scenario({ [`checkpoint explain --checkpoint ${ULID} --json --no-pager`]: { stdout: JSON.stringify(detail) } });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(result).toMatchObject({
        ok: true,
        value: { checkpointId: ULID, branch: 'main', partial: false, sessions: [{ index: 0, sessionId: SESSION }] },
      });
    });

    it('still returns a partial checkpoint that exits non-zero but prints valid JSON', async () => {
      scenario({
        'checkpoint explain --checkpoint *': {
          stdout: JSON.stringify({ ...detail, partial: true }),
          stderr: 'Error: session 1: transcript blob not found\n',
          exitCode: 1,
        },
      });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.partial).toBe(true);
      expect(result.ok && result.value.sessions).toHaveLength(1);
    });

    it('maps a checkpoint that the CLI cannot find to notFound', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stderr: `Error: checkpoint ${ULID} not found\n`, exitCode: 1 } });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(!result.ok && result.failure.kind).toBe('notFound');
    });

    it('maps any other failure to an exit failure', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stderr: 'Error: fetch failed: connection refused\n', exitCode: 1 } });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.kind).toBe('exit');
      expect(result.failure.detail).toContain('connection refused');
    });

    it('maps garbage output to unexpectedOutput', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: 'Checkpoint 01HZ… (not JSON)\n' } });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it('maps JSON with no checkpoint ID to unexpectedOutput', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: '{"sessions":[]}' } });
      const result = await cli.explainCheckpoint(dir, ULID);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
    });

    it('reports a cancelled call as aborted, and stops the process', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { hang: true } });
      const controller = new AbortController();
      const started = Date.now();
      const pending = cli.explainCheckpoint(dir, ULID, controller.signal);
      setTimeout(() => controller.abort(), 400);
      const result = await pending;
      expect(!result.ok && result.failure.kind).toBe('aborted');
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it.each([
      ['an empty string', ''],
      ['a flag', '--generate'],
      ['a short flag', '-h'],
      ['a commit SHA', 'a'.repeat(40)],
      ['a short hex prefix', 'abcdef0'],
      ['a lowercase ULID', ULID.toLowerCase()],
      ['an ID with a trailing newline', `${HEX}\n`],
      ['an ID followed by another argument', `${HEX} --generate`],
      ['a path', '../../etc/passwd'],
    ])('rejects %s without starting the CLI', async (_label, id) => {
      scenario({ 'checkpoint *': { stdout: JSON.stringify(detail) } });
      const results = [
        await cli.explainCheckpoint(dir, id),
        await cli.fullText(dir, id),
        await cli.checkpointAuthor(dir, id),
        await cli.rawTranscript(dir, id, 0, path.join(dir, 'raw.jsonl')),
      ];
      for (const result of results) {
        expect(result.ok).toBe(false);
        expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
      }
      expect(invocations()).toEqual([]);
      expect(existsSync(logFile)).toBe(false);
    });
  });

  describe('fullText', () => {
    it('returns the text view, asking for the checkpoint with --checkpoint and --full', async () => {
      const text = '● Checkpoint\n── Transcript (full session) ──\n[User] Hello\n';
      scenario({ 'checkpoint explain --checkpoint *': { stdout: text } });
      expect(await cli.fullText(dir, ULID)).toEqual({ ok: true, value: text });

      const [args] = invocations();
      expect(args?.[(args?.indexOf('--checkpoint') ?? -1) + 1]).toBe(ULID);
      expect(args).toContain('--full');
      expect(args).toContain('--no-pager');
      expect(args).not.toContain('--json');
    });

    it('fails when the command fails, even if it printed something', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: 'partial text', stderr: 'Error: checkpoint not found\n', exitCode: 1 } });
      const result = await cli.fullText(dir, ULID);
      expect(!result.ok && result.failure.kind).toBe('notFound');
    });
  });

  describe('checkpointAuthor', () => {
    const short = (author: string): string =>
      [`● Checkpoint ${ULID}`, '  session  session-0', author, '  commits  (none on this branch)', '─'.repeat(40), '## Intent', ''].join('\n');

    it('reads the author from the short text view, asked for with --checkpoint', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: short('  author   Fixture Author <fixture@example.com>') } });
      expect(await cli.checkpointAuthor(dir, ULID)).toEqual({ ok: true, value: 'Fixture Author' });
      expect(invocations()).toEqual([['checkpoint', 'explain', '--checkpoint', ULID, '--short', '--no-pager']]);
    });

    it('reports no author, and no failure, when the CLI names none', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: short('  tokens   12.4k') } });
      expect(await cli.checkpointAuthor(dir, ULID)).toEqual({ ok: true, value: undefined });
    });

    it('fails when the command fails, whatever it printed', async () => {
      scenario({
        'checkpoint explain --checkpoint *': {
          stdout: short('  author   Fixture Author <fixture@example.com>'),
          stderr: 'Error: checkpoint not found\n',
          exitCode: 1,
        },
      });
      const result = await cli.checkpointAuthor(dir, ULID);
      expect(!result.ok && result.failure.kind).toBe('notFound');
    });

    it('stops when the caller cancels', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { hang: true } });
      const controller = new AbortController();
      const pending = cli.checkpointAuthor(dir, ULID, controller.signal);
      setTimeout(() => controller.abort(), 150);
      const result = await pending;
      expect(!result.ok && result.failure.kind).toBe('aborted');
    });
  });

  describe('brainStatus', () => {
    const STATUS = 'brain status --json';
    const UNKNOWN = 'Usage:\n  entire [command]\n\nError: Invalid usage: unknown command "brain status --json" for "entire"\n';

    it('asks the plugin, through the CLI, for its status as JSON', async () => {
      scenario({
        [STATUS]: {
          stdout: JSON.stringify({
            brain: { manifest_state: 'current' },
            semantic: { coverage: { files: 60, symbols: 900, relations: 3200 } },
          }),
        },
      });
      expect(await cli.brainStatus(dir)).toEqual({
        ok: true,
        value: { manifestState: 'current', files: 60, symbols: 900, relations: 3200, staleParts: [], warnings: [] },
      });
      expect(invocations()).toEqual([['brain', 'status', '--json']]);
    });

    it('reads a repository with no brain as a status, not as a failure', async () => {
      scenario({ [STATUS]: { stdout: JSON.stringify({ brain: { manifest_state: 'absent' } }) } });
      expect(await cli.brainStatus(dir)).toEqual({ ok: true, value: { manifestState: 'absent', staleParts: [], warnings: [] } });
    });

    it('says the plugin is missing when the CLI does not know the command', async () => {
      scenario({ [STATUS]: { stderr: UNKNOWN, exitCode: 1 } });
      const status = await cli.brainStatus(dir);
      expect(!status.ok && status.failure.kind).toBe('pluginMissing');
      expect(!status.ok && status.failure.message).toBe('The entire-brain plugin is not installed.');
    });

    it('reports any other failure of the plugin as a failed call', async () => {
      scenario({ [STATUS]: { stderr: 'resolve git root: exit status 128\n', exitCode: 1 } });
      const status = await cli.brainStatus(dir);
      expect(!status.ok && status.failure.kind).toBe('exit');
    });

    it('rejects a report that does not say what state the brain is in', async () => {
      scenario({ [STATUS]: { stdout: JSON.stringify({ repo: { root: dir } }) } });
      const status = await cli.brainStatus(dir);
      expect(!status.ok && status.failure.kind).toBe('unexpectedOutput');
    });
  });

  describe('startBrainViz', () => {
    const VIZ = 'brain viz --no-open --port 0';
    const READY = 'entire brain viz \u2014 http://127.0.0.1:43117\nRead-only, loopback-only, no network. Press Ctrl-C to stop.\n';

    it('starts the graph page without a browser, on a port the plugin picks, and reports its address', async () => {
      scenario({ [VIZ]: { stdout: READY, hang: true } });
      const viz = await cli.startBrainViz(dir);
      expect(viz.ok && viz.value.url).toBe('http://127.0.0.1:43117');
      expect(invocations()).toEqual([['brain', 'viz', '--no-open', '--port', '0']]);
      expect(logLines.some((line) => line.includes('listening on http://127.0.0.1:43117'))).toBe(true);
      if (!viz.ok) return;

      // It stays up until it is stopped.
      let gone = false;
      void viz.value.exited.then(() => {
        gone = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(gone).toBe(false);
      viz.value.stop();
      await viz.value.exited;
      expect(logLines.at(-1)).toContain('(stopped)');
    });

    it('says the plugin is missing when the CLI does not know the command', async () => {
      scenario({
        [VIZ]: { stderr: 'Error: Invalid usage: unknown command "brain viz --no-open --port 0" for "entire"\n', exitCode: 1 },
      });
      const viz = await cli.startBrainViz(dir);
      expect(!viz.ok && viz.failure.kind).toBe('pluginMissing');
    });

    it('reports a page that could not start, in words about the brain graph, with the reason in the log', async () => {
      scenario({ [VIZ]: { stderr: 'bind viz server: listen tcp 127.0.0.1:0: bind: operation not permitted\n', exitCode: 1 } });
      const viz = await cli.startBrainViz(dir);
      expect(!viz.ok && viz.failure.kind).toBe('exit');
      expect(!viz.ok && viz.failure.message).toBe('The Entire CLI could not start the brain graph.');
      expect(!viz.ok && viz.failure.detail).toContain('bind viz server');
      expect(logLines.join('\n')).toContain('bind viz server');
    });

    it('stops when the caller cancels the start', async () => {
      scenario({ [VIZ]: { hang: true } });
      const controller = new AbortController();
      const pending = cli.startBrainViz(dir, controller.signal);
      setTimeout(() => controller.abort(), 150);
      const viz = await pending;
      expect(!viz.ok && viz.failure.kind).toBe('aborted');
    });
  });

  describe('rawTranscript', () => {
    it('writes the stored bytes of one session slot to the file and reports their size', async () => {
      const raw = '{"type":"user","message":"héllo"}\n{"type":"assistant"}\n';
      const file = path.join(dir, 'raw.jsonl');
      scenario({ 'checkpoint explain --checkpoint *': { stdout: raw } });
      const result = await cli.rawTranscript(dir, ULID, 2, file);
      expect(result).toEqual({ ok: true, value: Buffer.byteLength(raw) });
      expect(readFileSync(file, 'utf8')).toBe(raw);

      const [args] = invocations();
      expect(args?.[(args?.indexOf('--checkpoint') ?? -1) + 1]).toBe(ULID);
      expect(args?.[(args?.indexOf('--session-index') ?? -1) + 1]).toBe('2');
      expect(args).toContain('--transcript');
      expect(args).toContain('--no-pager');
    });

    // One long session's transcript runs to hundreds of megabytes. Held in
    // memory, this one would pass every limit the other calls have.
    it('writes a transcript far larger than any in-memory limit', async () => {
      const line = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) })}\n`;
      const times = 70_000;
      const file = path.join(dir, 'large.jsonl');
      scenario({ 'checkpoint explain --checkpoint *': { repeat: { text: line, times } } });
      const result = await cli.rawTranscript(dir, ULID, 0, file);
      expect(result).toEqual({ ok: true, value: line.length * times });
      expect(statSync(file).size).toBe(line.length * times);
      expect(line.length * times).toBeGreaterThan(64 * 1024 * 1024);
    });

    it('reports a transcript the CLI could not produce', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stderr: 'checkpoint not found\n', exitCode: 1 } });
      const result = await cli.rawTranscript(dir, ULID, 0, path.join(dir, 'raw.jsonl'));
      expect(!result.ok && result.failure.kind).toBe('notFound');
    });

    it('reports a file it could not write', async () => {
      scenario({ 'checkpoint explain --checkpoint *': { stdout: 'raw' } });
      const result = await cli.rawTranscript(dir, ULID, 0, path.join(dir, 'no-such-directory', 'raw.jsonl'));
      expect(result.ok).toBe(false);
      expect(!result.ok && result.failure.message).toMatch(/could not save/);
    });

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects the session index %s without starting the CLI', async (index) => {
      scenario({ 'checkpoint *': { stdout: 'raw' } });
      const file = path.join(dir, 'raw.jsonl');
      const result = await cli.rawTranscript(dir, ULID, index, file);
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
      expect(invocations()).toEqual([]);
      expect(existsSync(file)).toBe(false);
    });
  });

  describe('sessionList', () => {
    it('reads the session rows', async () => {
      scenario({
        'session list --json': {
          stdout: JSON.stringify([
            { session_id: SESSION, agent: 'Claude Code', status: 'active', turns: 4, pending_turns: 1, started_at: '2026-03-04T10:00:00Z' },
            { agent: 'row with no id' },
          ]),
        },
      });
      expect(await cli.sessionList(dir)).toEqual({
        ok: true,
        value: [
          { sessionId: SESSION, agent: 'Claude Code', status: 'active', turns: 4, pendingTurns: 1, startedAt: '2026-03-04T10:00:00Z' },
        ],
      });
      expect(invocations()).toEqual([['session', 'list', '--json']]);
    });

    it('maps prose from a disabled repository to notEnabled', async () => {
      scenario({ 'session list --json': { stdout: DISABLED_PROSE } });
      const result = await cli.sessionList(dir);
      expect(!result.ok && result.failure.kind).toBe('notEnabled');
    });
  });

  describe('sessionRawTranscript', () => {
    it('writes the live transcript of a session to the file', async () => {
      const file = path.join(dir, 'live.jsonl');
      scenario({ 'session info *': { stdout: '{"type":"user"}\n' } });
      const result = await cli.sessionRawTranscript(dir, SESSION, file);
      expect(result).toEqual({ ok: true, value: 16 });
      expect(readFileSync(file, 'utf8')).toBe('{"type":"user"}\n');
      const [args] = invocations();
      expect(args?.slice(0, 2)).toEqual(['session', 'info']);
      expect(args).toContain(SESSION);
      expect(args).toContain('--transcript');
    });

    it.each(['ses_01HZY3K9', '01HZXK3M5N7P9R2T4V6W8Y0A1B', 'a.b:c-d_e', '7'])('accepts the session ID %s', async (id) => {
      scenario({ 'session info *': { stdout: 'x' } });
      expect((await cli.sessionRawTranscript(dir, id, path.join(dir, 'live.jsonl'))).ok).toBe(true);
    });

    it.each([
      ['an empty string', ''],
      ['a flag', '--help'],
      ['a short flag', '-v'],
      ['an ID with a space', 'abc --transcript'],
      ['an ID with a slash', '../session'],
      ['an ID with a newline', 'abc\n'],
      ['an ID that is too long', 'a'.repeat(129)],
    ])('rejects %s without starting the CLI', async (_label, id) => {
      scenario({ 'session info *': { stdout: 'x' } });
      const result = await cli.sessionRawTranscript(dir, id, path.join(dir, 'live.jsonl'));
      expect(!result.ok && result.failure.kind).toBe('unexpectedOutput');
      expect(invocations()).toEqual([]);
    });
  });

  describe('the log', () => {
    it('records each command with its outcome', async () => {
      scenario({ 'status --json': { stdout: '{"enabled":true}' } });
      await cli.status(dir);
      expect(logLines).toHaveLength(1);
      expect(logLines[0]).toContain('entire status --json');
      expect(logLines[0]).toContain('exit 0');
    });

    it('records stderr, shortened to its first lines', async () => {
      const stderr = Array.from({ length: 20 }, (_, n) => `warning ${n}`).join('\n');
      scenario({ 'status --json': { stdout: '{"enabled":true}', stderr } });
      await cli.status(dir);
      const logged = logLines.join('\n');
      expect(logged).toContain('warning 0');
      expect(logged).not.toContain('warning 19');
    });
  });
});

describe('EntireCli outcome mapping', () => {
  const result = (overrides: Partial<ExecResult>): ExecResult => ({
    code: 0,
    stdout: Buffer.alloc(0),
    stderr: '',
    timedOut: false,
    aborted: false,
    truncated: false,
    bytes: 0,
    ...overrides,
  });
  /** An `exec` that reports a fixed outcome, for outcomes that take too long to produce for real. */
  const cliThat = (overrides: Partial<ExecResult>): EntireCli => {
    const fixed: Exec = async () => result(overrides);
    return new EntireCli('entire', fixed, new Lane(4));
  };

  it('maps a timeout to a timeout failure, even when partial JSON-looking output arrived', async () => {
    const cli = cliThat({ code: null, timedOut: true, stdout: Buffer.from('{"enabled":true}') });
    const status = await cli.status('/repo');
    expect(!status.ok && status.failure.kind).toBe('timeout');
    const version = await cli.version('/repo');
    expect(!version.ok && version.failure.kind).toBe('timeout');
    const text = await cli.fullText('/repo', ULID);
    expect(!text.ok && text.failure.kind).toBe('timeout');
  });

  it('maps an abort to an aborted failure, whatever was printed', async () => {
    const cli = cliThat({ code: null, aborted: true, stdout: Buffer.from(`{"checkpoint_id":"${ULID}"}`) });
    const detail = await cli.explainCheckpoint('/repo', ULID);
    expect(!detail.ok && detail.failure.kind).toBe('aborted');
  });

  it('does not trust output that was cut off at the size limit', async () => {
    const cli = cliThat({ code: null, truncated: true, stdout: Buffer.from('[]') });
    const rows = await cli.listCheckpoints('/repo', 10);
    expect(rows.ok).toBe(false);
    expect(!rows.ok && rows.failure.kind).toBe('unexpectedOutput');
    const raw = await cli.rawTranscript('/repo', ULID, 0, '/repo/raw.jsonl');
    expect(raw.ok).toBe(false);
  });

  it('passes the working directory and a finite timeout to exec, and runs listCheckpoints in the background', async () => {
    const calls: { cwd: string; timeoutMs: number; args: readonly string[]; env: NodeJS.ProcessEnv | undefined }[] = [];
    const recording: Exec = async (_file, args, options) => {
      calls.push({ cwd: options.cwd, timeoutMs: options.timeoutMs, args, env: options.env });
      return result({ stdout: Buffer.from('[]') });
    };
    const cli = new EntireCli('entire', recording, new Lane(4));
    await cli.listCheckpoints('/repo', 5);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe('/repo');
    expect(calls[0]?.timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(calls[0]?.timeoutMs)).toBe(true);
    // Color codes and credential prompts would corrupt or block the output.
    expect(calls[0]?.env?.NO_COLOR).toBe('1');
    expect(calls[0]?.env?.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('lets a user call overtake a queued checkpoint listing', async () => {
    const order: string[] = [];
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: Exec = async (_file, args) => {
      order.push(args.join(' '));
      if (args[0] === 'version') await blocked;
      return result({ stdout: Buffer.from(args.includes('--json') ? '[]' : 'Entire CLI 0.13.3') });
    };
    const cli = new EntireCli('entire', slow, new Lane(1));

    const version = cli.version('/repo');
    const rows = cli.listCheckpoints('/repo', 5);
    const sessions = cli.sessionList('/repo');
    release?.();
    await Promise.all([version, rows, sessions]);

    expect(order[0]).toBe('version');
    expect(order[1]).toBe('session list --json');
    expect(order[2]).toContain('checkpoint explain');
  });
});
