// Runs inside a VS Code extension host, in the same window as extension.test.cjs.
// See .vscode-test.mjs for the fixture repository, whose origin uses the
// entire:// scheme, and for what the fake Entire CLI replies to trail calls.
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

function label(item) {
  return typeof item.label === 'string' ? item.label : item.label.label;
}

suite('Entire trails', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let repo;

  const rows = () => api.trailsTree.getChildren();
  const trailRows = () => rows().filter((node) => node.kind === 'trail');
  const loadMoreRow = () => rows().find((node) => node.kind === 'loadMore');
  const numbers = () => trailRows().map((node) => node.trail.number);
  const rowOf = (number) => trailRows().find((node) => node.trail.number === number);
  /** True once nothing about the view is still being read. A trail is drawn in stages. */
  const settled = (view) => !view.partial && !view.timelinePending && !view.refreshing;
  /**
   * Waits for a trail panel to show a trail that passes `check`, and returns a
   * copy of what it shows then. Unless `stage` is set, it waits for the whole
   * trail: the host fills in the view it hands out as the reads come back.
   */
  const viewOf = (controller, check, what, { stage = false } = {}) =>
    until(() => {
      const snapshot = controller?.snapshot();
      if (!snapshot || !('view' in snapshot) || !(stage || settled(snapshot.view)) || !check(snapshot)) return undefined;
      return JSON.parse(JSON.stringify(snapshot));
    }, what);
  const panelOn = (check, what, options) => viewOf(api.panels.currentTrail, check, what, options);
  const showOf = (number) => `trail show ${fixture.trailIds[number]} --project gh/acme --json`;
  const timelineOf = (of) => `trail timeline ${of} --project gh/acme --limit 50 --json`;
  /** The fake CLI's usual reply to a call, changed. */
  const changed = (call, changes) => ({ [call]: { ...fixture.scenario[call], ...changes } });
  const timelineTexts = (view) => view.timeline.events.map((event) => event.text);
  /** Changes what the fake CLI replies from now on. */
  const reply = (changes) => fs.writeFileSync(fixture.scenarioFile, JSON.stringify({ ...fixture.scenario, ...changes }));

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    assert.ok(extension, 'the extension is installed in the test host');
    api = await extension.activate();
    await until(() => api.manager.viewState === 'ready', 'the first load');
    repo = api.manager.repoFor(fixture.root);
    assert.ok(repo, 'the fixture repository is open');
  });

  suiteTeardown(() => reply({}));

  test('offers trails for a repository whose origin uses entire://', () => {
    assert.deepEqual(repo.entireRepo, { forge: 'gh', owner: 'acme', repo: 'widget' });
    assert.deepEqual(api.manager.trailRepos, [repo]);
  });

  test('reads the first page of open trails when the Trails view is shown', async () => {
    // The suite before this one may have opened the Entire sidebar already,
    // which shows this view. states.test.cjs checks that nothing is read
    // while the sidebar stays closed.
    if (!api.trailsView.visible) {
      assert.equal(repo.trails, undefined);
      assert.deepEqual(calls('trail '), []);
    }
    await vscode.commands.executeCommand('entire.trails.focus');
    await until(() => repo.trails && !repo.trails.loading, 'the first page of trails');
    assert.equal(api.manager.trailsState(), 'ready');
    // Only the first page has been asked for, with the project and repository
    // from the origin remote. No later page, and no single trail.
    assert.deepEqual([...new Set(calls('trail '))], [fixture.trailListOpen]);
  });

  test('lists open trails a page at a time, most recent activity first', () => {
    const trails = trailRows();
    assert.equal(trails.length, 50);
    assert.deepEqual(
      trails.slice(0, 3).map((node) => node.trail.number),
      [120, 119, 118],
    );
    const more = loadMoreRow();
    assert.ok(more, 'there is more to load');
    assert.equal(more.noun, 'Trails');
    assert.equal(more.shown, 50);
    // The CLI says how many there are in all, so the row can too.
    assert.equal(more.total, 120);
    const item = api.trailsTree.getTreeItem(more);
    assert.equal(label(item), 'Load More Trails');
    assert.equal(item.description, '50 of 120 shown');
    assert.equal(api.trailsView.description, 'Open');
  });

  test('describes a trail by its number, phase, and branch in this repository', () => {
    const [first, second] = trailRows();
    const item = api.trailsTree.getTreeItem(first);
    assert.equal(label(item), 'Trail 120');
    assert.match(item.description, /^#120 · building · main \(checked out\) · /);
    assert.equal(item.command.command, 'entire.openDetail');
    assert.match(item.contextValue, /^trail\b/);
    assert.match(item.contextValue, /\bweb\b/);
    assert.match(item.contextValue, /\bopenable\b/);
    assert.equal(item.tooltip, undefined, 'the tooltip is built on hover');
    const hovered = api.trailsTree.resolveTreeItem(item, first);
    assert.match(hovered.tooltip.value, /Trail 120/);
    assert.match(hovered.tooltip.value, /checked out here/);

    const other = api.trailsTree.getTreeItem(second);
    assert.match(other.description, /^#119 · building · feature\/119 · /);
    assert.doesNotMatch(other.description, /checked out/);
  });

  test('loads the next page with the token the CLI returned', async () => {
    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow());
    assert.equal(trailRows().length, 100);
    assert.equal(calls('trail list').at(-1), `${fixture.trailListOpen} --page-token=page-2`);
    assert.equal(api.trailsTree.getTreeItem(loadMoreRow()).description, '100 of 120 shown');

    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow());
    assert.equal(trailRows().length, 120);
    assert.equal(calls('trail list').at(-1), `${fixture.trailListOpen} --page-token=page-3`);
    assert.equal(loadMoreRow(), undefined, 'nothing is left to load');
    assert.equal(new Set(trailRows().map((node) => node.trail.number)).size, 120);
  });

  test('shows only the trails of the chosen status', async () => {
    await vscode.commands.executeCommand('entire.filterTrails', 'closed');
    assert.deepEqual(api.manager.trailFilter, { status: 'closed' });
    assert.equal(repo.trails.status, 'closed');
    assert.deepEqual(numbers(), [9002, 9001]);
    assert.equal(loadMoreRow(), undefined);
    assert.match(api.trailsTree.getTreeItem(trailRows()[0]).description, /^#9002 · closed · /);
    assert.equal(api.trailsView.description, 'Closed');

    // With no status, the CLI lists open and closed trails together.
    await vscode.commands.executeCommand('entire.filterTrails', 'all');
    assert.equal(calls('trail list').at(-1), fixture.trailListAll);
    assert.deepEqual(numbers(), [9002, 120, 119, 118, 117, 9001]);
    assert.deepEqual(
      trailRows().map((node) => node.trail.status),
      ['closed', 'open', 'open', 'open', 'open', 'closed'],
    );
    assert.equal(api.trailsView.description, 'All');

    await vscode.commands.executeCommand('entire.filterTrails', 'open');
    assert.equal(repo.trails.status, 'open');
    // The list starts over at one page.
    assert.equal(trailRows().length, 50);
    assert.equal(loadMoreRow().shown, 50);
    assert.equal(api.trailsView.description, 'Open');
  });

  test('ignores a filter it does not know', async () => {
    for (const key of ['merged', 'closed:planning', 'open:', 'open:Bad Phase', 'open:a:b']) {
      // A key that is not a filter falls through to the picker, which is closed here unanswered.
      const asked = vscode.commands.executeCommand('entire.filterTrails', key);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await asked;
      assert.deepEqual(api.manager.trailFilter, { status: 'open' }, `"${key}" changes nothing`);
    }
  });

  test('shows only the open trails in one phase, reading further pages to find them', async () => {
    const before = calls('trail list').length;
    await vscode.commands.executeCommand('entire.filterTrails', 'open:planning');
    assert.deepEqual(api.manager.trailFilter, { status: 'open', phase: 'planning' });
    // The CLI cannot list by phase. The open trails already read are kept,
    // and the pages after them are read to find more that are planning.
    assert.deepEqual(calls('trail list').slice(before), [
      `${fixture.trailListOpen} --page-token=page-2`,
      `${fixture.trailListOpen} --page-token=page-3`,
    ]);
    assert.deepEqual(numbers(), [117, 107, 97, 87, 77, 67, 57, 47, 37, 27, 17, 7]);
    assert.ok(trailRows().every((node) => node.trail.phase === 'planning'));
    assert.equal(loadMoreRow(), undefined, 'every open trail has been read');
    assert.equal(api.trailsView.description, 'Planning');
    // A trail in the planning phase has no branch to show.
    assert.match(api.trailsTree.getTreeItem(trailRows()[0]).description, /^#117 · planning · [^·]*$/);

    // Every open trail is in hand now, so another phase needs no call.
    const read = calls('trail list').length;
    await vscode.commands.executeCommand('entire.filterTrails', 'open:complete');
    assert.equal(trailRows().length, 30);
    assert.deepEqual(numbers().slice(0, 3), [118, 114, 110]);
    assert.ok(trailRows().every((node) => node.trail.phase === 'complete'));
    assert.equal(api.trailsView.description, 'Complete');

    // A phase with more trails than a page shows them a page at a time.
    await vscode.commands.executeCommand('entire.filterTrails', 'open:building');
    assert.equal(trailRows().length, 50);
    assert.equal(api.trailsTree.getTreeItem(loadMoreRow()).description, '50 of 78 shown');
    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow());
    assert.equal(trailRows().length, 78);
    assert.ok(trailRows().every((node) => node.trail.phase === 'building'));
    assert.equal(loadMoreRow(), undefined);

    await vscode.commands.executeCommand('entire.filterTrails', 'open');
    assert.equal(trailRows().length, 50);
    assert.equal(api.trailsTree.getTreeItem(loadMoreRow()).description, '50 of 120 shown');
    assert.equal(calls('trail list').length, read, 'no phase needed another call');
  });

  test('says how far it has read when a phase filter has not reached the last page', async () => {
    const lastPage = `${fixture.trailListOpen} --page-token=page-3`;
    reply({ [lastPage]: { stderr: 'dial tcp: connection refused\n', exitCode: 1 } });
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => repo.trails.trails.length === 50 && repo.trails.nextPageToken === 'page-2', 'a fresh first page');

    await vscode.commands.executeCommand('entire.filterTrails', 'open:planning');
    // The second page was read and the third could not be.
    assert.deepEqual(numbers(), [117, 107, 97, 87, 77, 67, 57, 47, 37, 27]);
    // The row cannot say how many planning trails are left, only how many trails it has looked at.
    assert.equal(api.trailsTree.getTreeItem(loadMoreRow()).description, '10 shown · 100 of 120 read');

    // A click tries again. While the page keeps failing, the rows stay.
    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow());
    assert.equal(trailRows().length, 10);
    assert.ok(loadMoreRow(), 'the Load More row is still there to click');

    reply({});
    await vscode.commands.executeCommand('entire.loadMore', loadMoreRow());
    assert.deepEqual(numbers().slice(-2), [17, 7]);
    assert.equal(trailRows().length, 12);
    assert.equal(loadMoreRow(), undefined);

    await vscode.commands.executeCommand('entire.filterTrails', 'open');
    assert.equal(trailRows().length, 50);
  });

  test('offers every status and phase in a picker that opens on the filter in use', async () => {
    const asked = vscode.commands.executeCommand('entire.filterTrails');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // The picker lists All, Open, and Closed, then the phases. It opens on
    // Open, which is in use, so one step down is Closed.
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await asked;
    assert.deepEqual(api.manager.trailFilter, { status: 'closed' });
    assert.deepEqual(numbers(), [9002, 9001]);

    // Closing the picker without choosing changes nothing.
    const dismissed = vscode.commands.executeCommand('entire.filterTrails');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await dismissed;
    assert.deepEqual(api.manager.trailFilter, { status: 'closed' });

    await vscode.commands.executeCommand('entire.filterTrails', 'open');
    assert.equal(trailRows().length, 50);
  });

  test('loads the next page when the Load More row is drawn', async () => {
    const more = loadMoreRow();
    const uri = api.trailsTree.getTreeItem(more).resourceUri;
    assert.equal(uri.scheme, 'entire-more');
    // The editor asks for the decoration of a row when it draws it.
    api.scrollLoader.provideFileDecoration(uri);
    await until(() => trailRows().length === 100, 'the second page to load');
    // A second request for the same row belongs to a page that has already grown.
    api.scrollLoader.provideFileDecoration(uri);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(trailRows().length, 100);
  });

  test('opens a trail with its changes, merge gates, and CI runs', async () => {
    const before = calls('trail show').length;
    await vscode.commands.executeCommand('entire.openDetail', trailRows()[0]);
    const { view, target } = await panelOn((snapshot) => snapshot.view.number === 120, 'the trail panel to load');
    // The row gave the trail's ID, and the trail is asked for by it.
    assert.deepEqual(target, { repoRoot: fixture.root, mode: 'trail', trail: 120, id: fixture.trailIds[120] });
    assert.equal(calls('trail show').length, before + 1);
    assert.equal(calls('trail show').at(-1), showOf(120));
    // The timeline was asked for alongside the trail, by the trail's ID. This
    // trail turned out to have two open changes, between which the CLI does
    // not pick, so the change to show was then asked for by name.
    assert.deepEqual(calls('trail timeline'), [timelineOf(fixture.trailIds[120]), timelineOf('widget/1120')]);

    assert.equal(view.title, 'Rework the parser');
    assert.equal(view.phase, 'building');
    assert.equal(view.priority, 'high');
    assert.equal(view.project, 'acme');
    assert.deepEqual(view.assignees, ['fixture-author']);
    assert.match(view.body, /\*\*parser\*\*/);
    assert.equal(view.canOpenOnWeb, true);
    assert.equal(api.panels.currentTrail.panel.title, '#120 Rework the parser');

    // The change on the checked-out branch is the one shown.
    assert.equal(view.changes.length, 2);
    assert.equal(view.selected, 0);
    const [widget, docs] = view.changes;
    assert.equal(widget.repository, 'widget');
    assert.equal(widget.number, 1120);
    assert.equal(widget.branch, 'main');
    assert.equal(widget.base, 'stable');
    assert.equal(widget.checkedOut, true);
    assert.equal(docs.checkedOut, false);
    assert.equal(docs.hasCodeChanges, false);

    assert.equal(widget.merge.mergeable, false);
    assert.equal(widget.merge.conflict, undefined);
    assert.deepEqual(
      widget.merge.gates.map((gate) => [gate.label, gate.outcome, gate.blocking]),
      [
        ['Approvals', 'failed', true],
        ['Checks', 'failed', true],
        ['Findings', 'passed', true],
        ['Up to date with base', 'skipped', false],
      ],
    );
    assert.equal(widget.merge.gates[0].rationale, '0 of 1 required approvals.');
    assert.deepEqual(
      widget.merge.checks.map((check) => [check.name, check.outcome, check.detail, check.hasLink]),
      [
        ['build', 'passed', 'success', true],
        ['lint', 'failed', 'failure', true],
        ['deploy', 'pending', 'in progress', false],
      ],
    );
    assert.equal(widget.merge.checkSummary, '1 failed, 1 pending, 1 passed');
    // The other change has no runs, and the panel says why.
    assert.match(docs.merge.checksNote, /could not read the CI runs/);

    // The page exists and ran its script.
    await until(() => api.panels.currentTrail?.webviewReady, 'the trail page to run its script');
  });

  test('matches timeline commits to this clone and counts their checkpoints', async () => {
    const { view } = await panelOn((snapshot) => snapshot.view.number === 120, 'the trail panel');
    const { timeline } = view;
    assert.equal(timeline.hasMore, true);
    assert.deepEqual(
      timeline.events.map((event) => [event.kind, event.text, event.actor]),
      [
        ['review_posted', 'Posted a review with 2 findings', 'Review Agent'],
        ['commit', 'Add the parser', 'Fixture Author'],
        ['commit', 'Tune the lexer', 'Fixture Author'],
      ],
    );
    const [, parser, remote] = timeline.events;
    // This commit is in the fixture repository, and git says it carries one checkpoint.
    assert.equal(parser.commit.local, true);
    assert.equal(parser.commit.checkpoints, 1);
    assert.equal(parser.commit.shortSha, fixture.parserCommit.slice(0, parser.commit.shortSha.length));
    assert.deepEqual(parser.commit.agents, ['Claude Code']);
    assert.equal(parser.commit.additions, 12);
    // This one was never fetched, so only what entire.io says about it is known.
    assert.equal(remote.commit.local, false);
    assert.equal(remote.commit.checkpoints, 0);
    assert.equal(remote.commit.remoteCheckpoints, 2);
  });

  test('loads more of the timeline on request', async () => {
    const controller = api.panels.currentTrail;
    await controller.receive({ type: 'loadMoreTimeline' });
    const { view } = controller.snapshot();
    assert.equal(view.timeline.hasMore, false);
    assert.equal(view.timeline.events.length, 5);
    const squash = view.timeline.events[3];
    assert.equal(squash.text, 'Squash the review fixes');
    assert.equal(squash.commit.checkpoints, 2);
    assert.equal(view.timeline.events[4].text, 'Created the trail');
    assert.equal(calls('trail timeline').at(-1), 'trail timeline widget/1120 --project gh/acme --limit 50 --json --page-token=timeline-2');

    // With nothing left, another request reads nothing.
    const before = calls('trail timeline').length;
    await controller.receive({ type: 'loadMoreTimeline' });
    assert.equal(calls('trail timeline').length, before);
  });

  test('opens the checkpoint of a timeline commit beside the trail', async () => {
    const controller = api.panels.currentTrail;
    const loadedOn = (checkpointId) =>
      until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === checkpointId ? snapshot : undefined;
      }, `the detail panel to load ${checkpointId}`);

    await controller.receive({ type: 'openCheckpoint', event: 1, checkpoint: 0 });
    const parser = await loadedOn(fixture.ids.refs);
    assert.equal(parser.header.commit.sha, fixture.parserCommit);

    // A commit with two checkpoints offers each one.
    await controller.receive({ type: 'openCheckpoint', event: 3, checkpoint: 0 });
    const squash = await loadedOn(fixture.ids.legacy);
    assert.equal(squash.header.commit.sha, fixture.squashCommit);

    // A commit that is not in this clone, and positions that do not exist, open nothing.
    await controller.receive({ type: 'openCheckpoint', event: 2, checkpoint: 0 });
    await controller.receive({ type: 'openCheckpoint', event: 1, checkpoint: 5 });
    await controller.receive({ type: 'openCheckpoint', event: 99, checkpoint: 0 });
    assert.equal(api.panels.current.snapshot().header.checkpointId, fixture.ids.legacy);

    // The trail keeps its own tab.
    assert.equal(api.panels.currentTrail, controller);
    assert.equal(controller.snapshot().view.number, 120);
  });

  test('switches to another change without reading the trail again', async () => {
    const controller = api.panels.currentTrail;
    const shows = calls('trail show').length;
    await controller.receive({ type: 'selectChange', position: 1 });
    const { view } = await panelOn((snapshot) => snapshot.view.selected === 1, 'the other change to load');
    assert.equal(calls('trail show').length, shows);
    assert.equal(calls('trail timeline').at(-1), timelineOf('docs/9'));
    assert.match(view.timeline.notice, /whole history/);
    // The change belongs to another repository. A commit there is not looked
    // up here, even when a commit here has the same SHA.
    const [commit] = view.timeline.events;
    assert.equal(commit.commit.local, false);
    assert.equal(commit.commit.checkpoints, 0);

    // A position past the last change is ignored.
    await controller.receive({ type: 'selectChange', position: 7 });
    assert.equal(controller.snapshot().view.selected, 1);
  });

  test('takes the address of a trail from the CLI', async () => {
    assert.equal(await api.manager.trailUrl(repo, 120), fixture.trailUrl);
    // The panel already read this trail, so the address is known without another call.
    const shows = calls('trail show').length;
    assert.equal(await api.manager.trailUrl(repo, 120), fixture.trailUrl);
    assert.equal(calls('trail show').length, shows);
  });

  test('draws a trail in stages: its row, then the trail, then the timeline', async () => {
    // The CLI's row for a trail in the complete phase names no change.
    const row = rowOf(118);
    assert.deepEqual(row.trail.changes, []);
    const id = fixture.trailIds[118];
    // Like the real CLI, the fake one takes a while, and longer for the timeline.
    reply({ ...changed(showOf(118), { delayMs: 800 }), ...changed(timelineOf(id), { delayMs: 2000 }) });
    const shows = calls('trail show').length;
    const timelines = calls('trail timeline').length;
    await vscode.commands.executeCommand('entire.openDetail', row);

    // At once: what the row says, and nothing it does not.
    const first = await panelOn((snapshot) => snapshot.view.number === 118, 'the top of the page', { stage: true });
    assert.equal(first.view.partial, true);
    assert.equal(first.view.title, 'Trail 118');
    assert.equal(first.view.phase, 'complete');
    assert.deepEqual(first.view.changes, []);
    assert.equal(first.view.canOpenOnWeb, false);
    assert.equal(first.view.timeline, undefined);
    assert.equal(api.panels.currentTrail.panel.title, '#118 Trail 118');

    // Then the trail, while its timeline is still on the way.
    const second = await panelOn((snapshot) => snapshot.view.number === 118 && !snapshot.view.partial, 'the trail', {
      stage: true,
    });
    assert.equal(second.view.timelinePending, true);
    assert.equal(second.view.timeline, undefined);
    assert.equal(second.view.canOpenOnWeb, true);
    assert.deepEqual(
      second.view.changes.map((change) => [change.repository, change.number, change.status]),
      [['widget', 1118, 'merged']],
    );

    // Then the timeline.
    const third = await panelOn((snapshot) => snapshot.view.number === 118, 'the timeline');
    assert.deepEqual(timelineTexts(third.view), ['Finish trail 118', 'Start trail 118']);
    assert.equal(third.view.timeline.hasMore, true);
    assert.equal(third.view.refreshing, undefined);

    // The two were read side by side, once each. The timeline call named the
    // trail, since no change was known, and the trail has one change, so the
    // answer was for that change and nothing was read again.
    assert.deepEqual(calls('trail show').slice(shows), [showOf(118)]);
    assert.deepEqual(calls('trail timeline').slice(timelines), [timelineOf(id)]);
    reply({});
  });

  test('asks for a later page of a timeline the way the first one was asked for', async () => {
    const controller = api.panels.currentTrail;
    await controller.receive({ type: 'loadMoreTimeline' });
    const { view } = controller.snapshot();
    assert.deepEqual(timelineTexts(view), ['Finish trail 118', 'Start trail 118', 'Plan trail 118']);
    assert.equal(view.timeline.hasMore, false);
    assert.equal(calls('trail timeline').at(-1), `${timelineOf(fixture.trailIds[118])} --page-token=timeline-118-2`);
  });

  test('does not take the change the CLI picked for the one the panel shows', async () => {
    // This trail has a merged change and an open one. The CLI reads the open
    // one when asked for the trail's timeline. The panel shows the first.
    const timelines = calls('trail timeline').length;
    await vscode.commands.executeCommand('entire.openDetail', rowOf(114));
    const { view } = await panelOn((snapshot) => snapshot.view.number === 114, 'the trail with two changes');
    assert.equal(view.changes[view.selected].number, 1114);
    assert.deepEqual(timelineTexts(view), ['On the merged change of trail 114']);
    assert.deepEqual(calls('trail timeline').slice(timelines), [
      timelineOf(fixture.trailIds[114]),
      timelineOf('widget/1114'),
    ]);
  });

  test('asks for the change by name when the CLI will not pick one for the trail', async () => {
    const timelines = calls('trail timeline').length;
    await vscode.commands.executeCommand('entire.openDetail', rowOf(110));
    const { view } = await panelOn((snapshot) => snapshot.view.number === 110, 'the trail the CLI will not pick for');
    assert.deepEqual(timelineTexts(view), ['Finish trail 110']);
    assert.equal(view.timeline.notice, undefined);
    assert.deepEqual(calls('trail timeline').slice(timelines), [
      timelineOf(fixture.trailIds[110]),
      timelineOf('widget/1110'),
    ]);
  });

  test('does not wait for the CLI to refuse a change whose branch is gone', async () => {
    // The CLI picks a change by its branch. This trail's only change was
    // closed and has none, and the fake CLI takes four seconds to say so.
    const timelines = calls('trail timeline').length;
    const started = Date.now();
    await vscode.commands.executeCommand('entire.openDetail', rowOf(106));
    const { view } = await panelOn((snapshot) => snapshot.view.number === 106, 'the trail with a closed change');
    assert.ok(Date.now() - started < 3000, 'the timeline came before the refusal');
    assert.equal(view.changes[0].branch, undefined);
    assert.equal(view.changes[0].status, 'closed');
    assert.deepEqual(timelineTexts(view), ['Close trail 106']);
    assert.deepEqual(calls('trail timeline').slice(timelines), [
      timelineOf(fixture.trailIds[106]),
      timelineOf('widget/1106'),
    ]);
  });

  test('names the change it will show when the row lists more than one', async () => {
    const row = rowOf(116);
    assert.equal(row.trail.changes.length, 2);
    const timelines = calls('trail timeline').length;
    await vscode.commands.executeCommand('entire.openDetail', row);
    const { view } = await panelOn((snapshot) => snapshot.view.number === 116, 'the trail whose row lists two changes');
    assert.deepEqual(timelineTexts(view), ['On the first change of trail 116']);
    assert.deepEqual(calls('trail timeline').slice(timelines), [timelineOf('widget/1116')]);
  });

  test('draws a trail it has read before at once, and reads it again to check', async () => {
    const id = fixture.trailIds[118];
    reply({ ...changed(showOf(118), { delayMs: 800 }), ...changed(timelineOf('widget/1118'), { delayMs: 1500 }) });
    const shows = calls('trail show').length;
    const timelines = calls('trail timeline').length;
    await vscode.commands.executeCommand('entire.openDetail', rowOf(118));

    // The whole trail is there before either read has come back, and says it is being checked.
    const first = await panelOn((snapshot) => snapshot.view.number === 118, 'the trail as read earlier', { stage: true });
    assert.equal(first.view.refreshing, true);
    assert.equal(first.view.partial, undefined);
    assert.equal(first.view.timelinePending, undefined);
    assert.equal(first.view.changes[0].number, 1118);
    assert.deepEqual(timelineTexts(first.view), ['Finish trail 118', 'Start trail 118']);
    assert.equal(first.view.timeline.hasMore, true);

    const after = await panelOn((snapshot) => snapshot.view.number === 118, 'the check to end');
    assert.equal(after.view.notice, undefined);
    assert.deepEqual(timelineTexts(after.view), ['Finish trail 118', 'Start trail 118']);
    // Both were read again. The change is known this time, so the timeline call names it.
    assert.deepEqual(calls('trail show').slice(shows), [showOf(118)]);
    assert.deepEqual(calls('trail timeline').slice(timelines), [timelineOf('widget/1118')]);

    // Nothing had changed, so the timeline on the page is the one drawn at
    // first, and its next page is still asked for the way it was read.
    await api.panels.currentTrail.receive({ type: 'loadMoreTimeline' });
    assert.equal(calls('trail timeline').at(-1), `${timelineOf(id)} --page-token=timeline-118-2`);
    reply({});
  });

  test('redraws what a fresh read finds changed', async () => {
    await vscode.commands.executeCommand('entire.openDetail', rowOf(120));
    await panelOn((snapshot) => snapshot.view.number === 120, 'another trail to take the tab');

    const show = JSON.parse(fixture.scenario[showOf(118)].stdout);
    const timeline = JSON.parse(fixture.scenario[timelineOf('widget/1118')].stdout);
    const newest = { ...timeline.items[0], id: 'event-new', title: 'Reopen trail 118' };
    reply({
      [showOf(118)]: { stdout: JSON.stringify({ ...show, title: 'Trail 118, renamed' }), delayMs: 800 },
      [timelineOf('widget/1118')]: {
        stdout: JSON.stringify({ ...timeline, items: [newest, ...timeline.items] }),
        delayMs: 1500,
      },
    });
    await vscode.commands.executeCommand('entire.openDetail', rowOf(118));
    const first = await panelOn((snapshot) => snapshot.view.number === 118, 'the trail as read earlier', { stage: true });
    assert.equal(first.view.title, 'Trail 118');
    assert.equal(first.view.refreshing, true);

    // The trail arrives first. The timeline already on the page stays until the fresh one does.
    const renamed = await panelOn((snapshot) => snapshot.view.title === 'Trail 118, renamed', 'the new title', {
      stage: true,
    });
    assert.equal(renamed.view.refreshing, true);
    assert.deepEqual(timelineTexts(renamed.view), ['Finish trail 118', 'Start trail 118']);
    assert.equal(api.panels.currentTrail.panel.title, '#118 Trail 118, renamed');

    const after = await panelOn((snapshot) => snapshot.view.number === 118, 'the fresh timeline');
    assert.deepEqual(timelineTexts(after.view), ['Reopen trail 118', 'Finish trail 118', 'Start trail 118']);
    assert.equal(after.view.notice, undefined);
    reply({});
  });

  test('keeps a trail it has read on the page when the fresh read fails, and says so', async () => {
    await vscode.commands.executeCommand('entire.openDetail', rowOf(120));
    await panelOn((snapshot) => snapshot.view.number === 120, 'another trail to take the tab');
    reply({ [showOf(118)]: { stderr: "Error: not logged in (run 'entire login' first)\n", exitCode: 1 } });
    await vscode.commands.executeCommand('entire.openDetail', rowOf(118));
    const { view } = await panelOn((snapshot) => snapshot.view.number === 118, 'the trail as read earlier');
    assert.equal(view.notice, 'You are not logged in to Entire. This is the trail as it was read earlier.');
    assert.equal(view.title, 'Trail 118, renamed');
    assert.equal(view.timeline.events.length, 3);

    // The Refresh button of the page reads it again.
    reply({});
    await api.panels.currentTrail.receive({ type: 'retry' });
    const fresh = await panelOn((snapshot) => snapshot.view.title === 'Trail 118', 'the trail after a refresh');
    assert.equal(fresh.view.notice, undefined);
    assert.deepEqual(timelineTexts(fresh.view), ['Finish trail 118', 'Start trail 118']);
  });

  test('forgets the trails it has read on a refresh of the views', async () => {
    assert.ok(repo.trailMemory.size > 0);
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => repo.trailMemory.size === 0, 'the refresh to forget the trails');
    await until(() => repo.trails && !repo.trails.loading && trailRows().length >= 50, 'the list after the refresh');
    // The trail opens as it did the first time: from its row, then from Entire.
    reply(changed(showOf(118), { delayMs: 800 }));
    await vscode.commands.executeCommand('entire.openDetail', rowOf(118));
    const first = await panelOn((snapshot) => snapshot.view.number === 118, 'the top of the page', { stage: true });
    assert.equal(first.view.partial, true);
    await panelOn((snapshot) => snapshot.view.number === 118, 'the trail');
    reply({});
  });

  test('opens a second trail in a tab of its own on request', async () => {
    const before = api.panels.allTrails.length;
    await vscode.commands.executeCommand('entire.openDetailInNewTab', trailRows()[0]);
    assert.equal(api.panels.allTrails.length, before + 1);
    const pinned = api.panels.allTrails.at(-1);
    assert.notEqual(pinned, api.panels.currentTrail);
    await viewOf(pinned, (snapshot) => snapshot.view.number === 120, 'the new tab to load');
    pinned.panel.dispose();
    assert.equal(api.panels.allTrails.length, before);
  });

  test('says so when a trail does not exist', async () => {
    await vscode.commands.executeCommand('entire.openDetail', {
      kind: 'trail',
      repo,
      trail: { number: 404, title: 'Gone', assignees: [], changes: [] },
    });
    const shown = await until(() => {
      const snapshot = api.panels.currentTrail?.snapshot();
      return snapshot && 'error' in snapshot ? snapshot : undefined;
    }, 'the panel to report the missing trail');
    assert.equal(shown.error, 'Entire could not find this trail.');
  });

  test('restores a trail panel from saved state and rejects state it cannot read', async () => {
    const options = { enableScripts: true };
    const restored = vscode.window.createWebviewPanel('entire.trail', 'Entire', vscode.ViewColumn.Active, options);
    await api.panels.trailSerializer.deserializeWebviewPanel(restored, { repoRoot: fixture.root, mode: 'trail', trail: 120 });
    const controller = api.panels.allTrails.find((candidate) => candidate.panel === restored);
    assert.ok(controller, 'the restored panel has a controller');
    const { target } = await viewOf(controller, (snapshot) => snapshot.view.number === 120, 'the restored panel to load');
    // The state was saved without the trail's ID. The read supplied it, for the next reload.
    assert.equal(target.id, fixture.trailIds[120]);
    restored.dispose();

    // An ID that is not one is dropped, and the rest of the state is kept.
    const odd = vscode.window.createWebviewPanel('entire.trail', 'Entire', vscode.ViewColumn.Active, options);
    await api.panels.trailSerializer.deserializeWebviewPanel(odd, {
      repoRoot: fixture.root,
      mode: 'trail',
      trail: 404,
      id: '--json',
    });
    const kept = api.panels.allTrails.find((candidate) => candidate.panel === odd);
    assert.ok(kept, 'state with a bad ID still restores');
    await until(() => {
      const snapshot = kept.snapshot();
      return snapshot && 'error' in snapshot;
    }, 'the restored panel to report the missing trail');
    assert.equal(calls('trail show').at(-1), 'trail show 404 --project gh/acme --json');
    odd.dispose();

    for (const state of [
      undefined,
      {},
      { repoRoot: fixture.root, mode: 'checkpoint', trail: 120 },
      { repoRoot: fixture.root, mode: 'trail', trail: '120' },
      { repoRoot: fixture.root, mode: 'trail', trail: 0 },
      { repoRoot: fixture.root, mode: 'trail', trail: 1.5 },
    ]) {
      const rejected = vscode.window.createWebviewPanel('entire.trail', 'Entire', vscode.ViewColumn.Active, options);
      let disposed = false;
      rejected.onDidDispose(() => {
        disposed = true;
      });
      await api.panels.trailSerializer.deserializeWebviewPanel(rejected, state);
      assert.equal(disposed, true, `state ${JSON.stringify(state)} is rejected`);
    }
  });

  test('leaves the view empty, for its welcome text, when the login is missing', async () => {
    reply({
      [fixture.trailListOpen]: { stderr: "Error: not logged in (run 'entire login' first): no saved login\n", exitCode: 1 },
    });
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => api.manager.trailsState() === 'loggedOut', 'the logged-out state');
    assert.deepEqual(rows(), []);
    assert.equal(repo.trails.failure.kind, 'notLoggedIn');

    // A project the login cannot see is told apart from a missing login.
    reply({
      [fixture.trailListOpen]: {
        stderr: 'project gh/acme does not exist or is not visible to your login; check that the owner is connected\n',
        exitCode: 1,
      },
    });
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => api.manager.trailsState() === 'noAccess', 'the no-access state');
    assert.deepEqual(rows(), []);

    // Any other failure leaves the reason in the log.
    reply({ [fixture.trailListOpen]: { stderr: 'dial tcp: connection refused\n', exitCode: 1 } });
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => api.manager.trailsState() === 'failed', 'the failed state');

    // An empty list is not a failure.
    reply({ [fixture.trailListOpen]: { stdout: JSON.stringify({ items: [], nextPageToken: null }) } });
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => api.manager.trailsState() === 'empty', 'the empty state');
    assert.deepEqual(rows(), []);

    // Refresh after the cause is gone brings the rows back.
    reply({});
    await vscode.commands.executeCommand('entire.refresh');
    await until(() => api.manager.trailsState() === 'ready', 'the trails to come back');
    assert.equal(trailRows().length, 50);
  });

  test('keeps the rows on screen while a refresh reads them again', async () => {
    const before = repo.trails;
    const refresh = vscode.commands.executeCommand('entire.refresh');
    // The old list stays until the new first page arrives.
    assert.equal(trailRows().length, 50);
    await refresh;
    await until(() => repo.trails !== before && !repo.trails.loading, 'the refreshed list');
    assert.equal(trailRows().length, 50);
    assert.notEqual(repo.trails.list, before.list, 'a fresh read gets a list of its own');
  });

  test('hides the Trails view and reads nothing from Entire while the setting is off', async () => {
    const settings = vscode.workspace.getConfiguration('entire');
    assert.equal(settings.get('trails.enabled'), true, 'trails are on unless turned off');
    assert.equal(api.manager.trailsEnabled, true);

    // A trail is open, and has been read, when the setting goes off.
    await vscode.commands.executeCommand('entire.openDetail', rowOf(118));
    await panelOn((snapshot) => snapshot.view.number === 118, 'a trail to be open');
    const panel = api.panels.currentTrail;
    assert.ok(repo.trailMemory.size > 0);

    try {
      await settings.update('trails.enabled', false, vscode.ConfigurationTarget.Global);
      await until(() => !api.manager.trailsEnabled && api.manager.trailRepos.length === 0, 'the setting to apply');
      // The view has nothing to list, and what was read is dropped.
      assert.equal(repo.trails, undefined);
      assert.equal(repo.trailMemory.size, 0);
      assert.deepEqual(rows(), []);
      // The open trail says why it has nothing to show.
      const off = await until(() => {
        const snapshot = panel.snapshot();
        return snapshot && 'error' in snapshot ? snapshot : undefined;
      }, 'the open trail to say that trails are off');
      assert.match(off.error, /Trails are turned off/);
      assert.match(off.error, /entire\.trails\.enabled/);

      // From here on, nothing asks the CLI about trails: not showing the view,
      // not a refresh, not the page's Retry button, not a trail's address.
      const before = calls('trail ').length;
      await vscode.commands.executeCommand('entire.trails.focus').then(undefined, () => undefined);
      await vscode.commands.executeCommand('entire.refresh');
      await panel.receive({ type: 'retry' });
      await panel.receive({ type: 'loadMoreTimeline' });
      assert.equal(await api.manager.trailUrl(repo, 120), undefined);
      await vscode.commands.executeCommand('entire.filterTrails', 'closed');
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(calls('trail ').length, before);
      assert.equal(repo.trails, undefined);
      assert.match(panel.snapshot().error, /Trails are turned off/);
    } finally {
      await settings.update('trails.enabled', undefined, vscode.ConfigurationTarget.Global);
    }

    // Turned on again, the view lists the trails from a fresh read, and the open trail loads.
    await until(() => api.manager.trailsEnabled && api.manager.trailRepos.length === 1, 'the setting to apply again');
    await vscode.commands.executeCommand('entire.filterTrails', 'open');
    await vscode.commands.executeCommand('entire.trails.focus');
    await until(() => repo.trails && !repo.trails.loading && trailRows().length === 50, 'the trails to be listed again');
    const back = await viewOf(panel, (snapshot) => snapshot.view.number === 118, 'the open trail to load again');
    assert.deepEqual(timelineTexts(back.view), ['Finish trail 118', 'Start trail 118']);
  });
});
