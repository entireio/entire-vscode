// Extension-host tests: the real extension runs in VS Code instances against
// fixture repositories, with `entire.cliPath` pointing at a fake `entire` binary.
//
// Node 22.18 or later runs this file, because it imports a TypeScript helper directly.
//
// To run the tests in another editor built on VS Code, such as Cursor or
// VSCodium, set ENTIRE_TEST_EDITOR to its executable:
//   ENTIRE_TEST_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor npm run test:host
// Each launch still gets a profile of its own, so the editor's real settings
// and extensions are not touched.
import { defineConfig } from '@vscode/test-cli';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkpointFiles, createFixtureRepo, transcriptLine } from './test/helpers/fixtureRepo.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeCli = path.join(here, 'test', 'fake-entire', 'entire');
chmodSync(fakeCli, 0o755);

const scratch = mkdtempSync(path.join(os.tmpdir(), 'entire-vscode-'));
const repos = [];
process.on('exit', () => {
  for (const repo of repos) repo.dispose();
  rmSync(scratch, { recursive: true, force: true });
});

/**
 * A VS Code profile whose settings select the CLI. The setting, not PATH,
 * selects it: VS Code replaces PATH with the login shell's when it is not
 * started from its own command line, and a real `entire` there would win.
 */
function profile(name, cliPath, settings = {}) {
  const dir = path.join(scratch, name);
  mkdirSync(path.join(dir, 'User'), { recursive: true });
  writeFileSync(path.join(dir, 'User', 'settings.json'), JSON.stringify({ 'entire.cliPath': cliPath, ...settings }));
  return dir;
}

function writeJson(name, value) {
  const file = path.join(scratch, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

const ids = {
  refs: '01JAAAAAAAAAAAAAAAAAAAAAA1',
  legacy: 'abcdef012345',
  squashed: '01JBBBBBBBBBBBBBBBBBBBBBB2',
  imported: '01JCCCCCCCCCCCCCCCCCCCCCC3',
  // Checkpoints of other branches. The clone has no data for them, and Entire lists them under their sessions.
  elsewhere: '01JDDDDDDDDDDDDDDDDDDDDDD4',
  onEntire: '01JEEEEEEEEEEEEEEEEEEEEEE5',
  // Entire lists this one under a session too, but the CLI cannot find its data.
  lost: '01JFFFFFFFFFFFFFFFFFFFFFF6',
  // A commit names this checkpoint, but its session data was never uploaded.
  missing: 'deadbeef0001',
};

/** A repository with checkpoints in both storage layouts. */
function checkpointRepo() {
  const repo = createFixtureRepo();
  repos.push(repo);
  repo.git('remote', 'add', 'origin', 'entire://cluster.example.test/gh/acme/widget');
  repo.commit('Initial commit');
  repo.commitFiles('Add notes', { 'notes.md': 'first draft\n', 'old-name.txt': 'kept as is\n' });
  const missingCommit = repo.commitFiles('Add the changelog', { 'CHANGELOG.md': '# Changelog\n' }, [
    `Entire-Checkpoint: ${ids.missing}`,
  ]);
  const parserCommit = repo.commitFiles(
    'Add the parser',
    { 'parser.ts': 'export const parse = 1;\n', 'notes.md': 'second draft\n' },
    [`Entire-Checkpoint: ${ids.refs}`],
  );
  const squashCommit = repo.commit('Squash the review fixes', [
    `Entire-Checkpoint: ${ids.legacy}`,
    `Entire-Checkpoint: ${ids.squashed}`,
  ]);
  repo.commit('Tidy the README');

  // Checkpoint in the git-refs layout: session 0 has a normalized transcript that
  // starts at line 2, session 1 (the latest) has none.
  repo.addRefCheckpoint(
    ids.refs,
    checkpointFiles(ids.refs, [
      {
        start: 2,
        transcript: [
          transcriptLine('user', [{ text: 'Sketch the parser' }]),
          transcriptLine('assistant', [{ type: 'text', text: 'Here is a sketch.' }]),
          transcriptLine('user', [{ text: 'Now write the parser' }]),
          transcriptLine('assistant', [
            { type: 'text', text: 'Writing it now.' },
            { type: 'tool_use', id: 't1', name: 'Write', input: { file_path: 'parser.ts' }, result: { output: 'ok', status: 'success' } },
          ]),
        ],
      },
      { agent: 'Codex' },
    ]),
  );
  // Checkpoint in the legacy layout, present only as a remote-tracking branch.
  const legacyPrefix = `${ids.legacy.slice(0, 2)}/${ids.legacy.slice(2)}/`;
  repo.addLegacyCheckpoints('refs/remotes/origin/entire/checkpoints/v1', {
    [ids.legacy]: checkpointFiles(
      ids.legacy,
      [{ start: null, transcript: [transcriptLine('user', [{ text: 'Fix the review comments' }])] }],
      legacyPrefix,
    ),
  });
  return { repo, parserCommit, squashCommit, missingCommit };
}

const session = (index, sessionId, agent) => ({
  index,
  session_id: sessionId,
  agent,
  model: 'test-model',
  created_at: '2026-01-02T03:04:05Z',
  files_touched: ['parser.ts'],
  token_usage: { input_tokens: 10, cache_creation_tokens: 0, cache_read_tokens: 90, output_tokens: 20, api_call_count: 1 },
});
const json = (value) => ({ stdout: JSON.stringify(value) });

// Raw transcripts: a small one, and one of about 80 MB, which is more than the
// extension could hold in memory and hand to the editor as one document.
const rawSmall = '{"type":"user","text":"Sketch the parser"}\n{"type":"assistant","text":"Here is a sketch."}\n';
const rawLine = `${JSON.stringify({ type: 'assistant', text: 'x'.repeat(1000) })}\n`;
const rawLargeTimes = 80_000;

/** The CLI's authenticated GET of Entire's API, for the sessions of the repository of the `origin` remote. */
const SESSIONS_API = 'api --to cell /api/v1/repos/{repo_id}/sessions';

const healthy = {
  version: { stdout: 'Entire CLI 0.13.3\n' },
  [`checkpoint explain --checkpoint ${ids.refs} --transcript --session-index 0 --no-pager`]: { stdout: rawSmall },
  // What the CLI says, after asking the remote, about a checkpoint with no data.
  [`checkpoint explain --checkpoint ${ids.missing} --json --no-pager`]: {
    stderr: `checkpoint not found: ${ids.missing}\n`,
    exitCode: 1,
  },
  [`checkpoint explain --checkpoint ${ids.refs} --transcript --session-index 1 --no-pager`]: {
    repeat: { text: rawLine, times: rawLargeTimes },
  },
  'status --json': json({
    enabled: true,
    agents: ['Claude Code'],
    active_sessions: [{ agent: 'Claude Code', session_id: 'live-session', status: 'active', model: 'test-model' }],
  }),
  // What the Setup view checks when it is on screen.
  'auth status --json': json({ logged_in: true, user: 'github:fixture-author', display_name: 'Fixture Author' }),
  'graph version --json': json({ identity_revision: '4', provider: 'entire-graph', version: 'v0.6.0' }),
  'checkpoint explain --json --limit 500 --no-pager': json([
    { checkpoint_id: ids.refs, session_id: 'session-0', agent: 'Claude Code', date: '2026-01-02T03:04:05Z', message: 'Add the parser', session_count: 2, session_ids: ['session-0', 'session-1'] },
    { checkpoint_id: ids.legacy, session_id: 'session-0', agent: 'Claude Code', date: '2026-01-03T03:04:05Z', message: 'Squash the review fixes', session_count: 1, session_ids: ['session-0'] },
    { checkpoint_id: ids.imported, session_id: 'imported-session', agent: 'Claude Code', date: '2025-12-01T00:00:00Z', message: 'Imported work', session_count: 1, session_ids: ['imported-session'] },
  ]),
  [`checkpoint explain --checkpoint ${ids.refs} --json --no-pager`]: json({
    checkpoint_id: ids.refs,
    branch: 'main',
    checkpoints_count: 2,
    files_touched: ['parser.ts'],
    session_count: 2,
    sessions: [session(0, 'session-0', 'Claude Code'), session(1, 'session-1', 'Codex')],
    tasks: [],
  }),
  [`checkpoint explain --checkpoint ${ids.refs} --full --no-pager`]: {
    stdout: [
      `● Checkpoint ${ids.refs}`,
      '── Transcript (full session) ───────────────────',
      '[User] Review the parser',
      '',
      '[Assistant] It looks right.',
      '',
      '[Tool] Bash: Run the tests',
      '',
    ].join('\n'),
  },
  [`checkpoint explain --checkpoint ${ids.legacy} --json --no-pager`]: json({
    checkpoint_id: ids.legacy,
    branch: 'main',
    checkpoints_count: 1,
    files_touched: [],
    session_count: 1,
    sessions: [session(0, 'session-0', 'Claude Code')],
    tasks: [],
  }),
  // A checkpoint made elsewhere: no commit in the fixture repository carries
  // it, and its data is not stored there, so its transcript is the CLI's text
  // view. The CLI names its author in the short view only, and takes a while.
  [`checkpoint explain --checkpoint ${ids.imported} --json --no-pager`]: json({
    checkpoint_id: ids.imported,
    branch: 'elsewhere',
    checkpoints_count: 1,
    files_touched: [],
    session_count: 1,
    sessions: [session(0, 'imported-session', 'Claude Code')],
    tasks: [],
  }),
  [`checkpoint explain --checkpoint ${ids.imported} --full --no-pager`]: {
    stdout: [
      `● Checkpoint ${ids.imported}`,
      '  author   Imported Author <imported@example.com>',
      '── Transcript (full session) ───────────────────',
      '[User] Port the importer',
      '',
      '[Assistant] It is ported.',
      '',
    ].join('\n'),
  },
  [`checkpoint explain --checkpoint ${ids.imported} --short --no-pager`]: {
    stdout: [
      `● Checkpoint ${ids.imported}`,
      '  session  imported-session',
      '  created  2025-12-01 00:00:00',
      '  author   Imported Author <imported@example.com>',
      '  commits  (none on this branch)',
      '────────────────────────────────────────────────────────────',
      '## Intent',
      '',
      'Port the importer',
      '',
    ].join('\n'),
    delayMs: 1500,
  },
  'session list --json': json([
    { session_id: 'local-session', agent: 'Claude Code', model: 'test-model', status: 'ended', last_prompt: 'Refactor the lexer', last_active: '2026-01-04T00:00:00Z', turns: 3, pending_turns: 1 },
  ]),
  // Entire's own list of the repository's sessions, which is what entire.com
  // shows. It names `imported-session` and counts one checkpoint more for it
  // than the clone knows. It lists `entire-session`, which the clone has no
  // data for. It leaves out the sessions behind the branch's commits, so
  // those keep the names read from their transcripts.
  [`${SESSIONS_API}?scope=all&limit=50`]: json({
    sessions: [
      {
        sessionId: 'imported-session',
        displayName: 'Port the Importer',
        customName: null,
        agent: 'Claude Code',
        model: 'test-model',
        kind: null,
        prompt: 'Port the importer',
        startedAt: '2025-12-01T00:00:00.000Z',
        lastActivityAt: '2025-12-02T00:00:00.000Z',
        checkpointCount: 2,
        stepCount: 9,
      },
      {
        sessionId: 'entire-session',
        displayName: 'Tune the Lexer on Another Branch',
        customName: null,
        agent: 'Codex',
        model: 'other-model',
        kind: null,
        prompt: 'Tune the lexer',
        startedAt: '2025-11-20T00:00:00.000Z',
        lastActivityAt: '2025-11-20T01:00:00.000Z',
        checkpointCount: 1,
        stepCount: 4,
      },
      {
        sessionId: 'lost-session',
        displayName: 'Trim the Changelog',
        customName: null,
        agent: 'Claude Code',
        model: 'test-model',
        kind: null,
        prompt: 'Trim the changelog',
        startedAt: '2025-11-10T00:00:00.000Z',
        lastActivityAt: '2025-11-10T01:00:00.000Z',
        checkpointCount: 1,
        stepCount: 2,
      },
    ],
    next_cursor: null,
    repo_full_name: 'acme/widget',
    history_complete: true,
  }),
  // Entire lists a session's checkpoints, oldest first, with the session's transcript. It takes a while.
  [`${SESSIONS_API}/imported-session/transcript`]: {
    ...json({
      sessionId: 'imported-session',
      sessions: [{ sessionId: 'imported-session', agent: 'Claude Code', messages: [{ role: 'user', text: 'Port the importer' }] }],
      checkpoints: [
        { checkpointId: ids.imported, commitSha: 'a'.repeat(40), message: 'Imported work', timestamp: '2025-12-01T00:00:00Z' },
        {
          checkpointId: ids.elsewhere,
          commitSha: 'b'.repeat(40),
          message: `Port the importer tests\n\nThey ran against the old layout.\n\nEntire-Checkpoint: ${ids.elsewhere}`,
          timestamp: '2025-12-02T00:00:00Z',
        },
      ],
    }),
    delayMs: 400,
  },
  [`${SESSIONS_API}/entire-session/transcript`]: json({
    sessionId: 'entire-session',
    sessions: [{ sessionId: 'entire-session', agent: 'Codex', messages: [] }],
    checkpoints: [
      { checkpointId: ids.onEntire, commitSha: 'c'.repeat(40), message: 'Tune the lexer', timestamp: '2025-11-20T01:00:00Z' },
    ],
  }),
  [`${SESSIONS_API}/lost-session/transcript`]: json({
    sessionId: 'lost-session',
    sessions: [{ sessionId: 'lost-session', agent: 'Claude Code', messages: [] }],
    checkpoints: [{ checkpointId: ids.lost, message: 'Trim the changelog to one page', timestamp: '2025-11-10T01:00:00Z' }],
  }),
  [`checkpoint explain --checkpoint ${ids.lost} --json --no-pager`]: {
    stderr: `checkpoint not found: ${ids.lost}\n`,
    exitCode: 1,
  },
  // The checkpoint of that session, which the CLI fetches from the remote when it is opened.
  [`checkpoint explain --checkpoint ${ids.onEntire} --json --no-pager`]: json({
    checkpoint_id: ids.onEntire,
    branch: 'tune-lexer',
    checkpoints_count: 1,
    files_touched: [],
    session_count: 1,
    sessions: [session(0, 'entire-session', 'Codex')],
    tasks: [],
  }),
  [`checkpoint explain --checkpoint ${ids.onEntire} --full --no-pager`]: {
    stdout: [
      `● Checkpoint ${ids.onEntire}`,
      '── Transcript (full session) ───────────────────',
      '[User] Tune the lexer',
      '',
      '[Assistant] It is tuned.',
      '',
    ].join('\n'),
  },
  [`checkpoint explain --checkpoint ${ids.onEntire} --short --no-pager`]: {
    stdout: [`● Checkpoint ${ids.onEntire}`, '  session  entire-session', '  author   Lexer Author <lexer@example.com>', ''].join('\n'),
  },
};

// A test window usually sits behind whatever else is on screen. Chromium slows
// the timers of a background window and stops drawing one that is covered, and
// parts of the editor that these tests wait on run on those timers. After a
// setting changes, for example, the editor asks about on-screen rows again
// through a 100 ms timer: that took 130 ms with these switches and up to 970 ms
// without them, and one run stalled past its 30 s limit.
//
// The switches come first on purpose. The test runner puts the workspace path
// after the last argument, and VS Code would take it for the value of a switch
// it does not know.
const KEEP_RUNNING_IN_BACKGROUND = [
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-background-timer-throttling',
];
const launchArgs = (userData) => [
  ...KEEP_RUNNING_IN_BACKGROUND,
  '--disable-workspace-trust',
  '--disable-extensions',
  `--user-data-dir=${userData}`,
];
const mocha = { ui: 'tdd', timeout: 60_000 };

// The main suite: one healthy repository.
const main = checkpointRepo();
const mainLog = path.join(scratch, 'main.log');
writeFileSync(mainLog, '');

// Trails, as the CLI reports them for the fixture's origin, gh/acme/widget.
// 120 are open, which is more than two pages, and two are closed. An open
// trail is in one of three phases: 12 are planning, 30 are complete, and the
// other 78 are building.
const trailPhase = (n) => (n % 10 === 7 ? 'planning' : n % 4 === 2 ? 'complete' : 'building');
const trailUrl = (n) => `https://entire.example.test/gh/acme/-/trails/${n}`;
// A trail's ID on entire.io is a ULID. The CLI takes it in place of the number.
const trailId = (n) => `01M7${String(n).padStart(22, '0')}`;
const trailChange = (repository, number, branch, extra = {}) => ({
  id: `change-${repository}-${number}`,
  repositoryId: `repo-${repository}`,
  repository,
  branch,
  base: 'stable',
  number,
  title: `Change ${repository} ${number}`,
  status: 'open',
  hasCodeChanges: true,
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-02T00:00:00Z',
  ...extra,
});
// What a row of the list says about the changes of a trail. It names them
// only for a trail in the building phase. A trail in the planning phase has
// no branch yet, and for one in the complete phase the list leaves its
// changes out: only `entire trail show` reports those. Trail 120 has its
// branch checked out in the fixture repository, and trail 116 has two
// branches in it.
const listedChanges = (n, status) => {
  if (status !== 'closed' && trailPhase(n) !== 'building') return {};
  if (n === 116) {
    return { changes: [trailChange('widget', 1116, 'feature/116'), trailChange('widget', 2116, 'feature/116-b')] };
  }
  return { changes: [trailChange('widget', n + 1000, n === 120 ? 'main' : `feature/${n}`)] };
};
const trailItem = (n, status = n > 9000 ? 'closed' : 'open') => ({
  id: trailId(n),
  projectId: 'project-1',
  number: n,
  title: `Trail ${n}`,
  body: '',
  status,
  phase: status === 'closed' ? 'closed' : trailPhase(n),
  metadata: {},
  type: 'task',
  priority: 'none',
  assignees: [],
  assigneeAccountIds: [],
  repoIds: ['repo-widget'],
  authorAccountId: 'account-1',
  createdAt: '2026-03-01T00:00:00Z',
  // One minute apart, with the highest number the most recent.
  lastActivityAt: new Date(Date.UTC(2026, 2, 2) + n * 60_000).toISOString(),
  closedAt: status === 'closed' ? '2026-03-05T00:00:00Z' : null,
  ...listedChanges(n, status),
  isPossiblyPartial: true,
});
const trailPage = (numbers, nextPageToken, total) =>
  json({
    items: numbers.map((n) => trailItem(n)),
    nextPageToken,
    groups: [{ rank: 0, key: '', label: 'All trails', totalCount: total, itemCount: numbers.length }],
    groupTotals: [{ rank: 0, key: '', label: 'All trails', totalCount: total }],
    groupBy: 'none',
    capabilities: { canManageTrails: false },
  });
// With no status, the CLI lists open and closed trails together.
const trailList = (status, token) =>
  `trail list --project gh/acme --repo gh/acme/widget${status === 'all' ? '' : ` --status ${status}`} --limit 50 --json${token ? ` --page-token=${token}` : ''}`;
const descending = (from, to) => Array.from({ length: from - to + 1 }, (_, n) => from - n);
const gate = (key, status, extra = {}) => ({
  id: `gate-${key}`,
  gate_key: key,
  gate_type: key,
  blocking: true,
  status,
  state: 'evaluated',
  outcome: status,
  rationale: null,
  finding_count: null,
  ...extra,
});
const person = { login: 'fixture-author', identity: { kind: 'user', display_name: 'Fixture Author' } };
const timelineCommit = (id, title, commitSha, extra = {}) => ({
  id,
  kind: 'commit',
  actor: person,
  occurredAt: '2026-03-02T09:00:00Z',
  title,
  commitSha,
  additions: 12,
  deletions: 3,
  filesChanged: 2,
  statsPending: false,
  checkpointCount: 1,
  sessionCount: 1,
  agents: [],
  ...extra,
});
// A timeline call names a change, as `<repository>/<number>`, or a trail, for which the CLI picks the change.
const trailTimeline = (of, token) =>
  `trail timeline ${of} --project gh/acme --limit 50 --json${token ? ` --page-token=${token}` : ''}`;
const trailShow = (trail) => `trail show ${trail} --project gh/acme --json`;
const NEVER_FETCHED = 'f'.repeat(40);
const trailProjectInfo = { id: 'project-1', name: 'acme', provider: 'github', reference: { forge: 'gh', project: 'acme' } };
// `entire trail show`: the row, the trail's address, and every change.
const trailDetail = (n, changes, extra = {}) =>
  json({ ...trailItem(n), project: trailProjectInfo, url: trailUrl(n), changes, ...extra });
const timelinePage = (titles, nextPageToken = null) =>
  json({
    items: titles.map((title, position) => timelineCommit(`event-${position}`, title, NEVER_FETCHED)),
    nextPageToken,
    commitCount: titles.length,
    incomplete: false,
  });
// Trail 120, as `entire trail show` reports it. It has a branch in another
// repository too, which its row in the list leaves out.
const trail120 = trailDetail(
  120,
  [
    trailChange('widget', 1120, 'main', {
      url: `${trailUrl(120)}/changes/widget/1120`,
      mergeability: {
        head_sha: main.parserCommit,
        mergeable: false,
        conflict_status: 'clean',
        checks: {
          availability: 'available',
          runs: [
            { name: 'build', status: 'completed', conclusion: 'success', details_url: 'https://ci.example.test/runs/1', app_name: 'CI' },
            { name: 'lint', status: 'completed', conclusion: 'failure', details_url: 'https://ci.example.test/runs/2', app_name: 'CI' },
            { name: 'deploy', status: 'in_progress', conclusion: null, details_url: null, app_name: null },
          ],
        },
        gates: [
          gate('approvals', 'failed', { rationale: '0 of 1 required approvals.' }),
          gate('checks', 'failed', { rationale: '1 check failed.' }),
          gate('findings', 'passed', { finding_count: 0 }),
          gate('up_to_date', 'skipped', { blocking: false, state: 'disabled', outcome: null }),
        ],
      },
    }),
    // A second branch of the same trail, in a repository that is not open here.
    trailChange('docs', 9, 'feature/120-docs', {
      hasCodeChanges: false,
      url: `${trailUrl(120)}/changes/docs/9`,
      mergeability: {
        head_sha: null,
        mergeable: true,
        conflict_status: 'clean',
        checks: { availability: 'unavailable', runs: [] },
        gates: [],
      },
    }),
  ],
  {
    title: 'Rework the parser',
    body: 'Rework the **parser**.\n\n- Sketch it\n- Write it\n',
    assignees: ['fixture-author'],
    priority: 'high',
  },
);
const merged = { status: 'merged' };

const trailReplies = {
  [trailList('open')]: trailPage(descending(120, 71), 'page-2', 120),
  [trailList('open', 'page-2')]: trailPage(descending(70, 21), 'page-3', 120),
  [trailList('open', 'page-3')]: trailPage(descending(20, 1), null, 120),
  [trailList('closed')]: trailPage([9002, 9001], null, 2),
  [trailList('all')]: trailPage([9002, 120, 119, 118, 117, 9001], null, 6),
  [trailShow(trailId(120))]: trail120,
  // A trail is named by its number when its ID is not known.
  [trailShow(120)]: trail120,
  // Asked for the timeline of a trail that has two open changes, the CLI names them and stops.
  [trailTimeline(trailId(120))]: {
    stderr:
      'trail #120 has 2 open changes; choose one:\n  widget/1120 - main (no reviews yet)\n  docs/9 - feature/120-docs (no reviews yet)\n',
    exitCode: 1,
  },
  [trailTimeline('widget/1120')]: json({
    items: [
      {
        id: 'event-review',
        kind: 'review_posted',
        actor: { login: null, label: 'Review Agent', identity: { kind: 'agent', display_name: 'Review Agent' } },
        occurredAt: '2026-03-02T10:00:00Z',
        findingCount: 2,
      },
      // In the fixture repository, with one checkpoint.
      timelineCommit('event-parser', 'Add the parser', main.parserCommit, { agents: ['Claude Code'] }),
      // On entire.io, but never fetched into the fixture repository.
      timelineCommit('event-remote', 'Tune the lexer', NEVER_FETCHED, { checkpointCount: 2 }),
    ],
    nextPageToken: 'timeline-2',
    commitCount: 3,
    incomplete: false,
  }),
  [trailTimeline('widget/1120', 'timeline-2')]: json({
    items: [
      // In the fixture repository, with two checkpoints.
      timelineCommit('event-squash', 'Squash the review fixes', main.squashCommit),
      { id: 'event-created', kind: 'trail_created', actor: person, occurredAt: '2026-03-01T00:00:00Z' },
    ],
    nextPageToken: null,
    commitCount: 3,
    incomplete: false,
  }),
  // The same SHA as a commit in the fixture repository, on a change that belongs to another one.
  [trailTimeline('docs/9')]: json({
    items: [timelineCommit('event-docs', 'Describe the parser', main.parserCommit)],
    nextPageToken: null,
    commitCount: 1,
    incomplete: true,
  }),
  // Trail 118 is in the complete phase, so its row names no change. It has one.
  [trailShow(trailId(118))]: trailDetail(118, [
    trailChange('widget', 1118, 'feature/118', { ...merged, url: `${trailUrl(118)}/changes/widget/1118` }),
  ]),
  [trailTimeline(trailId(118))]: timelinePage(['Finish trail 118', 'Start trail 118'], 'timeline-118-2'),
  [trailTimeline(trailId(118), 'timeline-118-2')]: timelinePage(['Plan trail 118']),
  // The same timeline, asked for by its change. The token is another one, as tokens are opaque.
  [trailTimeline('widget/1118')]: timelinePage(['Finish trail 118', 'Start trail 118'], 'timeline-118-again'),
  // Trail 114, also complete, has a merged change and an open one. Asked
  // for the trail's timeline, the CLI reads the open change and does not say so.
  [trailShow(trailId(114))]: trailDetail(114, [
    trailChange('widget', 1114, 'feature/114', merged),
    trailChange('widget', 2114, 'feature/114-next'),
  ]),
  [trailTimeline(trailId(114))]: timelinePage(['On the open change of trail 114']),
  [trailTimeline('widget/1114')]: timelinePage(['On the merged change of trail 114']),
  // Trail 110, also complete, has one change, and the CLI will not pick it.
  [trailShow(trailId(110))]: trailDetail(110, [trailChange('widget', 1110, 'feature/110', merged)]),
  [trailTimeline(trailId(110))]: { stderr: 'trail #110 has no open change; name one\n', exitCode: 1 },
  [trailTimeline('widget/1110')]: timelinePage(['Finish trail 110']),
  // Trail 106, also complete, has one change, which was closed. Its branch is
  // gone, so the CLI has nothing to pick, and it is slow to say so.
  [trailShow(trailId(106))]: trailDetail(106, [trailChange('widget', 1106, '', { status: 'closed' })]),
  [trailTimeline(trailId(106))]: { stderr: 'trail #106 has no open changes\n', exitCode: 1, delayMs: 4000 },
  [trailTimeline('widget/1106')]: timelinePage(['Close trail 106']),
  // Trail 116 is in the building phase, and its row names both of its changes.
  [trailShow(trailId(116))]: trailDetail(116, [
    trailChange('widget', 1116, 'feature/116'),
    trailChange('widget', 2116, 'feature/116-b'),
  ]),
  [trailTimeline('widget/1116')]: timelinePage(['On the first change of trail 116']),
  [trailShow(404)]: { stderr: 'project trail #404 not found in gh/acme\n', exitCode: 1 },
  [trailTimeline(404)]: { stderr: 'project trail #404 not found in gh/acme\n', exitCode: 1 },
};
// The brain graph, as the entire-brain plugin answers through the CLI. The
// page itself is not served: the tests check which address would be opened.
const BRAIN_URL = 'http://127.0.0.1:43117';
const brainReplies = {
  'brain status --json': json({
    generated_at: '2026-03-02T00:00:00Z',
    repo: { root: '/fixture', key: 'gh/acme/widget' },
    brain: {
      path: '/fixture-brain',
      schema_version: 5,
      supported_schema_version: 5,
      manifest_state: 'current',
      generated_at: '2026-03-02T00:00:00Z',
    },
    sources: { seed: true, sessions: true, semantic: true, history: true, facts: true, docs: true },
    facts: { facts: 8, distilled: 8 },
    hosted: { state: 'connected', repo_state: 'connected', no_egress: false, synced: true },
    semantic: {
      coverage: { files: 3, symbols: 1204, relations: 20 },
      freshness: { severity: 'degraded', axes: { graph: { state: 'stale', detail: 'the index is 2 commits behind HEAD' } } },
    },
    retrieval: {
      docs_records: 5,
      docs_files: 2,
      conversation: { exchanges: 40 },
      freshness: { severity: 'ok', axes: { docs: { state: 'ok', detail: 'current' } } },
    },
    onboarding: { daemon: { manager: 'launchd', installed: true, running: false } },
    live: { branch: 'main' },
    warnings: ['agents not wired: run entire brain setup so your agent uses this brain'],
  }),
  // The two lines the plugin prints once it is listening. It then serves until it is stopped.
  'brain viz --no-open --port 0': {
    stdout: `entire brain viz \u2014 ${BRAIN_URL}\nRead-only, loopback-only, no network. Press Ctrl-C to stop.\n`,
    hang: true,
  },
};
// Entire's search, for the query the search tests type. It ranks a commit
// the fixture repository has, with its checkpoint, then a session that only
// Entire knows, then a commit the clone has never fetched, and a pull
// request, which the extension cannot open.
const SEARCH_KEY = (query) => `search --json --limit 25 -- ${query}`;
const searchReplies = {
  [SEARCH_KEY('parser')]: json({
    results: [
      {
        type: 'commit',
        data: {
          commitSha: main.parserCommit,
          commitSubject: 'Add the parser',
          commitMessage: `Add the parser\n\nEntire-Checkpoint: ${ids.refs}`,
          branch: 'main',
          author: 'Fixture Author',
          createdAt: '2026-01-02T03:04:05Z',
        },
        searchMeta: { matchType: 'both', score: 3 },
      },
      {
        type: 'session',
        data: {
          sessionId: 'searched-session',
          matchedCheckpointId: ids.onEntire,
          displayName: 'Tune the Parser Elsewhere',
          prompt: 'Tune the parser',
          agent: 'Codex',
          branch: 'tune-lexer',
          createdAt: '2025-11-20T00:00:00Z',
        },
        searchMeta: { matchType: 'semantic', score: 2, snippet: '[user]: Tune the parser\n[assistant]: It is tuned.' },
      },
      {
        type: 'commit',
        data: { commitSha: NEVER_FETCHED, commitSubject: 'Write down how the parser works', commitMessage: 'Write down how the parser works', branch: 'notes' },
        searchMeta: { matchType: 'semantic', score: 1 },
      },
      { type: 'pr', data: { id: 7, title: 'Parser pull request' }, searchMeta: { score: 1 } },
    ],
    total: 4,
    page: 1,
    total_pages: 1,
    limit: 25,
    counts: { repos: 0, checkpoints: 0, commits: 2, prs: 1, sessions: 1 },
  }),
};
const mainScenario = { ...healthy, ...trailReplies, ...brainReplies, ...searchReplies };
const mainScenarioFile = writeJson('healthy.json', mainScenario);

const mainConfig = {
  label: 'explorer',
  files: [
    'test/integration/extension.test.cjs',
    'test/integration/trails.test.cjs',
    'test/integration/brain.test.cjs',
    // Last: its login step pins the Setup view in this window.
    'test/integration/search.test.cjs',
  ],
  workspaceFolder: main.repo.root,
  launchArgs: launchArgs(profile('main', fakeCli)),
  env: {
    FAKE_ENTIRE_SCENARIO: mainScenarioFile,
    FAKE_ENTIRE_LOG: mainLog,
    ENTIRE_TEST_FIXTURE: writeJson('main-fixture.json', {
      root: main.repo.root,
      ids,
      parserCommit: main.parserCommit,
      squashCommit: main.squashCommit,
      missingCommit: main.missingCommit,
      logFile: mainLog,
      rawSmall,
      rawLargeBytes: rawLine.length * rawLargeTimes,
      // For the trail tests, which change what the fake CLI replies while they run.
      scenarioFile: mainScenarioFile,
      scenario: mainScenario,
      trailListOpen: trailList('open'),
      trailListAll: trailList('all'),
      trailUrl: trailUrl(120),
      brainUrl: BRAIN_URL,
      searchKey: SEARCH_KEY('parser'),
      // The IDs of the trails the tests open, by number.
      trailIds: Object.fromEntries([106, 110, 114, 116, 118, 120].map((n) => [n, trailId(n)])),
      neverFetched: NEVER_FETCHED,
    }),
  },
  mocha,
};

/** A launch that only checks which state the views settle in. */
function stateConfig(label, expected, options) {
  const expectation = { state: expected, ...(options.expect ?? {}) };
  return {
    label,
    files: 'test/integration/states.test.cjs',
    workspaceFolder: options.workspace,
    launchArgs: launchArgs(profile(label, options.cliPath ?? fakeCli)),
    env: {
      FAKE_ENTIRE_SCENARIO: writeJson(`${label}.json`, options.scenario ?? healthy),
      ENTIRE_TEST_EXPECT: JSON.stringify(expectation),
    },
    mocha,
  };
}

// Paging: a repository with more rows than one page in every list, and one
// whose history is longer than a scan window. Both open in one workspace.
const hexId = (prefix, n) => `${prefix}${n.toString(16).padStart(12 - prefix.length, '0')}`;

const paging = createFixtureRepo();
repos.push(paging);
paging.commit('Initial commit');
// 120 linked commits. The newest is "Linked commit 119".
paging.bulkCommits(
  Array.from({ length: 120 }, (_, n) => `Linked commit ${n}\n\nEntire-Checkpoint: ${hexId('', n)}\n`),
);

// 2,100 commits, oldest first. Counted from the tip: the newest 60 are linked,
// then 1,940 are not, so the first scan window of 2,000 commits holds 60
// linked ones. The next 40 are linked, and the oldest 60 are not.
function deepRepo() {
  const repo = createFixtureRepo();
  repos.push(repo);
  repo.bulkCommits(
    Array.from({ length: 2100 }, (_, position) => {
      const depth = 2099 - position;
      const linked = depth < 60 || (depth >= 2000 && depth < 2040);
      return linked ? `Deep commit ${depth}\n\nEntire-Checkpoint: ${hexId('d', depth)}\n` : `Deep commit ${depth}\n`;
    }),
  );
  return repo;
}
const deep = deepRepo();
// A second copy, for the test that starts two loads at once.
const overlap = deepRepo();

const pagingScenario = {
  ...healthy,
  'checkpoint explain --json --limit 500 --no-pager': json([
    ...[119, 118, 117].map((n) => ({
      checkpoint_id: hexId('', n),
      session_id: 'session-0',
      agent: 'Claude Code',
      date: `2026-02-01T00:${String(n - 100).padStart(2, '0')}:00Z`,
      message: `Linked commit ${n}`,
      session_count: 1,
      session_ids: ['session-0'],
    })),
    // 60 checkpoints that no commit carries, all from one session.
    ...Array.from({ length: 60 }, (_, n) => ({
      checkpoint_id: hexId('f', n),
      session_id: 'imported-session',
      agent: 'Claude Code',
      date: `2026-01-01T00:${String(59 - n).padStart(2, '0')}:00Z`,
      message: `Imported work ${n}`,
      session_count: 1,
      session_ids: ['imported-session'],
    })),
  ]),
  'session list --json': json(
    Array.from({ length: 70 }, (_, n) => ({
      session_id: `local-${n}`,
      agent: 'Claude Code',
      status: 'ended',
      last_prompt: `Local prompt ${n}`,
      // One minute apart, with local-0 the most recent.
      last_active: new Date(Date.UTC(2026, 2, 1) + (69 - n) * 60_000).toISOString(),
    })),
  ),
};

const pagingWorkspace = path.join(scratch, 'paging.code-workspace');
writeFileSync(
  pagingWorkspace,
  JSON.stringify({ folders: [{ path: paging.root }, { path: deep.root }, { path: overlap.root }] }),
);
const pagingConfig = {
  label: 'paging',
  files: 'test/integration/paging.test.cjs',
  workspaceFolder: pagingWorkspace,
  // Loading on scroll is off here, so these tests see only what a click loads.
  launchArgs: launchArgs(profile('paging', fakeCli, { 'entire.loadOnScroll': false })),
  env: {
    FAKE_ENTIRE_SCENARIO: writeJson('paging.json', pagingScenario),
    ENTIRE_TEST_FIXTURE: writeJson('paging-fixture.json', {
      pagingRoot: paging.root,
      deepRoot: deep.root,
      overlapRoot: overlap.root,
    }),
  },
  mocha,
};

// Loading on scroll: a repository with 120 linked commits, and one whose
// history is long and almost empty of checkpoints.
const scrolling = createFixtureRepo();
repos.push(scrolling);
scrolling.commit('Initial commit');
scrolling.bulkCommits(
  Array.from({ length: 120 }, (_, n) => `Linked commit ${n}\n\nEntire-Checkpoint: ${hexId('', n)}\n`),
);

const sparse = createFixtureRepo();
repos.push(sparse);
// 44,100 commits. Counted from the tip: the newest 60 are linked, the next
// 43,940 are not, then 40 are linked, and the oldest 60 are not. One scan
// covers 20,000 commits at most, so two scans in a row find nothing.
const SPARSE_TOTAL = 44_100;
sparse.bulkCommits(
  Array.from({ length: SPARSE_TOTAL }, (_, position) => {
    const depth = SPARSE_TOTAL - 1 - position;
    const linked = depth < 60 || (depth >= 44_000 && depth < 44_040);
    return linked ? `Sparse commit ${depth}\n\nEntire-Checkpoint: ${hexId('e', depth)}\n` : `Sparse commit ${depth}\n`;
  }),
);

const scrollWorkspace = path.join(scratch, 'scroll.code-workspace');
writeFileSync(scrollWorkspace, JSON.stringify({ folders: [{ path: scrolling.root }, { path: sparse.root }] }));
const scrollConfig = {
  label: 'scroll',
  files: 'test/integration/scroll.test.cjs',
  workspaceFolder: scrollWorkspace,
  launchArgs: launchArgs(profile('scroll', fakeCli)),
  env: {
    FAKE_ENTIRE_SCENARIO: writeJson('scroll.json', pagingScenario),
    ENTIRE_TEST_FIXTURE: writeJson('scroll-fixture.json', { scrollRoot: scrolling.root, sparseRoot: sparse.root }),
  },
  mocha,
};

const plainFolder = path.join(scratch, 'plain-folder');
mkdirSync(plainFolder);

const second = checkpointRepo();
const multiRoot = path.join(scratch, 'two-repos.code-workspace');
writeFileSync(multiRoot, JSON.stringify({ folders: [{ path: main.repo.root }, { path: second.repo.root }] }));

// Setup: a repository on Entire where nothing is set up yet. Entire is not
// enabled, nobody is logged in, and neither plugin has done anything. The
// tests change these replies as each step runs.
const setupRepo = checkpointRepo();
const setupLog = path.join(scratch, 'setup.log');
writeFileSync(setupLog, '');
const setupScenario = {
  ...healthy,
  ...trailReplies,
  'status --json': json({ enabled: false, agents: null, active_sessions: null, error: 'not set up' }),
  'auth status --json': { stdout: '{"logged_in":false}\n', exitCode: 1 },
  'graph version --json': {
    stderr: 'Usage:\n  entire [command]\n\nError: Invalid usage: unknown command "graph" for "entire"\n',
    exitCode: 1,
  },
  'brain status --json': json({ brain: { manifest_state: 'absent' } }),
};
const setupScenarioFile = writeJson('setup.json', setupScenario);
const setupConfig = {
  label: 'setup',
  files: 'test/integration/setup.test.cjs',
  workspaceFolder: setupRepo.repo.root,
  launchArgs: launchArgs(profile('setup', fakeCli)),
  env: {
    FAKE_ENTIRE_SCENARIO: setupScenarioFile,
    FAKE_ENTIRE_LOG: setupLog,
    ENTIRE_TEST_FIXTURE: writeJson('setup-fixture.json', {
      root: setupRepo.repo.root,
      cli: fakeCli,
      logFile: setupLog,
      scenarioFile: setupScenarioFile,
      scenario: setupScenario,
      enabledStatus: healthy['status --json'],
    }),
  },
  mocha,
};

const editor = process.env.ENTIRE_TEST_EDITOR;
const inEditor = (config) => (editor ? { ...config, useInstallation: { fromPath: editor } } : config);

export default defineConfig(
  [
  mainConfig,
  pagingConfig,
  scrollConfig,
  setupConfig,
  stateConfig('not-git', 'notGit', { workspace: plainFolder }),
  stateConfig('cli-missing', 'cliMissing', { workspace: main.repo.root, cliPath: path.join(scratch, 'no-such-entire') }),
  stateConfig('cli-too-old', 'cliTooOld', {
    workspace: main.repo.root,
    scenario: { ...healthy, version: { stdout: 'Entire CLI 0.11.9\n' } },
  }),
  stateConfig('not-enabled', 'notEnabled', {
    workspace: main.repo.root,
    // The origin is an entire:// remote, so trails are on offer before Entire is enabled.
    expect: { trailRepos: 1 },
    scenario: {
      ...healthy,
      'status --json': json({ enabled: false, agents: null, active_sessions: null, error: 'not set up' }),
    },
  }),
  stateConfig('multi-root', 'ready', { workspace: multiRoot, expect: { repos: 2, trailRepos: 2 } }),
  ].map(inEditor),
);
