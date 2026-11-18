// Runs once per launch configured in .vscode-test.mjs, each with a different
// workspace, CLI, or CLI reply. ENTIRE_TEST_EXPECT says where the views should settle.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const expected = JSON.parse(process.env.ENTIRE_TEST_EXPECT);

suite(`Entire view state: ${expected.state}`, () => {
  test('settles in the expected state', async () => {
    const api = await vscode.extensions.getExtension('entire.entire').activate();
    const deadline = Date.now() + 30_000;
    while (api.manager.viewState === 'loading' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(api.manager.viewState, expected.state);

    // Trails are listed for repositories that Entire hosts, whether or not
    // Entire is enabled in the clone. Nothing reads them from entire.io until
    // the Trails view is shown, and these launches never open the sidebar.
    assert.equal(api.manager.trailRepos.length, expected.trailRepos ?? 0);
    for (const repo of api.manager.repos) assert.equal(repo.trails, undefined);
    // The same goes for Entire's list of sessions, which names them: nothing
    // reads it until the Sessions view is shown.
    for (const repo of api.manager.repos) assert.equal(repo.remoteSessions, undefined);
    assert.deepEqual(api.trailsTree.getChildren().filter((node) => node.kind !== 'repo'), []);

    // The brain's report comes from a plugin that may not be installed.
    // Nothing asks for it until the Brain view, which starts collapsed, is
    // opened, or the graph is asked for. Until then its page is not built.
    assert.equal(api.brainView.visible, false);
    assert.equal(api.brainView.html, '');
    for (const repo of api.manager.repos) assert.equal(api.brain.details(repo.root), undefined);
    assert.equal(api.brain.running(), false);
    assert.equal(api.brain.state(), api.manager.enabledRepos.length === 1 ? 'loading' : 'ready');
    // The view has a section for each repository with Entire enabled, and none in any other state.
    assert.deepEqual(
      api.brainView.sections().map((section) => [section.root, section.state, section.details.length]),
      api.manager.viewState === 'ready' ? api.manager.enabledRepos.map((repo) => [repo.root, 'loading', 0]) : [],
    );

    // The Setup view shows itself while Entire needs a step, and reads nothing
    // until it is on screen: the login check asks entire.io, and the plugin
    // checks run plugins that may not be installed.
    assert.equal(api.setup.showSetup, ['cliMissing', 'cliTooOld', 'notEnabled'].includes(expected.state));
    assert.equal(api.setup.pinned, false);
    assert.equal(api.setupView.visible, false);
    assert.equal(api.setupView.html, '');
    assert.equal(api.setup.machineFacts().login, undefined);
    assert.equal(api.setup.machineFacts().graphPlugin, undefined);

    const checkpoints = await api.checkpointsTree.getChildren();
    const sessions = await api.sessionsTree.getChildren();
    if (expected.state !== 'ready') {
      // An empty tree is what lets the welcome text for the state show.
      assert.deepEqual(checkpoints, []);
      assert.deepEqual(sessions, []);
      return;
    }

    if (expected.repos > 1) {
      // With several repositories, each view groups its rows under the repository.
      assert.deepEqual(
        checkpoints.map((node) => node.kind),
        Array(expected.repos).fill('repo'),
      );
      for (const repoNode of checkpoints) {
        const rows = await api.checkpointsTree.getChildren(repoNode);
        assert.ok(rows.some((node) => node.kind === 'commit'), `${repoNode.repo.name} lists its commits`);
      }
      assert.equal(new Set(checkpoints.map((node) => node.repo.root)).size, expected.repos);
      // The Brain view has a section for each repository too.
      assert.equal(api.brainView.sections().length, expected.repos);
    }
  });
});
