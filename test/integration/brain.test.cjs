// Runs inside a VS Code extension host, last in the window that extension.test.cjs
// and trails.test.cjs share. See .vscode-test.mjs for what the fake Entire CLI
// replies to the brain commands. The fake stands in for the entire-brain
// plugin: it reports a brain, and for the graph it prints an address and
// stays up, and serves nothing.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

const fixture = JSON.parse(fs.readFileSync(process.env.ENTIRE_TEST_FIXTURE, 'utf8'));
const posix = process.platform !== 'win32';
const STATUS = 'brain status --json';
const VIZ = 'brain viz --no-open --port 0';

/** Every fake CLI invocation so far, as "arg arg arg" strings. */
function invocations() {
  return fs
    .readFileSync(fixture.logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line).join(' '));
}
const calls = (prefix) => invocations().filter((call) => call.startsWith(prefix));

/** How many of the fake CLI's graph servers are running on this machine. */
function servers() {
  try {
    return execFileSync('pgrep', ['-f', 'fake-entire/entire brain viz']).toString().split('\n').filter(Boolean).length;
  } catch {
    // pgrep exits with 1 when nothing matches.
    return 0;
  }
}

async function until(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

suite('Entire brain', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let repo;
  let manifest;
  /** The addresses the extension asked to open. No browser opens in the tests. */
  const opened = [];
  /** Changes what the fake CLI replies from now on. */
  const reply = (changes) => fs.writeFileSync(fixture.scenarioFile, JSON.stringify({ ...fixture.scenario, ...changes }));
  const open = () => vscode.commands.executeCommand('entire.openBrainGraph');
  const stopped = () => (posix ? until(() => servers() === 0, 'the graph server to stop') : undefined);
  /** What the Brain view shows for the fixture repository. */
  const section = () => api.brainView.sections()[0];
  /** The brain's details as "label: value" lines. */
  const lines = () => section().details.map((detail) => `${detail.label}: ${detail.value}`);
  /** Everything a reader can click on the page as drawn: its command links. */
  const links = () =>
    [...api.brainView.html.matchAll(/<a [^>]*href="command:([A-Za-z.]+)(?:\?([^"]*))?"[^>]*>([^<]*)<\/a>/g)].map(
      ([, command, query, text]) => ({ label: text, command, ...(query ? { args: JSON.parse(decodeURIComponent(query)) } : {}) }),
    );
  const graphButton = { label: 'View Brain', command: 'entire.openBrainGraph', args: [fixture.root] };
  const stopButton = { label: 'Stop', command: 'entire.stopBrainGraph', args: [fixture.root] };
  /** Reads the brain again, as the Refresh button does, and waits for the view to say `state`. */
  const refreshed = async (state) => {
    const before = calls(STATUS).length;
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => calls(STATUS).length > before && api.brain.state() === state, `the Brain view to be ${state}`);
  };

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    assert.ok(extension, 'the extension is installed in the test host');
    manifest = extension.packageJSON.contributes;
    api = await extension.activate();
    await until(() => api.manager.viewState === 'ready', 'the first load');
    repo = api.manager.repoFor(fixture.root);
    assert.ok(repo, 'the fixture repository is open');
    api.brain.openUrl = async (url) => {
      opened.push(url);
    };
  });

  suiteTeardown(() => {
    api.brain.stop();
    reply({});
  });

  test('has a Brain section at the bottom that starts collapsed, and runs no brain command until it is opened', async () => {
    assert.equal(api.manager.viewState, 'ready');
    assert.deepEqual(api.manager.enabledRepos, [repo]);
    assert.deepEqual(manifest.views.entire.at(-1), {
      id: 'entire.brain',
      name: 'Brain',
      type: 'webview',
      when: "entire.viewState == 'ready'",
      visibility: 'collapsed',
    });
    // The section opens only when someone opens it. Until then nothing asks
    // the plugin about the brain. A person watching this window can open the
    // section before this suite runs, so the check is made when they have
    // not. states.test.cjs makes it in windows whose sidebar stays closed.
    if (api.brain.details(fixture.root) === undefined) {
      assert.equal(api.brainView.visible, false);
      assert.deepEqual(calls('brain'), []);
      assert.equal(api.brain.state(), 'loading');
      assert.equal(section().state, 'loading');
      // The page itself is not built until the section is opened.
      assert.equal(api.brainView.html, '');
    }
    assert.equal(api.brain.running(), false);
    assert.deepEqual(calls('brain viz'), []);
  });

  test('reads the brain when the section is opened, and starts no graph server for that', async () => {
    await vscode.commands.executeCommand('entire.brain.focus');
    await until(() => api.brainView.visible, 'the Brain view to show');
    await until(() => api.brain.state() === 'ready', 'the brain to be read');
    assert.ok(calls(STATUS).length >= 1);
    assert.deepEqual(calls('brain viz'), []);
    assert.equal(api.brain.running(), false);
    assert.equal(section().state, 'ready');
  });

  test('lists what the brain holds as text, under a button that opens its graph', async () => {
    const [state, ...rest] = lines();
    assert.match(state, /^Brain: Built · updated \S/);
    assert.deepEqual(rest, [
      'Code graph: 3 files · 1,204 symbols · 20 relations',
      'Memories: 8',
      'Conversations: 40 exchanges',
      'Docs: 5 records from 2 files',
      'Freshness: Degraded',
      'Updates: Not running',
      'Hosted brain: Connected · synced',
      'Warning: agents not wired: run entire brain setup so your agent uses this brain',
    ]);
    // What needs a look is marked, and says why on hover.
    const detail = (name) => section().details.find((entry) => entry.label === name);
    assert.equal(detail('Freshness').attention, true);
    assert.equal(detail('Freshness').tooltip, 'graph: the index is 2 commits behind HEAD');
    assert.equal(detail('Updates').attention, true);
    assert.equal(detail('Code graph').attention, undefined);

    // The page as drawn: the details are text, and the one thing to click is the button.
    const { html } = api.brainView;
    assert.deepEqual(links(), [graphButton]);
    assert.equal(html.match(/<a /g).length, 1);
    assert.equal(html.match(/<div class="row/g).length, 9);
    assert.match(html, /<dt>Code graph<\/dt><dd>3 files · 1,204 symbols · 20 relations<\/dd>/);
    assert.doesNotMatch(html, /<script|<button|tabindex|onclick/i);
  });

  test('checks that the repository has a brain, starts the graph page, and opens it', async () => {
    const before = calls('brain').length;
    const outcome = await open();
    assert.deepEqual(outcome, { kind: 'opened', url: fixture.brainUrl, started: true });
    assert.deepEqual(opened, [fixture.brainUrl]);
    // The plugin is asked not to open a browser itself, and to pick a free port.
    assert.deepEqual(calls('brain').slice(before), [STATUS, VIZ]);
    assert.equal(api.brain.running(fixture.root), true);
    assert.equal(api.brain.running(), true);
    assert.equal(api.brain.url(fixture.root), fixture.brainUrl);
    if (posix) assert.equal(servers(), 1);
  });

  test('says where the graph is running, and offers to stop it', async () => {
    assert.equal(section().running, '127.0.0.1:43117');
    assert.match(api.brainView.html, /The graph is running on 127\.0\.0\.1:43117\./);
    assert.deepEqual(links(), [graphButton, stopButton]);
  });

  test('opens the page of the running server again without starting another', async () => {
    const before = calls('brain').length;
    assert.equal(api.brain.needsStart(repo), false);
    // The button passes its repository, as a click on it does.
    const outcome = await vscode.commands.executeCommand('entire.openBrainGraph', ...graphButton.args);
    assert.deepEqual(outcome, { kind: 'opened', url: fixture.brainUrl, started: false });
    assert.deepEqual(opened, [fixture.brainUrl, fixture.brainUrl]);
    assert.equal(calls('brain').length, before);
    if (posix) assert.equal(servers(), 1);

    // A repository that is not open here opens nothing.
    assert.equal(await vscode.commands.executeCommand('entire.openBrainGraph', '/no/such/repository'), undefined);
    assert.equal(opened.length, 2);
  });

  test('starts another server when the branch has changed, and stops the one before', async () => {
    // The plugin reads the checked-out branch once, when it starts.
    const before = calls('brain').length;
    const branch = repo.branch;
    repo.branch = 'another-branch';
    try {
      assert.equal(api.brain.needsStart(repo), true);
      const outcome = await open();
      assert.deepEqual(outcome, { kind: 'opened', url: fixture.brainUrl, started: true });
      assert.deepEqual(calls('brain').slice(before), [STATUS, VIZ]);
      if (posix) await until(() => servers() === 1, 'the earlier server to stop');
    } finally {
      repo.branch = branch;
    }
  });

  test('stops the server from its button, and from the command', async () => {
    // The Stop button passes its repository.
    await vscode.commands.executeCommand('entire.stopBrainGraph', ...stopButton.args);
    assert.equal(api.brain.running(), false);
    assert.equal(api.brain.url(fixture.root), undefined);
    assert.equal(section().running, undefined);
    assert.deepEqual(links(), [graphButton]);
    await stopped();

    await open();
    assert.equal(api.brain.running(), true);
    await vscode.commands.executeCommand('entire.stopBrainGraph');
    assert.equal(api.brain.running(), false);
    await stopped();
  });

  test('starts one server for two requests made at once', async () => {
    const before = { calls: calls('brain').length, opened: opened.length };
    const outcomes = await Promise.all([api.brain.open(repo), api.brain.open(repo)]);
    assert.deepEqual(outcomes, [
      { kind: 'opened', url: fixture.brainUrl, started: true },
      { kind: 'opened', url: fixture.brainUrl, started: true },
    ]);
    assert.deepEqual(calls('brain').slice(before.calls), [STATUS, VIZ]);
    // The page opens once for the start that both requests share.
    assert.equal(opened.length, before.opened + 1);
    if (posix) assert.equal(servers(), 1);
  });

  test('forgets a server that stops by itself, and starts a new one the next time', async () => {
    if (!posix) return;
    execFileSync('pkill', ['-f', 'fake-entire/entire brain viz']);
    await until(() => !api.brain.running(), 'the extension to notice that the server is gone');
    assert.equal(section().running, undefined);
    const outcome = await open();
    assert.equal(outcome.kind, 'opened');
    assert.equal(outcome.started, true);
    await vscode.commands.executeCommand('entire.stopBrainGraph');
    await stopped();
  });

  test('reads the brain again on Refresh', async () => {
    const before = { status: calls(STATUS).length, viz: calls('brain viz').length };
    await refreshed('ready');
    assert.equal(calls(STATUS).length, before.status + 1);
    // A refresh reads the report. It does not start the graph.
    assert.equal(calls('brain viz').length, before.viz);
    assert.equal(api.brain.running(), false);
    assert.equal(lines().length, 9);
  });

  test('says what to run when the repository has no brain, and copies the command', async () => {
    reply({ [STATUS]: { stdout: JSON.stringify({ brain: { manifest_state: 'absent' } }) } });
    await refreshed('noBrain');
    assert.equal(section().state, 'noBrain');
    assert.deepEqual(lines(), []);
    assert.match(api.brainView.html, /This repository has no brain yet\. Run "entire brain setup" in a terminal/);
    // The extension hands over the command. It does not build a brain.
    assert.deepEqual(links(), [
      { label: 'Copy Command', command: 'entire.copyBrainSetupCommand' },
      { label: 'Retry', command: 'entire.refresh' },
    ]);
    // Asking for the graph starts nothing either.
    const before = { viz: calls('brain viz').length, opened: opened.length };
    assert.deepEqual(await open(), { kind: 'noBrain' });
    assert.equal(calls('brain viz').length, before.viz);
    assert.equal(opened.length, before.opened);
    assert.equal(api.brain.running(), false);
  });

  test('says so when the plugin is not installed, and starts nothing', async () => {
    reply({
      [STATUS]: { stderr: 'Error: Invalid usage: unknown command "brain status --json" for "entire"\n', exitCode: 1 },
      [VIZ]: { stderr: 'Error: Invalid usage: unknown command "brain viz --no-open --port 0" for "entire"\n', exitCode: 1 },
    });
    await refreshed('pluginMissing');
    assert.equal(section().state, 'pluginMissing');
    assert.match(api.brainView.html, /entire-brain plugin, which is not installed/);
    assert.deepEqual(links(), [
      { label: 'Copy Command', command: 'entire.copyBrainInstallCommand' },
      { label: 'Retry', command: 'entire.refresh' },
    ]);
    const before = { viz: calls('brain viz').length, opened: opened.length };
    assert.deepEqual(await open(), { kind: 'pluginMissing' });
    assert.equal(calls('brain viz').length, before.viz);
    assert.equal(opened.length, before.opened);
  });

  test('says so when the brain cannot be read, and still shows the graph on request', async () => {
    // An older plugin, say, whose status report this extension does not understand.
    reply({ [STATUS]: { stdout: 'no brain for this repo yet\n' } });
    await refreshed('failed');
    assert.equal(section().state, 'failed');
    assert.deepEqual(links(), [
      { label: 'Retry', command: 'entire.refresh' },
      { label: 'Show Log', command: 'entire.showLog' },
    ]);
    assert.equal(api.brain.details(fixture.root).failure.kind, 'unexpectedOutput');
    const outcome = await open();
    assert.deepEqual(outcome, { kind: 'opened', url: fixture.brainUrl, started: true });
    await vscode.commands.executeCommand('entire.stopBrainGraph');
    await stopped();
  });

  test('says so when the graph page cannot start', async () => {
    reply({ [VIZ]: { stderr: 'bind viz server: listen tcp 127.0.0.1:0: bind: operation not permitted\n', exitCode: 1 } });
    const before = opened.length;
    assert.deepEqual(await open(), { kind: 'failed', message: 'The Entire CLI could not start the brain graph.' });
    assert.equal(opened.length, before);
    assert.equal(api.brain.running(), false);
  });

  test('lists the brain again once it can be read', async () => {
    reply({});
    await refreshed('ready');
    assert.equal(section().state, 'ready');
    assert.equal(lines().length, 9);
    assert.deepEqual(links(), [graphButton]);
  });

  test('is a page with buttons, and not a list of rows that look clickable', () => {
    const { menus, viewsWelcome } = manifest;
    // The graph button and Refresh are on the section's title bar. Nothing is on the other sections.
    assert.deepEqual(
      menus['view/title'].filter((entry) => entry.command === 'entire.openBrainGraph'),
      [{ command: 'entire.openBrainGraph', when: 'view == entire.brain', group: 'navigation@0' }],
    );
    assert.match(menus['view/title'].find((entry) => entry.command === 'entire.refresh').when, /view == entire\.brain/);
    assert.equal(menus['viewContainer/title'], undefined);
    // The page draws its own buttons and its own reasons, so it has no row menus and no welcome text.
    assert.deepEqual(menus['view/item/context'].filter((entry) => /brain/i.test(entry.command)), []);
    assert.deepEqual(viewsWelcome.filter((entry) => entry.view === 'entire.brain'), []);
    assert.deepEqual(
      menus.commandPalette.filter((entry) => entry.command.endsWith('BrainGraph')),
      [
        { command: 'entire.openBrainGraph', when: "entire.viewState == 'ready'" },
        { command: 'entire.stopBrainGraph', when: 'entire.brainRunning' },
      ],
    );
    // The page runs no script, and the editor runs only these commands for it.
    assert.doesNotMatch(api.brainView.html, /<script/i);
    assert.match(api.brainView.html, /Content-Security-Policy" content="default-src 'none'; style-src 'nonce-/);
  });

  test('copies the command to run, and does not run it', async () => {
    const before = calls('').length;
    await vscode.commands.executeCommand('entire.copyBrainSetupCommand');
    assert.equal(await vscode.env.clipboard.readText(), 'entire brain setup');
    await vscode.commands.executeCommand('entire.copyBrainInstallCommand');
    assert.equal(await vscode.env.clipboard.readText(), 'entire plugin install brain');
    assert.equal(calls('').length, before);
    assert.deepEqual(calls('brain setup'), []);
    assert.deepEqual(calls('plugin'), []);
  });

  test('ships the icon of its button, for light and for dark themes', () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    const command = manifest.commands.find((entry) => entry.command === 'entire.openBrainGraph');
    // The editor's own icon set has no brain, so the extension brings one as two files.
    assert.deepEqual(Object.keys(command.icon).sort(), ['dark', 'light']);
    for (const file of [command.icon.light, command.icon.dark]) {
      const svg = fs.readFileSync(path.join(extension.extensionPath, file), 'utf8');
      assert.match(svg, /^<svg [^>]*viewBox="0 0 16 16"/);
      // Nothing in an icon may run or load: it is drawn from paths alone.
      assert.doesNotMatch(svg, /<script|href=|<image|<foreignObject|on[a-z]+=/i);
    }
  });

  // Keep this test last: a disposed service starts nothing more.
  test('stops its servers when the window closes', async () => {
    await open();
    assert.equal(api.brain.running(), true);
    api.brain.dispose();
    assert.equal(api.brain.running(), false);
    await stopped();
    assert.deepEqual(await api.brain.open(repo), { kind: 'cancelled' });
    await stopped();
  });
});
