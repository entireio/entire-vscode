// Runs inside a VS Code extension host, in a window of its own: a repository
// on Entire where nothing is set up yet. See .vscode-test.mjs. The tests
// replace the runner that types each step's command into a terminal, so that
// nothing is installed, enabled, or logged into for real. Each stand-in run
// changes what the fake Entire CLI replies, as the real command would.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

const json = (value) => ({ stdout: JSON.stringify(value) });

suite('Entire setup', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let manifest;
  /** What the fake CLI replies on top of the scenario, as the steps run. */
  let replies = {};
  /** Changes what the fake CLI replies from now on. */
  const reply = (changes) => {
    replies = { ...replies, ...changes };
    fs.writeFileSync(fixture.scenarioFile, JSON.stringify({ ...fixture.scenario, ...replies }));
  };
  /** The commands the stand-in runner was given. */
  const runs = [];
  /** What each stand-in run does, by the end of its command line. */
  let effects = {};
  let tracked = true;

  /** The steps of the page as "id: state [actions]". */
  const steps = () => {
    const page = api.setup.page();
    assert.equal(page.kind, 'steps');
    const line = (view) => `${view.id}: ${view.state}${view.buttons.length ? ` [${view.buttons.map((button) => button.action).join(', ')}]` : ''}`;
    return [...page.model.machine.map(line), ...page.model.repos.flatMap((entry) => entry.steps.map(line))];
  };
  const settled = () => steps().every((line) => !line.includes(': checking'));
  const run = (root, action) => vscode.commands.executeCommand('entire.runSetupStep', root, action);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    assert.ok(extension, 'the extension is installed in the test host');
    manifest = extension.packageJSON.contributes;
    api = await extension.activate();
    await until(() => api.manager.viewState === 'notEnabled', 'the first load');
  });

  suiteTeardown(() => {
    replies = {};
    reply({});
  });

  test('is first in the sidebar, and shows itself while Entire is not enabled', async () => {
    assert.deepEqual(manifest.views.entire[0], { id: 'entire.setup', name: 'Setup', type: 'webview', when: 'entire.showSetup' });
    assert.equal(api.setup.showSetup, true);
    assert.equal(api.setup.pinned, false);
    // The welcome text of the other views leads here.
    const welcome = manifest.viewsWelcome.filter((entry) => /cliMissing|cliTooOld|notEnabled/.test(entry.when));
    assert.equal(welcome.length, 6);
    for (const entry of welcome) assert.match(entry.contents, /\[Set Up Entire\]\(command:entire\.openSetup\)/);
    // Nothing is read for it until it is on screen. Someone watching this window may have opened it already.
    if (!api.setupView.visible) {
      assert.equal(api.setupView.html, '');
      assert.deepEqual(calls('auth'), []);
      assert.deepEqual(calls('graph'), []);
    }
  });

  test('opens a terminal named for setup, and runs a command line in it', async () => {
    const result = await api.setup.runner.run({ cwd: fixture.root, terminalName: 'Entire Setup', commandLine: 'echo entire-setup-test' });
    assert.equal(typeof result.tracked, 'boolean');
    if (result.tracked && result.exitCode !== undefined) assert.equal(result.exitCode, 0);
    assert.ok(vscode.window.terminals.some((terminal) => terminal.name === 'Entire Setup'));
    for (const terminal of vscode.window.terminals) terminal.dispose();
  });

  test('reads every step when it is opened, and stays from then on', async () => {
    // From here on, a stand-in runs the commands.
    api.setup.runner = {
      run: async (request) => {
        runs.push(request);
        const effect = Object.entries(effects).find(([ending]) => request.commandLine.endsWith(ending));
        if (effect) await effect[1](request);
        return tracked ? { tracked: true, exitCode: 0 } : { tracked: false };
      },
    };
    await vscode.commands.executeCommand('entire.openSetup');
    await until(() => api.setupView.visible, 'the Setup view to show');
    assert.equal(api.setup.pinned, true);
    await until(settled, 'every step to be read');
    assert.deepEqual(steps(), [
      'cli: done',
      // The repository is on Entire, so the login is needed for its trails and its hosted brain.
      'login: needed [login]',
      'enable: needed [enable]',
      'graph: optional [installGraph]',
      'brain: optional [setupBrain]',
      'connect: blocked',
    ]);
    assert.ok(calls('auth status --json').length >= 1);
    assert.ok(calls('graph version --json').length >= 1);
    assert.ok(calls('brain status --json').length >= 1);
    assert.match(api.setupView.html, /Brain Connect/);
    assert.doesNotMatch(api.setupView.html, /<script/i);
  });

  test('runs nothing for a step it does not know, or for a repository that is not open', async () => {
    await run(fixture.root, 'rm -rf');
    await run('/no/such/repository', 'enable');
    await run(undefined, 'enable');
    assert.equal(runs.length, 0);
  });

  test('enables Entire in a terminal, and shows the views when the command ends, without a refresh', async () => {
    effects = { ' enable': () => reply({ 'status --json': fixture.enabledStatus }) };
    await run(fixture.root, 'enable');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].cwd, fixture.root);
    assert.equal(runs[0].terminalName, 'Entire Setup');
    // The CLI, as the setting names it, then constant arguments.
    assert.equal(runs[0].commandLine, `${fixture.cli} enable`);
    await until(() => api.manager.viewState === 'ready', 'Entire to be enabled');
    // The view stays for the steps that are left.
    assert.equal(api.setup.showSetup, true);
    await until(() => steps().includes('enable: done'), 'the step to be done');
  });

  test('logs in, and reads again what a login changes', async () => {
    effects = { ' login': () => reply({ 'auth status --json': json({ logged_in: true, user: 'github:fixture-author' }) }) };
    const reloads = calls('status --json').length;
    await run(null, 'login');
    assert.match(runs.at(-1).commandLine, / login$/);
    await until(() => steps().includes('login: done'), 'the login to be done');
    // A login is followed by a refresh, which reads the status again.
    assert.ok(calls('status --json').length > reloads);
  });

  test('installs the Graph plugin, then sets it up', async () => {
    effects = { ' plugin install graph': () => reply({ 'graph version --json': json({ version: 'v0.6.0' }) }) };
    await run(fixture.root, 'installGraph');
    assert.match(runs.at(-1).commandLine, / plugin install graph$/);
    await until(() => steps().includes('graph: optional [setupGraph]'), 'the plugin to be installed');

    effects = {
      ' graph setup': () => {
        fs.mkdirSync(path.join(fixture.root, '.entire'), { recursive: true });
        fs.writeFileSync(path.join(fixture.root, '.entire', 'agent-guide.md'), 'Run entire graph query before you edit.\n');
      },
    };
    await run(fixture.root, 'setupGraph');
    await until(() => steps().includes('graph: done'), 'Graph to be set up');
  });

  test('counts a command it cannot follow as running until the user checks', async () => {
    tracked = false;
    effects = {};
    await run(fixture.root, 'setupBrain');
    assert.match(runs.at(-1).commandLine, / brain setup$/);
    assert.ok(steps().includes('brain: running'));
    assert.match(api.setupView.html, /Running in the terminal/);

    reply({ 'brain status --json': json({ brain: { manifest_state: 'current' }, hosted: { state: 'disconnected' } }) });
    await vscode.commands.executeCommand('entire.checkSetup');
    await until(() => steps().includes('brain: done'), 'the brain to be built');
    tracked = true;
    // With a brain and a login, the brain can connect to its hosted brain.
    assert.ok(steps().includes('connect: optional [connectBrain]'));
  });

  test('connects the brain, and then everything is set up', async () => {
    effects = {
      ' brain connect': () =>
        reply({ 'brain status --json': json({ brain: { manifest_state: 'current' }, hosted: { state: 'connected', synced: true } }) }),
    };
    await run(fixture.root, 'connectBrain');
    await until(() => steps().includes('connect: done'), 'the brain to connect');
    assert.equal(api.setup.page().model.complete, true);
    assert.match(api.setupView.html, /Entire is set up\./);
  });

  test('leaves the sidebar when hidden, and comes back when asked', async () => {
    await vscode.commands.executeCommand('entire.hideSetup');
    assert.equal(api.setup.pinned, false);
    assert.equal(api.setup.showSetup, false);
    await vscode.commands.executeCommand('entire.openSetup');
    assert.equal(api.setup.showSetup, true);
    await vscode.commands.executeCommand('entire.hideSetup');
  });

  test('copies nothing and runs every command through the runner', () => {
    // Every setup command went to the stand-in. None ran as a child of the extension.
    assert.deepEqual(calls('enable'), []);
    assert.deepEqual(calls('login'), []);
    assert.deepEqual(calls('plugin'), []);
    assert.deepEqual(calls('graph setup'), []);
    assert.deepEqual(calls('brain setup'), []);
    assert.deepEqual(calls('brain connect'), []);
  });
});
