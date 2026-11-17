// Runs inside a VS Code extension host, with `entire.loadOnScroll` at its
// default of on. See .vscode-test.mjs for the two fixture repositories.
//
// These tests scroll with `TreeView.reveal`, which brings a row into view the
// way scrolling does. They assume the test window shows fewer than 50 rows of
// a list at once, which holds for any window a test host opens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');

const fixture = JSON.parse(fs.readFileSync(process.env.ENTIRE_TEST_FIXTURE, 'utf8'));

async function until(check, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const count = (nodes, kind) => nodes.filter((node) => node.kind === kind).length;

suite('Entire loading on scroll', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let scrolling;
  let sparse;
  /** Every time the editor asked about a Load More row, which it does when it draws one. */
  const asks = [];
  const asksAbout = (repo, list) =>
    asks.filter((query) => query.includes(JSON.stringify(repo.root)) && query.includes(`"${list}"`)).length;

  const repoRow = async (tree, repo) => {
    const roots = await tree.getChildren();
    const node = roots.find((candidate) => candidate.kind === 'repo' && candidate.repo === repo);
    assert.ok(node, `${repo.name} has a row`);
    return node;
  };
  const rows = async (tree, repo) => tree.getChildren(await repoRow(tree, repo));
  const loadMoreRow = (nodes) => nodes.find((node) => node.kind === 'loadMore');
  /** Brings the Load More row of a list into view, as scrolling to the end of the list does. */
  const scrollToEnd = async (view, nodes) => {
    const row = loadMoreRow(nodes);
    assert.ok(row, 'the list has a Load More row');
    await view.reveal(row, { select: false, focus: false });
  };

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension('entire.entire-vscode').activate();
    await until(() => api.manager.viewState === 'ready', 'the first load');
    scrolling = api.manager.repoFor(fixture.scrollRoot);
    sparse = api.manager.repoFor(fixture.sparseRoot);
    assert.ok(scrolling && sparse, 'both fixture repositories are open');
    // Listen in on those requests, so a test can tell that a row is on screen
    // and a failure can say what the editor did.
    const provide = api.scrollLoader.provideFileDecoration.bind(api.scrollLoader);
    api.scrollLoader.provideFileDecoration = (uri) => {
      if (uri.scheme === 'entire-more') asks.push(uri.query);
      return provide(uri);
    };
    await until(() => scrolling.index?.allRows().length > 0, 'enrichment rows');
    await vscode.commands.executeCommand('entire.checkpoints.focus');
  });

  test('loads nothing while the end of the list is out of view', async () => {
    // Long enough for the tree to draw and for any decoration request to land.
    await pause(1500);
    const nodes = await rows(api.checkpointsTree, scrolling);
    assert.equal(count(nodes, 'commit'), 50);
    assert.equal(scrolling.limit('commits'), 50);
  });

  test('loads the next page when the Load More row scrolls into view', async () => {
    await scrollToEnd(api.checkpointsView, await rows(api.checkpointsTree, scrolling));
    await until(() => scrolling.limit('commits') === 100, 'the second page');
    let nodes = await rows(api.checkpointsTree, scrolling);
    assert.equal(count(nodes, 'commit'), 100);
    assert.equal(api.checkpointsTree.getTreeItem(loadMoreRow(nodes)).description, '100 of 120 shown');

    // The new Load More row sits 50 rows further down, out of view, so loading stops there.
    await pause(1000);
    assert.equal(scrolling.limit('commits'), 100);

    await scrollToEnd(api.checkpointsView, nodes);
    await until(() => scrolling.limit('commits') === 150, 'the last page');
    nodes = await rows(api.checkpointsTree, scrolling);
    assert.equal(count(nodes, 'commit'), 120);
    assert.equal(loadMoreRow(nodes), undefined, 'the row goes away once every commit is shown');
  });

  test('loads more of a nested list when its end scrolls into view', async () => {
    const other = (await rows(api.checkpointsTree, scrolling)).find((node) => node.kind === 'otherGroup');
    let children = await api.checkpointsTree.getChildren(other);
    assert.equal(count(children, 'checkpoint'), 50);
    // Revealing a row inside a collapsed group expands the group first.
    await scrollToEnd(api.checkpointsView, children);
    await until(() => scrolling.limit('other') === 100, 'the rest of the group');
    children = await api.checkpointsTree.getChildren(other);
    assert.equal(count(children, 'checkpoint'), 60);
    assert.equal(loadMoreRow(children), undefined);
  });

  test('stops scanning on scroll after a stretch of history with no checkpoints, until a click', async () => {
    const shown = async () => count(await rows(api.checkpointsTree, sparse), 'commit');
    assert.equal(sparse.index.scanned, 2000);
    assert.equal(await shown(), 50);

    // First arrival: 10 rows were already known, so the list grows to 60 and
    // one scan of 20,000 commits finds nothing more.
    await scrollToEnd(api.checkpointsView, await rows(api.checkpointsTree, sparse));
    await until(() => sparse.index.scanned === 22_000, 'the first scan');
    await until(async () => (await shown()) === 60, 'the known rows to appear');

    // Second arrival: another 20,000 commits, still nothing. Loading on scroll gives up.
    await scrollToEnd(api.checkpointsView, await rows(api.checkpointsTree, sparse));
    await until(() => sparse.autoLoadPaused.has('commits'), 'loading on scroll to pause');
    assert.equal(sparse.index.scanned, 42_000);
    assert.equal(sparse.index.exhausted, false);
    assert.equal(await shown(), 60);

    // The row is in view again and nothing happens.
    await scrollToEnd(api.checkpointsView, await rows(api.checkpointsTree, sparse));
    await pause(1000);
    assert.equal(sparse.index.scanned, 42_000);

    // A click reads on, to the end of history this time.
    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow(await rows(api.checkpointsTree, sparse)));
    assert.equal(sparse.autoLoadPaused.has('commits'), false);
    assert.equal(sparse.index.exhausted, true);
    assert.equal(sparse.index.scanned, 44_100);
    assert.equal(await shown(), 100);
    assert.equal(loadMoreRow(await rows(api.checkpointsTree, sparse)), undefined);
  });

  test('loads more sessions when the end of the list scrolls into view', async () => {
    await vscode.commands.executeCommand('entire.sessions.focus');
    await until(() => scrolling.sessionRows?.length === 70, 'the session list');
    const groups = await rows(api.sessionsTree, scrolling);
    const recent = groups.find((node) => node.group === 'recent');
    let sessions = await api.sessionsTree.getChildren(recent);
    assert.equal(count(sessions, 'session'), 50);

    await scrollToEnd(api.sessionsView, sessions);
    await until(() => scrolling.limit('sessions:recent') === 100, 'the rest of the sessions');
    sessions = await api.sessionsTree.getChildren(recent);
    assert.equal(count(sessions, 'session'), 72);
    assert.equal(loadMoreRow(sessions), undefined);
  });

  test('leaves loading to a click while the setting is off, and resumes when it is turned on', async () => {
    const settings = vscode.workspace.getConfiguration('entire');
    await settings.update('loadOnScroll', false, vscode.ConfigurationTarget.Global);
    try {
      const recent = (await rows(api.sessionsTree, sparse)).find((node) => node.group === 'recent');
      const sessions = await api.sessionsTree.getChildren(recent);
      assert.equal(count(sessions, 'session'), 50);
      await scrollToEnd(api.sessionsView, sessions);
      // The editor asks about the row when it draws it, setting or no setting.
      await until(() => asksAbout(sparse, 'sessions:recent') > 0, 'the Load More row to come into view');
      await pause(1000);
      assert.equal(sparse.limit('sessions:recent'), 50, 'nothing loads on scroll');

      // The Load More row is still on screen. Turning the setting on loads its page.
      const askedBefore = asksAbout(sparse, 'sessions:recent');
      await settings.update('loadOnScroll', true, vscode.ConfigurationTarget.Global);
      await until(() => sparse.limit('sessions:recent') === 100, 'loading to resume').catch((error) => {
        const askedAfter = asksAbout(sparse, 'sessions:recent') - askedBefore;
        throw new Error(
          `${error.message}. After the setting was turned on, the editor asked about the row ${askedAfter} times. ` +
            `Sessions view visible: ${api.sessionsView.visible}. Window focused: ${vscode.window.state.focused}.`,
        );
      });
      assert.equal(count(await api.sessionsTree.getChildren(recent), 'session'), 72);
    } finally {
      await settings.update('loadOnScroll', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
