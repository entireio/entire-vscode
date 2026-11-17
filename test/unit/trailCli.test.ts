import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntireCli, type TrailScope } from '../../src/core/entireCli';
import { exec, type Exec, type ExecResult } from '../../src/core/exec';
import { Lane } from '../../src/core/scheduler';

const FAKE_ENTIRE = fileURLToPath(new URL('../fake-entire/entire', import.meta.url));
const SCOPE: TrailScope = { project: 'gh/acme', repo: 'gh/acme/widget' };
const LIST = 'trail list --project gh/acme --repo gh/acme/widget --status open --limit 50 --json';

interface Reply {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  hang?: boolean;
}

const json = (value: unknown): Reply => ({ stdout: JSON.stringify(value) });
/** A trail ID in the form entire.io issues: a ULID. */
const TRAIL_ID = '01JT0000000000000000000042';
const trail = (number: number): Record<string, unknown> => ({ number, title: `Trail ${number}`, status: 'open' });

describe('EntireCli trail calls against the fake CLI', () => {
  let dir: string;
  let logFile: string;
  let cli: EntireCli;

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
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-trail-test-')));
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

  describe('listTrails', () => {
    it('lists the open trails of a repository', async () => {
      scenario({
        [LIST]: json({
          items: [trail(3), trail(2)],
          nextPageToken: 'next-page',
          groupTotals: [{ totalCount: 120 }],
        }),
      });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(page.ok && page.value.trails.map((item) => item.number)).toEqual([3, 2]);
      expect(page.ok && page.value.nextPageToken).toBe('next-page');
      expect(page.ok && page.value.total).toBe(120);
      expect(invocations()).toEqual([
        ['trail', 'list', '--project', 'gh/acme', '--repo', 'gh/acme/widget', '--status', 'open', '--limit', '50', '--json'],
      ]);
    });

    it('asks for closed trails, and continues from a page token', async () => {
      scenario({
        'trail list --project gh/acme --repo gh/acme/widget --status closed --limit 25 --json --page-token=abc_DEF-123=': json({
          items: [trail(1)],
          nextPageToken: null,
        }),
      });
      const page = await cli.listTrails(dir, SCOPE, 'closed', 25, 'abc_DEF-123=');
      expect(page).toEqual({ ok: true, value: { trails: [{ number: 1, title: 'Trail 1', status: 'open', assignees: [], changes: [] }] } });
      // The token is joined to its flag, so the CLI cannot take it for a flag of its own.
      expect(invocations()[0]?.at(-1)).toBe('--page-token=abc_DEF-123=');
    });

    it('lists open and closed trails together when asked for all, by passing no status', async () => {
      scenario({
        'trail list --project gh/acme --repo gh/acme/widget --limit 50 --json': json({
          items: [trail(3), { ...trail(2), status: 'closed', phase: 'closed' }],
          nextPageToken: 'more',
        }),
        'trail list --project gh/acme --repo gh/acme/widget --limit 50 --json --page-token=more': json({ items: [trail(1)] }),
      });
      const first = await cli.listTrails(dir, SCOPE, 'all', 50);
      expect(first.ok && first.value.trails.map((item) => item.status)).toEqual(['open', 'closed']);
      const second = await cli.listTrails(dir, SCOPE, 'all', 50, 'more');
      expect(second.ok && second.value.trails.map((item) => item.number)).toEqual([1]);
      expect(invocations().every((args) => !args.includes('--status'))).toBe(true);
    });

    it('names an Entire-native project', async () => {
      scenario({
        'trail list --project et/platform --repo et/platform/api --status open --limit 50 --json': json({ items: [] }),
      });
      const page = await cli.listTrails(dir, { project: 'et/platform', repo: 'et/platform/api' }, 'open', 50);
      expect(page).toEqual({ ok: true, value: { trails: [] } });
    });

    it.each([
      ['a project with no forge', { project: 'acme', repo: 'gh/acme/widget' }],
      ['a project on an unknown forge', { project: 'gl/acme', repo: 'gh/acme/widget' }],
      ['a project that reads as a flag', { project: 'gh/--context', repo: 'gh/acme/widget' }],
      ['a project with a space', { project: 'gh/ac me', repo: 'gh/acme/widget' }],
      ['a repository with no owner', { project: 'gh/acme', repo: 'gh/widget' }],
      ['a repository that reads as a flag', { project: 'gh/acme', repo: 'gh/acme/-rf' }],
      ['a repository with an extra path', { project: 'gh/acme', repo: 'gh/acme/widget/extra' }],
      ['an empty project', { project: '', repo: 'gh/acme/widget' }],
    ])('refuses %s without running the CLI', async (_label, scope) => {
      const page = await cli.listTrails(dir, scope, 'open', 50);
      expect(page.ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it.each([0, 101, -1, 1.5, Number.NaN])('refuses a page size of %s', async (limit) => {
      expect((await cli.listTrails(dir, SCOPE, 'open', limit)).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it.each([
      ['with a space', 'abc def'],
      ['with a line break', 'abc\ndef'],
      ['that is empty', ''],
      ['that is far too long', 'x'.repeat(5000)],
    ])('refuses a page token %s', async (_label, token) => {
      expect((await cli.listTrails(dir, SCOPE, 'open', 50, token)).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('never passes a status other than open or closed', async () => {
      scenario({ [LIST]: json({ items: [] }) });
      // A value that TypeScript would reject, as untyped code could pass it.
      const page = await cli.listTrails(dir, SCOPE, '--mine' as 'open', 50);
      expect(page.ok).toBe(true);
      expect(invocations()[0]).toContain('open');
      expect(invocations()[0]).not.toContain('--mine');
    });

    it('reports a missing login', async () => {
      scenario({ [LIST]: { stderr: "Error: not logged in (run 'entire login' first): no saved login\n", exitCode: 1 } });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('notLoggedIn');
      expect(!page.ok && page.failure.message).toBe('You are not logged in to Entire.');
      expect(!page.ok && page.failure.detail).toContain('entire login');
    });

    it('reports an expired login', async () => {
      scenario({ [LIST]: { stderr: "401 Unauthorized — run 'entire login' to re-authenticate\n", exitCode: 1 } });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('notLoggedIn');
    });

    it('reports a project the login cannot see', async () => {
      scenario({
        [LIST]: {
          stderr:
            "project gh/acme does not exist or is not visible to your login; check that 'entire auth status' shows the account that can open this project's trails on the web\n",
          exitCode: 1,
        },
      });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('noAccess');
    });

    it('reports any other failure as an exit, with stderr for the log', async () => {
      scenario({ [LIST]: { stderr: 'dial tcp: lookup entire.io: no such host\n', exitCode: 1 } });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('exit');
      expect(!page.ok && page.failure.message).toBe('The Entire CLI could not list trails.');
      expect(!page.ok && page.failure.detail).toContain('no such host');
    });

    it('does not take prose on stdout for a page', async () => {
      scenario({ [LIST]: { stdout: 'No trails found.\n' } });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('unexpectedOutput');
    });

    it('does not take JSON of another shape for a page', async () => {
      scenario({ [LIST]: json({ error: 'something else' }) });
      const page = await cli.listTrails(dir, SCOPE, 'open', 50);
      expect(!page.ok && page.failure.kind).toBe('unexpectedOutput');
    });

    it('shares one process between identical calls', async () => {
      scenario({ [LIST]: json({ items: [trail(1)] }) });
      const [first, second] = await Promise.all([
        cli.listTrails(dir, SCOPE, 'open', 50),
        cli.listTrails(dir, SCOPE, 'open', 50),
      ]);
      expect(first.ok && second.ok).toBe(true);
      expect(invocations()).toHaveLength(1);
    });
  });

  describe('showTrail', () => {
    it('reads one trail by number, in the project given', async () => {
      scenario({
        'trail show 42 --project gh/acme --json': json({
          ...trail(42),
          url: 'https://entire.example.test/gh/acme/-/trails/42',
          project: { name: 'acme' },
        }),
      });
      const detail = await cli.showTrail(dir, 'gh/acme', { number: 42 });
      expect(detail.ok && detail.value.url).toBe('https://entire.example.test/gh/acme/-/trails/42');
      expect(detail.ok && detail.value.projectName).toBe('acme');
      expect(invocations()).toEqual([['trail', 'show', '42', '--project', 'gh/acme', '--json']]);
    });

    it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s as a trail number', async (number) => {
      expect((await cli.showTrail(dir, 'gh/acme', { number })).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('refuses a project that reads as a flag', async () => {
      expect((await cli.showTrail(dir, '--json', { number: 42 })).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('names the trail by its ID when it has one, which saves the CLI a lookup', async () => {
      scenario({ [`trail show ${TRAIL_ID} --project gh/acme --json`]: json({ ...trail(42), id: TRAIL_ID }) });
      const detail = await cli.showTrail(dir, 'gh/acme', { number: 42, id: TRAIL_ID });
      expect(detail.ok && detail.value.number).toBe(42);
      expect(detail.ok && detail.value.id).toBe(TRAIL_ID);
      expect(invocations()).toEqual([['trail', 'show', TRAIL_ID, '--project', 'gh/acme', '--json']]);
    });

    it.each(['--json', 'trail-42', '', TRAIL_ID.toLowerCase(), `${TRAIL_ID}0`])(
      'falls back to the number when %j is given as the ID',
      async (id) => {
        scenario({ 'trail show 42 --project gh/acme --json': json(trail(42)) });
        expect((await cli.showTrail(dir, 'gh/acme', { number: 42, id })).ok).toBe(true);
        expect(invocations()).toEqual([['trail', 'show', '42', '--project', 'gh/acme', '--json']]);
      },
    );

    it('refuses a trail without a usable number, whatever its ID', async () => {
      expect((await cli.showTrail(dir, 'gh/acme', { number: 0, id: TRAIL_ID })).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('reports a trail that does not exist, in words about a trail', async () => {
      scenario({
        'trail show 404 --project gh/acme --json': { stderr: 'project trail #404 not found in gh/acme\n', exitCode: 1 },
      });
      const detail = await cli.showTrail(dir, 'gh/acme', { number: 404 });
      expect(!detail.ok && detail.failure.kind).toBe('notFound');
      expect(!detail.ok && detail.failure.message).toBe('Entire could not find this trail.');
    });

    it('reports a missing login', async () => {
      scenario({ 'trail show 42 --project gh/acme --json': { stderr: "not logged in (run 'entire login' first)\n", exitCode: 1 } });
      const detail = await cli.showTrail(dir, 'gh/acme', { number: 42 });
      expect(!detail.ok && detail.failure.kind).toBe('notLoggedIn');
    });

    it('stops when the caller cancels', async () => {
      scenario({ 'trail show 42 --project gh/acme --json': { hang: true } });
      const controller = new AbortController();
      const pending = cli.showTrail(dir, 'gh/acme', { number: 42 }, controller.signal);
      setTimeout(() => controller.abort(), 150);
      const detail = await pending;
      expect(!detail.ok && detail.failure.kind).toBe('aborted');
    });
  });

  describe('trailTimeline', () => {
    const TIMELINE = 'trail timeline widget/7 --project gh/acme --limit 50 --json';

    it('reads the activity on a change, named by repository and number', async () => {
      scenario({
        [TIMELINE]: json({
          items: [{ kind: 'commit', title: 'Add the parser', commitSha: 'a'.repeat(40) }, { kind: 'trail_created' }],
          nextPageToken: 'more',
          commitCount: 1,
          incomplete: false,
        }),
      });
      const timeline = await cli.trailTimeline(dir, 'gh/acme', { repository: 'widget', number: 7 }, 50);
      expect(timeline.ok && timeline.value.events.map((event) => event.kind)).toEqual(['commit', 'trail_created']);
      expect(timeline.ok && timeline.value.nextPageToken).toBe('more');
      expect(invocations()).toEqual([
        ['trail', 'timeline', 'widget/7', '--project', 'gh/acme', '--limit', '50', '--json'],
      ]);
    });

    it('continues from a page token', async () => {
      scenario({ [`${TIMELINE} --page-token=more`]: json({ items: [], nextPageToken: null }) });
      const timeline = await cli.trailTimeline(dir, 'gh/acme', { repository: 'widget', number: 7 }, 50, 'more');
      expect(timeline).toEqual({ ok: true, value: { events: [], incomplete: false } });
    });

    it.each([
      ['a repository that reads as a flag', { repository: '--repo', number: 7 }],
      ['a repository with a path', { repository: 'acme/widget', number: 7 }],
      ['an empty repository', { repository: '', number: 7 }],
      ['a change number of zero', { repository: 'widget', number: 0 }],
      ['a change number that is not whole', { repository: 'widget', number: 7.5 }],
    ])('refuses %s without running the CLI', async (_label, change) => {
      expect((await cli.trailTimeline(dir, 'gh/acme', change, 50)).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('reads the timeline of a trail, for which the CLI picks the change', async () => {
      scenario({
        [`trail timeline ${TRAIL_ID} --project gh/acme --limit 50 --json`]: json({ items: [{ kind: 'trail_created' }] }),
        'trail timeline 42 --project gh/acme --limit 50 --json --page-token=more': json({ items: [] }),
      });
      const byId = await cli.trailTimeline(dir, 'gh/acme', { trail: { number: 42, id: TRAIL_ID } }, 50);
      expect(byId.ok && byId.value.events.map((event) => event.kind)).toEqual(['trail_created']);
      // Without an ID the trail is named by its number, on a later page too.
      expect((await cli.trailTimeline(dir, 'gh/acme', { trail: { number: 42 } }, 50, 'more')).ok).toBe(true);
      expect(invocations()).toEqual([
        ['trail', 'timeline', TRAIL_ID, '--project', 'gh/acme', '--limit', '50', '--json'],
        ['trail', 'timeline', '42', '--project', 'gh/acme', '--limit', '50', '--json', '--page-token=more'],
      ]);
    });

    it('reports that the CLI would not pick a change as a failed call', async () => {
      scenario({
        'trail timeline 42 --project gh/acme --limit 50 --json': {
          stderr: 'trail #42 has 2 open changes; choose one:\n  widget/7 - main\n  widget/8 - next\n',
          exitCode: 1,
        },
      });
      const timeline = await cli.trailTimeline(dir, 'gh/acme', { trail: { number: 42 } }, 50);
      expect(!timeline.ok && timeline.failure.kind).toBe('exit');
    });

    it.each([0, -1, 2.5, Number.NaN])('refuses a trail numbered %s without running the CLI', async (number) => {
      expect((await cli.trailTimeline(dir, 'gh/acme', { trail: { number } }, 50)).ok).toBe(false);
      expect(invocations()).toEqual([]);
    });

    it('reports a change that does not exist', async () => {
      scenario({ [TIMELINE]: { stderr: 'no change widget/7 found in gh/acme\n', exitCode: 1 } });
      const timeline = await cli.trailTimeline(dir, 'gh/acme', { repository: 'widget', number: 7 }, 50);
      expect(!timeline.ok && timeline.failure.kind).toBe('notFound');
      expect(!timeline.ok && timeline.failure.message).toBe('Entire could not find this trail.');
    });
  });
});

describe('EntireCli trail calls and other calls', () => {
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
  const cliThat = (reply: Partial<ExecResult>): EntireCli => {
    const stub: Exec = async () => result(reply);
    return new EntireCli('entire', stub, new Lane(4));
  };

  it('reports a trail call that takes too long as a timeout', async () => {
    const page = await cliThat({ code: null, timedOut: true }).listTrails('/repo', SCOPE, 'open', 50);
    expect(!page.ok && page.failure.kind).toBe('timeout');
  });

  it('keeps the checkpoint wording for a checkpoint the CLI cannot find', async () => {
    const detail = await cliThat({ code: 1, stderr: 'checkpoint not found: abcdef012345' }).explainCheckpoint(
      '/repo',
      'abcdef012345',
    );
    expect(!detail.ok && detail.failure.kind).toBe('notFound');
    expect(!detail.ok && detail.failure.message).toMatch(/no session data for this checkpoint/);
  });

  it('does not read a login hint in a checkpoint failure as a missing login', async () => {
    // Only calls that read entire.io can fail for want of a login.
    const detail = await cliThat({ code: 1, stderr: "fetch failed; run 'entire login'" }).explainCheckpoint(
      '/repo',
      'abcdef012345',
    );
    expect(!detail.ok && detail.failure.kind).toBe('exit');
  });
});
