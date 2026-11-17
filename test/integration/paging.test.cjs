// Runs inside a VS Code extension host. See .vscode-test.mjs for the two
// fixture repositories: one with more rows than a page in every list, and one
// whose history is longer than a scan window.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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

const text = (item) => (typeof item.label === 'string' ? item.label : item.label.label);
const count = (nodes, kind) => nodes.filter((node) => node.kind === kind).length;

suite('Entire paging', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let paging;
  let deep;

  /** The rows of one repository in a view. With two repositories, each gets a row of its own. */
  const rows = async (tree, repo) => {
    const roots = await tree.getChildren();
    const node = roots.find((candidate) => candidate.kind === 'repo' && candidate.repo === repo);
    assert.ok(node, `${repo.name} has a row`);
    return tree.getChildren(node);
  };
  const loadMoreRow = (nodes) => nodes.find((node) => node.kind === 'loadMore');
  const loadMore = async (tree, nodes) => {
    const row = loadMoreRow(nodes);
    assert.ok(row, 'the list has a Load More row');
    await vscode.commands.executeCommand('entire.loadMore', row);
    return row;
  };

  suiteSetup(async () => {
    api = await vscode.extensions.getExtension('entire.entire-vscode').activate();
    await until(() => api.manager.viewState === 'ready', 'the first load');
    paging = api.manager.repoFor(fixture.pagingRoot);
    deep = api.manager.repoFor(fixture.deepRoot);
    assert.ok(paging && deep, 'both fixture repositories are open');
    await until(() => paging.index?.allRows().length > 0 && deep.index?.allRows().length > 0, 'enrichment rows');
    // Watchers act only while an Entire view is visible.
    await vscode.commands.executeCommand('entire.checkpoints.focus');
  });

  test('gives a checkpoint with one session a row of its own and no row beneath it', async () => {
    const nodes = await rows(api.checkpointsTree, paging);
    // The CLI lists the three newest checkpoints, all from one session.
    const newest = api.checkpointsTree.getTreeItem(nodes[0]);
    assert.match(newest.description, /Claude Code · 3 of 3/);
    assert.equal(newest.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(newest.command.command, 'entire.openDetail');
    assert.match(newest.contextValue, /\bhasTranscript\b/);
    assert.match(api.checkpointsTree.getTreeItem(nodes[2]).description, /Claude Code · 1 of 3/);

    // An older commit has no CLI row. It still opens, and claims nothing about its session.
    const older = api.checkpointsTree.getTreeItem(nodes[10]);
    assert.equal(older.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.equal(older.command.command, 'entire.openDetail');
    assert.doesNotMatch(older.description, / of /);
    assert.doesNotMatch(older.contextValue, /\bhasTranscript\b/);
  });

  test('shows one page of commits and says how many there are', async () => {
    const nodes = await rows(api.checkpointsTree, paging);
    assert.equal(count(nodes, 'commit'), 50);
    assert.equal(nodes[0].commit.subject, 'Linked commit 119');
    assert.equal(nodes[49].commit.subject, 'Linked commit 70');

    const more = loadMoreRow(nodes);
    assert.deepEqual({ list: more.list, shown: more.shown, total: more.total }, { list: 'commits', shown: 50, total: 120 });
    const item = api.checkpointsTree.getTreeItem(more);
    assert.equal(text(item), 'Load More Checkpoints');
    assert.equal(item.description, '50 of 120 shown');
    assert.equal(item.command.command, 'entire.loadMore');
    // The group for checkpoints with no commit stays below the Load More row.
    assert.deepEqual(
      nodes.slice(50).map((node) => node.kind),
      ['loadMore', 'otherGroup'],
    );
  });

  test('adds a page per Load More, and keeps the longer list when HEAD moves', async () => {
    await loadMore(api.checkpointsTree, await rows(api.checkpointsTree, paging));
    let nodes = await rows(api.checkpointsTree, paging);
    assert.equal(count(nodes, 'commit'), 100);
    assert.equal(api.checkpointsTree.getTreeItem(loadMoreRow(nodes)).description, '100 of 120 shown');

    // A new commit rebuilds the index. The list must not fall back to one page.
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Newest commit\n\nEntire-Checkpoint: aaaaaaaaaaaa\n'], {
      cwd: fixture.pagingRoot,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Fixture Author',
        GIT_AUTHOR_EMAIL: 'fixture@example.com',
        GIT_COMMITTER_NAME: 'Fixture Author',
        GIT_COMMITTER_EMAIL: 'fixture@example.com',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_SYSTEM: '/dev/null',
      },
    });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.pagingRoot, encoding: 'utf8' }).trim();
    await until(() => paging.index?.tipSha === head, 'the index to follow HEAD');
    nodes = await rows(api.checkpointsTree, paging);
    assert.equal(count(nodes, 'commit'), 100);
    assert.equal(nodes[0].commit.subject, 'Newest commit');
    assert.equal(api.checkpointsTree.getTreeItem(loadMoreRow(nodes)).description, '100 of 121 shown');

    await loadMore(api.checkpointsTree, nodes);
    nodes = await rows(api.checkpointsTree, paging);
    assert.equal(count(nodes, 'commit'), 121);
    assert.equal(loadMoreRow(nodes), undefined, 'the row goes away once every commit is shown');
  });

  test('pages the checkpoints that no commit carries', async () => {
    const other = (await rows(api.checkpointsTree, paging)).find((node) => node.kind === 'otherGroup');
    let children = await api.checkpointsTree.getChildren(other);
    assert.equal(count(children, 'checkpoint'), 50);
    assert.equal(api.checkpointsTree.getTreeItem(loadMoreRow(children)).description, '50 of 60 shown');

    await loadMore(api.checkpointsTree, children);
    children = await api.checkpointsTree.getChildren(other);
    assert.equal(count(children, 'checkpoint'), 60);
    assert.equal(loadMoreRow(children), undefined);
  });

  test('scans further back in history only when a page needs it', async () => {
    // The first scan window holds 60 linked commits, which fills the first page.
    assert.equal(deep.index.scanned, 2000);
    assert.equal(deep.index.exhausted, false);
    assert.equal(deep.index.commits.length, 60);
    let nodes = await rows(api.checkpointsTree, deep);
    assert.equal(count(nodes, 'commit'), 50);
    // More history is unread, so the total is not known yet.
    assert.equal(api.checkpointsTree.getTreeItem(loadMoreRow(nodes)).description, '50 shown');

    // The second page needs 100 rows and only 60 are known: read the rest of history.
    await loadMore(api.checkpointsTree, nodes);
    assert.equal(deep.index.scanned, 2100);
    assert.equal(deep.index.exhausted, true);
    nodes = await rows(api.checkpointsTree, deep);
    assert.equal(count(nodes, 'commit'), 100);
    assert.equal(nodes[99].commit.subject, 'Deep commit 2039');
    assert.equal(loadMoreRow(nodes), undefined);
  });

  test('reads each stretch of history once when two loads overlap', async () => {
    const overlap = api.manager.repoFor(fixture.overlapRoot);
    assert.equal(overlap.index.scanned, 2000);
    const row = loadMoreRow(await rows(api.checkpointsTree, overlap));
    // Two loads at once, as a click during a scroll-triggered load would be.
    // Both need commits that only the next stretch of history holds.
    await Promise.all([
      vscode.commands.executeCommand('entire.loadMore', row),
      vscode.commands.executeCommand('entire.loadMore', row),
    ]);
    assert.equal(overlap.index.scanned, 2100, 'the second stretch was read once');
    assert.equal(overlap.index.commits.length, 100);
    assert.equal(new Set(overlap.index.commits.map((commit) => commit.sha)).size, 100, 'no commit is listed twice');
    assert.equal(count(await rows(api.checkpointsTree, overlap), 'commit'), 100);
  });

  test('brings a row beyond the end of its list onto it, so that it can be selected', async () => {
    // The commits are "Linked commit 119" down to 0, newest first, each with a checkpoint named by its number.
    const at = Math.min(paging.limit('commits') + 10, 119);
    const checkpointId = (119 - at).toString(16).padStart(12, '0');
    const row = await api.checkpointsTree.find({ repoRoot: paging.root, mode: 'checkpoint', checkpointId });
    assert.equal(row?.kind, 'commit');
    assert.equal(row.commit.subject, `Linked commit ${119 - at}`);
    assert.ok(paging.limit('commits') > at, 'the list grew to hold the row');
    assert.ok((await rows(api.checkpointsTree, paging)).includes(row), 'the row is one the view lists');
    await api.checkpointsView.reveal(row, { select: true, focus: false });
    await until(() => api.checkpointsView.selection[0] === row, 'the row to be selected');

    // A checkpoint that no row stands for is not found, and nothing is read to look for it.
    assert.equal(
      await api.checkpointsTree.find({ repoRoot: paging.root, mode: 'checkpoint', checkpointId: 'ffffffffffff' }),
      undefined,
    );
  });

  test('pages sessions, and the checkpoints of a session', async () => {
    await vscode.commands.executeCommand('entire.sessions.focus');
    await until(() => paging.sessionRows?.length === 70, 'the session list');

    const groups = await rows(api.sessionsTree, paging);
    assert.deepEqual(
      groups.map((node) => node.group),
      ['active', 'recent'],
    );
    let recent = await api.sessionsTree.getChildren(groups[1]);
    assert.equal(count(recent, 'session'), 50);
    assert.equal(recent[0].session.sessionId, 'local-0', 'the most recently active session comes first');
    const more = loadMoreRow(recent);
    // 70 local sessions, plus the two that only checkpoints mention.
    assert.equal(text(api.sessionsTree.getTreeItem(more)), 'Load More Sessions');
    // A session row says how many checkpoints it produced.
    assert.match(api.sessionsTree.getTreeItem(recent[0]).description, /^Claude Code · /);
    assert.equal(api.sessionsTree.getTreeItem(more).description, '50 of 72 shown');

    await loadMore(api.sessionsTree, recent);
    recent = await api.sessionsTree.getChildren(groups[1]);
    assert.equal(count(recent, 'session'), 72);
    assert.equal(loadMoreRow(recent), undefined);

    // One session produced 60 checkpoints. Its children page the same way.
    const imported = recent.find((node) => node.session.sessionId === 'imported-session');
    assert.match(api.sessionsTree.getTreeItem(imported).description, /60 checkpoints/);
    let checkpoints = await api.sessionsTree.getChildren(imported);
    // Under a session, each checkpoint says where it sits in that session. The newest comes first.
    assert.match(api.sessionsTree.getTreeItem(checkpoints[0]).description, /^60 of 60/);
    assert.match(api.sessionsTree.getTreeItem(checkpoints[1]).description, /^59 of 60/);
    assert.equal(count(checkpoints, 'checkpoint'), 50);
    assert.equal(api.sessionsTree.getTreeItem(loadMoreRow(checkpoints)).description, '50 of 60 shown');
    await loadMore(api.sessionsTree, checkpoints);
    checkpoints = await api.sessionsTree.getChildren(imported);
    assert.equal(count(checkpoints, 'checkpoint'), 60);
    assert.equal(loadMoreRow(checkpoints), undefined);

    // Extending one list leaves the others alone.
    const otherRepoGroups = await rows(api.sessionsTree, deep);
    const otherRecent = await api.sessionsTree.getChildren(otherRepoGroups[1]);
    assert.equal(count(otherRecent, 'session'), 50);
  });
});
