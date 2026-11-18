// Runs inside a VS Code extension host, last in the window that extension.test.cjs,
// trails.test.cjs, and brain.test.cjs share. See .vscode-test.mjs for what the
// fake Entire CLI's search answers. The picker itself is a widget the tests
// cannot type into, so they drive the search through the engine behind it,
// which builds the same items, and open what it found as a pick would.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

const fixture = JSON.parse(fs.readFileSync(process.env.ENTIRE_TEST_FIXTURE, 'utf8'));

/** Every fake CLI invocation so far, as "arg arg arg" strings. */
function invocations() {
  return fs
    .readFileSync(fixture.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).join(' '));
}
const calls = (prefix) => invocations().filter((call) => call.startsWith(prefix));

async function until(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const SEPARATOR = -1;

suite('Entire search', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let repo;
  /** Changes what the fake CLI replies from now on. */
  const reply = (changes) => fs.writeFileSync(fixture.scenarioFile, JSON.stringify({ ...fixture.scenario, ...changes }));
  /** The items as "label | description", headings as "-- label --". */
  const lines = (items) =>
    items.map((item) => (item.kind === SEPARATOR ? `-- ${item.label} --` : `${item.label} | ${item.description ?? ''}`));
  const results = (items) => items.filter((item) => item.target);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    assert.ok(extension, 'the extension is installed in the test host');
    api = await extension.activate();
    await until(() => api.manager.viewState === 'ready', 'the first load');
    repo = api.manager.repoFor(fixture.root);
    assert.ok(repo, 'the fixture repository is open');
    // The commits and their checkpoints, which local matching reads.
    await until(() => repo.index?.commits.length > 0 && repo.index.allRows().length > 0, 'the checkpoints to be read');
  });

  suiteTeardown(async () => {
    reply({});
    await api.setup.hide();
  });

  test('asks Entire nothing until a search is made', () => {
    assert.deepEqual(calls('search'), []);
  });

  test('has a Search button on each view, and the command in the palette', () => {
    const { menus, commands } = vscode.extensions.getExtension('entire.entire').packageJSON.contributes;
    assert.deepEqual(
      menus['view/title'].filter((entry) => entry.command.startsWith('entire.search')),
      [
        { command: 'entire.searchCheckpoints', when: "view == entire.checkpoints && entire.viewState == 'ready'", group: 'navigation@0' },
        { command: 'entire.searchSessions', when: "view == entire.sessions && entire.viewState == 'ready'", group: 'navigation@0' },
        { command: 'entire.searchTrails', when: 'view == entire.trails', group: 'navigation@0' },
      ],
    );
    for (const command of ['entire.search', 'entire.searchCheckpoints', 'entire.searchSessions', 'entire.searchTrails']) {
      assert.equal(commands.find((entry) => entry.command === command)?.icon, '$(search)', command);
    }
    // The search is always in the palette: it says what to set up when there is nothing to search.
    assert.equal(menus.commandPalette.find((entry) => entry.command === 'entire.search'), undefined);
  });

  test('matches what the views have read at once, without asking Entire', () => {
    const groups = api.search.engine().local('parser');
    assert.deepEqual(
      groups.checkpoints.map((item) => item.label),
      ['Add the parser'],
    );
    assert.deepEqual(groups.checkpoints[0].target, {
      kind: 'checkpoint',
      root: fixture.root,
      checkpointId: fixture.ids.refs,
      commitSha: fixture.parserCommit,
    });
    assert.match(groups.checkpoints[0].description, /^Checkpoint · [0-9a-f]{7,} · Claude Code · /);
    assert.deepEqual(calls('search'), []);
  });

  test('lists the newest checkpoints and sessions before anything is typed', () => {
    const groups = api.search.engine().recent();
    assert.ok(groups.checkpoints.length > 0);
    assert.ok(groups.sessions.length > 0);
    assert.deepEqual(calls('search'), []);
  });

  test("adds Entire's results, best first, under their kind, without repeating a checkpoint", async () => {
    const items = await api.search.engine().collect('parser');
    assert.equal(calls(fixture.searchKey).length, 1);
    const shown = lines(items);
    assert.deepEqual(shown.slice(0, 1), ['-- Checkpoints --']);
    // The commit Entire ranked first is the one the views have read: it is listed once, as Entire ranked it.
    assert.equal(shown.filter((line) => line.startsWith('Add the parser |')).length, 1);
    assert.match(shown[1], /^Add the parser \| Checkpoint · [0-9a-f]{7} · main · Fixture Author/);
    assert.match(shown[2], /^Write down how the parser works \| Commit · ffffffff?/);
    const sessions = shown.indexOf('-- Sessions --');
    assert.ok(sessions > 0, 'the sessions have a heading');
    assert.match(shown[sessions + 1], /^Tune the Parser Elsewhere \| Session · Codex · tune-lexer/);
    // The session's line under it is the part of its transcript that matched.
    assert.equal(results(items).find((item) => item.target.kind === 'session').detail, '[user]: Tune the parser [assistant]: It is tuned.');
    // A pull request is not something the extension can open.
    assert.ok(!shown.some((line) => line.startsWith('Parser pull request')));
    for (const item of results(items)) assert.equal(item.alwaysShow, true);
  });

  test('searches one kind when a view asks', async () => {
    const before = calls(fixture.searchKey).length;
    const items = await api.search.engine().collect('parser', 'sessions');
    assert.equal(calls(fixture.searchKey).length, before + 1);
    // One kind needs no heading.
    assert.ok(items.every((item) => item.kind !== SEPARATOR));
    assert.ok(results(items).every((item) => item.target.kind === 'session'));
    assert.ok(results(items).some((item) => item.target.sessionId === 'searched-session'));
  });

  test('finds trails by number, read once for the search', async () => {
    const engine = api.search.engine();
    const before = calls(`trail list --project gh/acme --repo gh/acme/widget --limit 50 --json`).length;
    const items = await engine.collect('#118', 'trails');
    assert.deepEqual(
      results(items).map((item) => [item.label, item.target]),
      [['Trail 118', { kind: 'trail', root: fixture.root, number: 118, id: fixture.trailIds[118] }]],
    );
    // A closed trail is found too: the search reads every trail, not only the open ones.
    const closed = await engine.collect('9002', 'trails');
    assert.deepEqual(results(closed).map((item) => item.target.number), [9002]);
    assert.equal(calls(`trail list --project gh/acme --repo gh/acme/widget --limit 50 --json`).length, before + 1);
    // Trails are never sent to Entire's search.
    assert.deepEqual(calls('search --json --limit 25 -- #118'), []);
  });

  test('opens a session that only Entire knows at the checkpoint that matched', async () => {
    const items = await api.search.engine().collect('parser', 'sessions');
    const session = results(items).find((item) => item.target.sessionId === 'searched-session');
    await api.search.accept(session, { newTab: false });
    const header = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.onEntire ? snapshot.header : undefined;
    }, 'the panel to show the checkpoint that matched');
    assert.equal(header.mode, 'checkpoint');
  });

  test('opens a checkpoint it found in the detail panel', async () => {
    const items = await api.search.engine().collect('parser', 'checkpoints');
    const checkpoint = results(items).find((item) => item.target.checkpointId === fixture.ids.refs);
    await api.search.accept(checkpoint, { newTab: false });
    await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.refs;
    }, 'the panel to show the checkpoint');
  });

  test('offers a login when Entire says there is none, and runs it as a Setup step', async () => {
    reply({ [fixture.searchKey]: { stderr: 'Error: not logged in. Run entire login.\n', exitCode: 1 } });
    const items = await api.search.engine().collect('parser');
    const hint = items.at(-1);
    assert.equal(hint.hint, 'login');
    assert.equal(hint.label, 'Log in to Entire to search sessions and trails on Entire');
    // What the views have read is still found.
    assert.ok(results(items).some((item) => item.label === 'Add the parser'));

    const runs = [];
    api.setup.runner = {
      run: async (request) => {
        runs.push(request);
        return { tracked: true, exitCode: 0 };
      },
    };
    await api.search.accept(hint, { newTab: false });
    assert.equal(runs.length, 1);
    assert.match(runs[0].commandLine, / login$/);
    assert.equal(runs[0].terminalName, 'Entire Setup');
  });

  test('says when Entire could not be searched, and keeps what it found here', async () => {
    reply({ [fixture.searchKey]: { stderr: 'internal error\n', exitCode: 1 } });
    const items = await api.search.engine().collect('parser');
    assert.equal(items.at(-1).hint, 'log');
    assert.ok(results(items).some((item) => item.label === 'Add the parser'));
  });

  test('asks only what it has read when searching Entire is turned off', async () => {
    reply({});
    const config = vscode.workspace.getConfiguration('entire');
    await config.update('search.hosted', false, vscode.ConfigurationTarget.Global);
    try {
      const before = calls('search').length;
      const items = await api.search.engine().collect('parser', 'checkpoints');
      assert.equal(calls('search').length, before);
      assert.deepEqual(
        results(items).map((item) => item.label),
        ['Add the parser'],
      );
    } finally {
      await config.update('search.hosted', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
