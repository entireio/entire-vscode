// Runs inside a VS Code extension host. See .vscode-test.mjs for the fixture
// repository and the fake Entire CLI these tests rely on.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
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

/** The fake CLI's calls to Entire's API. */
const apiCalls = () => invocations().filter((call) => call.startsWith('api '));
/** How many times Entire's list of the repository's sessions was read. */
const entireListCalls = () => apiCalls().filter((call) => call.includes('/sessions?')).length;

suite('Entire extension', () => {
  /** @type {import('../../src/extension').EntireTestApi} */
  let api;
  let repo;

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('entire.entire');
    assert.ok(extension, 'the extension is installed in the test host');
    api = await extension.activate();
    await until(() => api.manager.viewState === 'ready', 'the first load').catch((error) => {
      throw new Error(`${error.message} (view state: ${api.manager.viewState}, CLI: ${api.manager.cli?.binPath})`);
    });
    repo = api.manager.enabledRepos[0];
    assert.ok(repo, 'the fixture repository is enabled');
    // Rows from the CLI arrive after the tree is ready, because nothing waits for them.
    await until(() => repo.index?.row(fixture.ids.refs), 'enrichment rows');
  });

  test('uses the configured CLI and reads the repository', () => {
    assert.equal(api.manager.cliVersion.raw, '0.13.3');
    assert.equal(repo.root, fixture.root);
    assert.deepEqual(repo.entireRepo, { forge: 'gh', owner: 'acme', repo: 'widget' });
  });

  test('lists each commit that carries a checkpoint, newest first', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const commits = nodes.filter((node) => node.kind === 'commit');
    assert.deepEqual(
      commits.map((node) => node.commit.subject),
      ['Squash the review fixes', 'Add the parser', 'Add the changelog'],
    );
    // History is short, so there is nothing more to load.
    assert.equal(nodes.some((node) => node.kind === 'loadMore'), false);

    const parser = api.checkpointsTree.getTreeItem(commits[1]);
    assert.equal(label(parser), 'Add the parser');
    // Its checkpoint holds two sessions, so the row says so and expands to show them.
    assert.match(parser.description, /2 sessions/);
    assert.equal(parser.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
    assert.match(parser.contextValue, /\bweb\b/);
    assert.match(parser.contextValue, /\bhasCheckpoint\b/);
    assert.equal(parser.command.command, 'entire.openDetail');
  });

  test('builds the tooltip of a row when the row is hovered, not when it is listed', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const item = api.checkpointsTree.getTreeItem(parser);
    assert.equal(item.tooltip, undefined);

    // VS Code calls this on hover.
    const hovered = api.checkpointsTree.resolveTreeItem(item, parser);
    assert.match(hovered.tooltip.value, new RegExp(fixture.parserCommit));
    assert.match(hovered.tooltip.value, new RegExp(fixture.ids.refs));
    assert.match(hovered.tooltip.value, /Fixture Author/);
  });

  test('shows every checkpoint of a commit that carries several', async () => {
    const [squash] = await api.checkpointsTree.getChildren();
    const item = api.checkpointsTree.getTreeItem(squash);
    assert.match(item.description, /2 checkpoints/);
    assert.equal(item.command, undefined, 'a commit with several checkpoints expands instead of opening');

    const children = await api.checkpointsTree.getChildren(squash);
    assert.deepEqual(
      children.map((node) => node.checkpointId),
      [fixture.ids.legacy, fixture.ids.squashed],
    );
    // The second ID has no CLI row, so its label is the full ID, never a shortened one.
    assert.equal(label(api.checkpointsTree.getTreeItem(children[1])), fixture.ids.squashed);

    // The first holds one session. It says where it sits in that session and has no row beneath it.
    const legacy = api.checkpointsTree.getTreeItem(children[0]);
    assert.match(legacy.description, /Claude Code · 2 of 2/);
    assert.equal(legacy.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.match(legacy.contextValue, /\bhasTranscript\b/);
  });

  test('groups checkpoints that no commit on the branch carries', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const other = nodes.find((node) => node.kind === 'otherGroup');
    assert.ok(other, 'the imported checkpoint gets a group');
    const children = await api.checkpointsTree.getChildren(other);
    assert.deepEqual(
      children.map((node) => node.checkpointId),
      [fixture.ids.imported],
    );
    const item = api.checkpointsTree.getTreeItem(children[0]);
    assert.doesNotMatch(item.contextValue, /\bhasCommit\b/);
  });

  test('loads the sessions of a checkpoint when its row expands', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    assert.deepEqual(
      slots.map((node) => label(api.checkpointsTree.getTreeItem(node))),
      ['Claude Code · test-model', 'Codex · test-model'],
    );
    // The first session also produced the legacy checkpoint a day later, so this is its first of two.
    assert.equal(api.checkpointsTree.getTreeItem(slots[0]).description, '1 of 2 · 120 tokens');
    assert.equal(api.checkpointsTree.getTreeItem(slots[1]).description, '1 of 1 · 120 tokens');
    assert.ok(
      invocations().includes(`checkpoint explain --checkpoint ${fixture.ids.refs} --json --no-pager`),
      'detail is requested by checkpoint ID',
    );
  });

  test('lists sessions only after the Sessions view is shown, and not again on automatic refresh', async () => {
    const listCalls = () => invocations().filter((call) => call === 'session list --json').length;
    assert.equal(listCalls(), 0, 'nothing listed sessions while the view was hidden');
    assert.equal(entireListCalls(), 0, "nothing read Entire's list of sessions while the view was hidden");
    assert.equal(repo.remoteSessions, undefined);

    await vscode.commands.executeCommand('entire.sessions.focus');
    await until(() => repo.sessionRows?.length === 1, 'the session list');
    assert.equal(listCalls(), 1);
    await until(() => repo.remoteSessions?.sessions.size === 3, "Entire's list of sessions");
    assert.equal(entireListCalls(), 1);

    const groups = await api.sessionsTree.getChildren();
    assert.deepEqual(
      groups.map((node) => node.group),
      ['active', 'recent'],
    );
    const active = await api.sessionsTree.getChildren(groups[0]);
    assert.deepEqual(
      active.map((node) => node.session.sessionId),
      ['live-session'],
    );
    const recent = await api.sessionsTree.getChildren(groups[1]);
    const ids = recent.map((node) => node.session.sessionId);
    // Local state and sessions referenced by checkpoints are merged.
    assert.ok(ids.includes('local-session'));
    assert.ok(ids.includes('session-0'));
    assert.ok(ids.includes('imported-session'));

    // A new commit moves HEAD. The watcher rescans git but must not list sessions.
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'Another change'], {
      cwd: fixture.root,
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
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixture.root, encoding: 'utf8' }).trim();
    await until(() => repo.index?.tipSha === head, 'the index to follow HEAD');
    assert.equal(listCalls(), 1, 'an automatic refresh did not list sessions');
    assert.equal(entireListCalls(), 1, "an automatic refresh did not read Entire's list again");
  });

  test('opens a checkpoint on its own part of the normalized transcript', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    await vscode.commands.executeCommand('entire.openDetail', slots[0]);

    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.selected === 0 ? snapshot : undefined;
    }, 'the panel to load');
    assert.equal(shown.header.title, 'Add the parser');
    assert.equal(shown.header.checkpointId, fixture.ids.refs);
    assert.equal(shown.header.commit.sha, fixture.parserCommit);
    assert.equal(shown.header.canOpenOnWeb, true);
    assert.equal(shown.header.canShowCommitDiff, true);
    assert.equal(shown.header.sessions.length, 2);
    assert.equal(shown.transcript.source, 'compact');
    assert.equal(shown.turns, 4);
    // Lines 0 and 1 belong to the previous checkpoint, so this one starts at the third turn.
    assert.equal(shown.transcript.start, 2);
    // The page's script asks for data once it runs, which shows that the
    // bundle loads under the panel's Content Security Policy.
    await until(() => api.panels.current?.webviewReady, 'the panel page to run its script');
  });

  test('falls back to the CLI text view for a session with no normalized transcript', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    await vscode.commands.executeCommand('entire.openDetail', slots[1]);

    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.selected === 1 ? snapshot : undefined;
    }, 'the panel to load the second session');
    assert.equal(shown.transcript.source, 'cliText');
    assert.equal(shown.turns, 2);
    assert.match(shown.transcript.notice, /Text view from the Entire CLI/);
  });

  test('names who sent the prompts: the author of the commit, or else the author the CLI names', async () => {
    const authorCalls = () => invocations().filter((call) => call.endsWith('--short --no-pager'));
    const panelOn = (checkpointId, what) =>
      until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === checkpointId ? snapshot : undefined;
      }, what);
    const nodes = await api.checkpointsTree.getChildren();

    // A checkpoint on a commit: the commit's author, and no call to find one.
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const [slot] = await api.checkpointsTree.getChildren(parser);
    await vscode.commands.executeCommand('entire.openDetail', slot);
    const onCommit = await panelOn(fixture.ids.refs, 'the checkpoint on a commit');
    assert.equal(onCommit.header.commit.author, 'Fixture Author');
    assert.equal(onCommit.header.promptAuthor, 'Fixture Author');
    assert.deepEqual(authorCalls(), []);

    // A checkpoint that no commit here carries. Its transcript is shown
    // without a name, and the CLI, which takes a while, is asked for one.
    const other = nodes.find((node) => node.kind === 'otherGroup');
    const [imported] = await api.checkpointsTree.getChildren(other);
    await vscode.commands.executeCommand('entire.openDetail', imported);
    const shown = await panelOn(fixture.ids.imported, 'the checkpoint with no commit');
    assert.equal(shown.header.commit, undefined);
    assert.equal(shown.turns, 2);
    assert.equal(shown.header.promptAuthor, undefined);
    await until(
      () => api.panels.current.snapshot().header.promptAuthor === 'Imported Author',
      'the author the CLI names',
    );
    assert.deepEqual(authorCalls(), [`checkpoint explain --checkpoint ${fixture.ids.imported} --short --no-pager`]);

    // The answer is kept, so the name is there at once the next time, and the CLI is not asked again.
    await vscode.commands.executeCommand('entire.openDetail', slot);
    await panelOn(fixture.ids.refs, 'the first checkpoint again');
    await vscode.commands.executeCommand('entire.openDetail', imported);
    const again = await panelOn(fixture.ids.imported, 'the checkpoint with no commit again');
    assert.equal(again.header.promptAuthor, 'Imported Author');
    assert.equal(authorCalls().length, 1);
  });

  test('reads a legacy-layout checkpoint from the remote-tracking branch', async () => {
    const [squash] = await api.checkpointsTree.getChildren();
    const [legacy] = await api.checkpointsTree.getChildren(squash);
    await vscode.commands.executeCommand('entire.openDetail', legacy);

    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.legacy ? snapshot : undefined;
    }, 'the panel to load the legacy checkpoint');
    assert.equal(shown.transcript.source, 'compact');
    assert.equal(shown.turns, 1);
    assert.equal(shown.header.commit.sha, fixture.squashCommit);
  });

  test('says where a checkpoint sits in its session, and steps to the ones around it', async () => {
    const [squash] = await api.checkpointsTree.getChildren();
    const [legacy] = await api.checkpointsTree.getChildren(squash);
    await vscode.commands.executeCommand('entire.openDetail', legacy);
    const shownOn = (checkpointId) =>
      until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === checkpointId ? snapshot : undefined;
      }, `the panel to show ${checkpointId}`);

    // The session's second and latest checkpoint.
    let shown = await shownOn(fixture.ids.legacy);
    assert.deepEqual(shown.header.position, { ordinal: 2, total: 2, mayHaveEarlier: false, hasPrevious: true, hasNext: false });

    // Stepping back lands on the same session in the earlier checkpoint, which holds two sessions.
    api.panels.current.step('previous');
    shown = await shownOn(fixture.ids.refs);
    assert.equal(shown.header.sessions[shown.header.selected].sessionId, 'session-0');
    assert.deepEqual(shown.header.position, { ordinal: 1, total: 2, mayHaveEarlier: false, hasPrevious: false, hasNext: true });
    assert.equal(shown.header.commit.sha, fixture.parserCommit);

    // There is nothing before the first one, so stepping back again changes nothing.
    api.panels.current.step('previous');
    api.panels.current.step('next');
    shown = await shownOn(fixture.ids.legacy);
    assert.equal(shown.header.position.ordinal, 2);
  });

  test('serves a file as it was at a commit and at its parent', async () => {
    const parent = execFileSync('git', ['rev-parse', `${fixture.parserCommit}^`], {
      cwd: fixture.root,
      encoding: 'utf8',
    }).trim();
    const at = (ref, file) =>
      vscode.Uri.from({ scheme: 'entire-git', path: `/${file}`, query: JSON.stringify({ root: fixture.root, ref }) });
    const read = async (uri) => (await vscode.workspace.openTextDocument(uri)).getText();

    assert.equal(await read(at(fixture.parserCommit, 'notes.md')), 'second draft\n');
    assert.equal(await read(at(parent, 'notes.md')), 'first draft\n');
    // A file the commit added has an empty left side.
    assert.equal(await read(at('', 'parser.ts')), '');
    // Only commit SHAs are accepted as refs, so a branch name reads as empty.
    assert.equal(await read(at('main', 'notes.md')), '');
  });

  test('opens the files of a commit in the multi-file diff editor', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    await vscode.commands.executeCommand('entire.showCommitDiff', parser);
    const title = `Commit ${fixture.parserCommit.slice(0, 8)}`;
    const labels = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs).map((tab) => tab.label);
    await until(() => labels().some((label) => label.includes(title)), 'the commit diff tab', 10_000).catch((error) => {
      throw new Error(`${error.message}; open tabs: ${JSON.stringify(labels())}`);
    });
  });

  test('lists the files of the commit in the panel, with their status', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    await vscode.commands.executeCommand('entire.openDetail', slots[0]);
    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.refs ? snapshot : undefined;
    }, 'the panel to load');
    // The session touched parser.ts, which the commit added.
    assert.deepEqual(shown.header.files, [{ path: 'parser.ts', status: 'A' }]);
  });

  test('keeps a tab opened with Open in New Tab when the preview moves on', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const [squash] = nodes;
    const [legacy] = await api.checkpointsTree.getChildren(squash);
    const loadedOn = (controller, checkpointId) => {
      const snapshot = controller.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === checkpointId;
    };

    const before = api.panels.all.length;
    await vscode.commands.executeCommand('entire.openDetailInNewTab', parser);
    assert.equal(api.panels.all.length, before + 1);
    const pinned = api.panels.all.at(-1);
    assert.notEqual(pinned, api.panels.current, 'the new tab is not the preview');
    await until(() => loadedOn(pinned, fixture.ids.refs), 'the new tab to load');

    // Clicking another row reuses the preview and leaves the new tab alone.
    await vscode.commands.executeCommand('entire.openDetail', legacy);
    await until(() => loadedOn(api.panels.current, fixture.ids.legacy), 'the preview to move on');
    assert.equal(api.panels.all.length, before + 1);
    assert.ok(loadedOn(pinned, fixture.ids.refs), 'the new tab still shows its checkpoint');
    pinned.panel.dispose();
    assert.equal(api.panels.all.length, before);
  });

  test('restores a panel from the state its page saved, and rejects a state it cannot trust', async () => {
    const create = () => vscode.window.createWebviewPanel('entire.detail', 'Restored', vscode.ViewColumn.Active, {});

    const restored = create();
    await api.panels.deserializeWebviewPanel(restored, {
      repoRoot: fixture.root,
      mode: 'checkpoint',
      checkpointId: fixture.ids.legacy,
      commitSha: fixture.squashCommit,
    });
    const controller = api.panels.all.find((candidate) => candidate.panel === restored);
    assert.ok(controller, 'the restored panel is tracked');
    const shown = await until(() => {
      const snapshot = controller.snapshot();
      return snapshot && 'header' in snapshot ? snapshot : undefined;
    }, 'the restored panel to load');
    assert.equal(shown.header.checkpointId, fixture.ids.legacy);
    assert.equal(shown.header.commit.sha, fixture.squashCommit);
    restored.dispose();

    for (const state of [undefined, { mode: 'checkpoint' }, { repoRoot: fixture.root, mode: 'checkpoint', checkpointId: '../../etc' }]) {
      const rejected = create();
      let disposed = false;
      rejected.onDidDispose(() => {
        disposed = true;
      });
      await api.panels.deserializeWebviewPanel(rejected, state);
      assert.equal(disposed, true, `state ${JSON.stringify(state)} closes the panel`);
    }
  });

  test('opens a raw transcript as a private, read-only file, whatever its size', async () => {
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    const tabFor = (name) =>
      vscode.window.tabGroups.all.flatMap((group) => group.tabs).find((tab) => tab.label === name);
    const posix = process.platform !== 'win32';

    await vscode.commands.executeCommand('entire.openRawTranscript', slots[0]);
    const small = await until(() => tabFor(`${fixture.ids.refs}-session-0.jsonl`), 'the transcript tab');
    const file = small.input.uri.fsPath;
    assert.equal(fs.readFileSync(file, 'utf8'), fixture.rawSmall);
    if (posix) {
      assert.equal(fs.statSync(file).mode & 0o222, 0, 'nobody can write the file');
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o077, 0, 'only the owner can enter its directory');
    }

    // About 80 MB. It goes from the CLI to the file without passing through memory.
    await vscode.commands.executeCommand('entire.openRawTranscript', slots[1]);
    const large = await until(() => tabFor(`${fixture.ids.refs}-session-1.jsonl`), 'the large transcript tab');
    assert.equal(fs.statSync(large.input.uri.fsPath).size, fixture.rawLargeBytes);
    assert.ok(fixture.rawLargeBytes > 64 * 1024 * 1024);

    // Opening the same transcript again replaces the read-only file.
    await vscode.commands.executeCommand('entire.openRawTranscript', slots[0]);
    assert.equal(fs.readFileSync(file, 'utf8'), fixture.rawSmall);
  });

  test('explains a checkpoint whose data was never uploaded, shows its commit, and marks its row', async () => {
    const row = async () =>
      (await api.checkpointsTree.getChildren()).find(
        (node) => node.kind === 'commit' && node.commit.sha === fixture.missingCommit,
      );
    const asked = () =>
      invocations().filter((call) => call === `checkpoint explain --checkpoint ${fixture.ids.missing} --json --no-pager`).length;

    // Nothing says the data is missing until the CLI is asked for it.
    assert.doesNotMatch(api.checkpointsTree.getTreeItem(await row()).description, /no session data/);

    await vscode.commands.executeCommand('entire.openDetail', await row());
    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.missing ? snapshot : undefined;
    }, 'the panel to load');

    // No error page: the panel shows what git knows about the commit.
    assert.equal(shown.header.title, 'Add the changelog');
    assert.equal(shown.header.commit.sha, fixture.missingCommit);
    assert.deepEqual(shown.header.files, [{ path: 'CHANGELOG.md', status: 'A' }]);
    assert.equal(shown.header.canShowCommitDiff, true);
    assert.equal(shown.header.canOpenOnWeb, true);
    assert.equal(shown.header.canOpenRaw, false);
    assert.deepEqual(shown.header.sessions, []);
    // And it says why there is no transcript, and what would bring one.
    assert.equal(shown.transcript.source, 'none');
    assert.match(shown.transcript.notice, /no session data/);
    assert.match(shown.transcript.notice, /entire checkpoint push/);

    // The row now says so too, in the list.
    const marked = api.checkpointsTree.getTreeItem(await row());
    assert.match(marked.description, /no session data/);
    assert.equal(marked.collapsibleState, vscode.TreeItemCollapsibleState.None);
    assert.match(api.checkpointsTree.resolveTreeItem(marked, await row()).tooltip.value, /uploaded separately/);

    // The CLI takes seconds to give this answer, so it is not asked again right away.
    const before = asked();
    assert.equal(before, 1);
    const again = await api.manager.detail(repo, fixture.ids.missing);
    assert.equal(again.ok, false);
    assert.equal(asked(), before);

    // A manual refresh forgets the answer, in case the data has been uploaded since.
    await vscode.commands.executeCommand('entire.refresh');
    assert.doesNotMatch(api.checkpointsTree.getTreeItem(await row()).description, /no session data/);
    await api.manager.detail(repo, fixture.ids.missing);
    assert.equal(asked(), before + 1);
  });

  test('names a session by the prompt that opened it, with its checkpoints under it', async () => {
    const allSessions = async () => {
      const groups = await api.sessionsTree.getChildren();
      const lists = await Promise.all(groups.map((group) => api.sessionsTree.getChildren(group)));
      return lists.flat().filter((node) => node.kind === 'session');
    };
    const rowOf = async (sessionId) => (await allSessions()).find((node) => node.session.sessionId === sessionId);
    const labelOf = async (sessionId) => label(api.sessionsTree.getTreeItem(await rowOf(sessionId)));

    // Listing the rows asks for their names, which are read in the background
    // from the start of each session's stored transcript.
    await until(async () => (await rowOf('session-0'))?.session.name, 'the name of the session');
    const row = await rowOf('session-0');
    // Two checkpoints hold this session. The older one stores the conversation
    // from its start, and that is where the opening prompt is.
    assert.equal(row.session.name, 'Sketch the parser');
    const item = api.sessionsTree.getTreeItem(row);
    assert.equal(label(item), 'Sketch the parser');
    assert.match(item.description, /Claude Code · 2 checkpoints/);
    const resolved = api.sessionsTree.resolveTreeItem(item, row);
    assert.match(resolved.tooltip.value, /\*\*Sketch the parser\*\*/);

    // The session's checkpoints are listed under it, newest first.
    const under = await api.sessionsTree.getChildren(row);
    assert.deepEqual(
      under.map((node) => [node.kind, node.checkpointId]),
      [
        ['checkpoint', fixture.ids.legacy],
        ['checkpoint', fixture.ids.refs],
      ],
    );
    // The newer checkpoint stores only its own part of the conversation. Its
    // first prompt, "Fix the review comments", is not the session's.
    assert.deepEqual(repo.sessionNames.get('session-0'), { name: 'Sketch the parser', checkpoints: 2 });

    // A session with no checkpoint has no stored transcript at all: its latest prompt stands in.
    assert.equal(repo.sessionNames.has('local-session'), false);
    assert.equal(await labelOf('local-session'), 'Refactor the lexer');
  });

  test('names a session with no stored transcript once its transcript has been opened', async () => {
    const rowOf = async (sessionId) => {
      const groups = await api.sessionsTree.getChildren();
      const lists = await Promise.all(groups.map((group) => api.sessionsTree.getChildren(group)));
      return lists.flat().find((node) => node.kind === 'session' && node.session.sessionId === sessionId);
    };
    // The checkpoint of this session stores no normalized transcript, so the
    // Sessions view finds no name for it. It remembers that it looked.
    repo.sessionNames.delete('session-1');
    await rowOf('session-1');
    await until(() => repo.sessionNames.has('session-1'), 'the session to be looked at');
    assert.deepEqual(repo.sessionNames.get('session-1'), { name: null, checkpoints: 1 });
    assert.equal((await rowOf('session-1')).session.name, undefined);

    // Opening it reads the whole session through the CLI's text view, which starts with the opening prompt.
    const nodes = await api.checkpointsTree.getChildren();
    const parser = nodes.find((node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit);
    const slots = await api.checkpointsTree.getChildren(parser);
    await vscode.commands.executeCommand('entire.openDetail', slots[0]);
    await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.selected === 0;
    }, 'another session to take the tab');
    await vscode.commands.executeCommand('entire.openDetail', slots[1]);
    await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.selected === 1 && snapshot.transcript.source === 'cliText';
    }, 'the text view of the session');
    await until(async () => (await rowOf('session-1')).session.name === 'Review the parser', 'the name from the opened transcript');
    assert.equal(label(api.sessionsTree.getTreeItem(await rowOf('session-1'))), 'Review the parser');
  });

  test('titles the panel of a session with its opening prompt', async () => {
    await until(() => repo.sessionNames.get('session-0')?.name, 'the name of the session');
    await vscode.commands.executeCommand('entire.openDetail', {
      kind: 'session',
      repo,
      session: api.manager.sessionEntry(repo, 'session-0'),
    });
    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.mode === 'session' && snapshot.turns > 0 ? snapshot : undefined;
    }, 'the panel to load the session');
    // The panel opens on the session's newest checkpoint, whose transcript holds
    // only that checkpoint's part. Its first prompt, "Fix the review comments",
    // is not the session's, so the title is the name read from the older checkpoint.
    assert.equal(shown.header.checkpointId, fixture.ids.legacy);
    assert.equal(shown.header.title, 'Sketch the parser');
  });

  suite('sessions that Entire lists', () => {
    const rowOf = async (sessionId) => {
      const groups = await api.sessionsTree.getChildren();
      const lists = await Promise.all(groups.map((group) => api.sessionsTree.getChildren(group)));
      return lists.flat().find((node) => node.kind === 'session' && node.session.sessionId === sessionId);
    };
    const checkpointCalls = (sessionId) =>
      apiCalls().filter((call) => call.endsWith(`/sessions/${sessionId}/transcript`)).length;

    test('names a session as entire.com does, with the count of checkpoints Entire has', async () => {
      const row = await until(async () => {
        const found = await rowOf('imported-session');
        return found?.session.name ? found : undefined;
      }, 'the name from Entire');
      assert.equal(row.session.name, 'Port the Importer');
      const item = api.sessionsTree.getTreeItem(row);
      assert.equal(label(item), 'Port the Importer');
      // The clone knows one checkpoint of this session. Entire counts two.
      assert.equal(row.session.checkpoints.length, 1);
      assert.match(item.description, /^Claude Code · 2 checkpoints · /);
      const tooltip = api.sessionsTree.resolveTreeItem(item, row).tooltip.value;
      assert.match(tooltip, /\*\*Port the Importer\*\*/);
      // The prompt that opened the session is no longer its name, so the tooltip gives it.
      assert.match(tooltip, /Opening prompt: Port the importer/);
      assert.match(tooltip, /2 checkpoints/);
    });

    test('lists a session the clone has no data for', async () => {
      const row = await rowOf('entire-session');
      assert.ok(row, 'the session from another branch is listed');
      const item = api.sessionsTree.getTreeItem(row);
      assert.equal(label(item), 'Tune the Lexer on Another Branch');
      assert.match(item.description, /^Codex · 1 checkpoint · /);
      assert.equal(item.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
      assert.equal(row.session.model, 'other-model');
    });

    test('keeps the opening prompt as the name of a session Entire does not list', async () => {
      const row = await until(async () => {
        const found = await rowOf('session-0');
        return found?.session.name ? found : undefined;
      }, 'the name of the session');
      assert.equal(row.session.name, 'Sketch the parser');
      assert.equal(row.session.listedCheckpoints, undefined);
    });

    test('sends Entire a GET and nothing else', () => {
      const calls = apiCalls();
      assert.ok(calls.length > 0);
      for (const call of calls) {
        assert.match(call, /^api --to cell \/api\/v1\/repos\/\{repo_id\}\/sessions[/?][^ ]*$/, call);
      }
    });

    test('lists the checkpoints the clone knows at once, and adds the ones Entire lists', async () => {
      const row = await rowOf('imported-session');
      assert.equal(checkpointCalls('imported-session'), 0, 'nothing asked for the checkpoints before the row was opened');

      // Entire takes a while to answer. The checkpoint the clone knows is listed meanwhile.
      const first = await api.sessionsTree.getChildren(row);
      assert.deepEqual(
        first.map((node) => node.checkpointId),
        [fixture.ids.imported],
      );

      const both = await until(async () => {
        const under = await api.sessionsTree.getChildren(await rowOf('imported-session'));
        return under.length === 2 ? under : undefined;
      }, "the checkpoints from Entire's list");
      // Newest first. The one from another branch has the subject of its commit, and its place in the session.
      assert.deepEqual(
        both.map((node) => [node.kind, node.checkpointId]),
        [
          ['checkpoint', fixture.ids.elsewhere],
          ['checkpoint', fixture.ids.imported],
        ],
      );
      const elsewhere = api.sessionsTree.getTreeItem(both[0]);
      assert.equal(label(elsewhere), 'Port the importer tests');
      assert.match(elsewhere.description, /^2 of 2 · /);
      assert.match(api.sessionsTree.getTreeItem(both[1]).description, /^1 of 2 · /);
      assert.match(api.sessionsTree.resolveTreeItem(elsewhere, both[0]).tooltip.value, /Checkpoint 2 of 2 of this session/);
      // It opens like any other checkpoint, on this session.
      assert.equal(elsewhere.command.command, 'entire.openDetail');
      assert.equal(both[0].sessionId, 'imported-session');

      // The list is read once, however often the row is drawn.
      await api.sessionsTree.getChildren(await rowOf('imported-session'));
      assert.equal(checkpointCalls('imported-session'), 1);
    });

    test('waits for Entire when the clone knows no checkpoint of the session', async () => {
      const under = await api.sessionsTree.getChildren(await rowOf('entire-session'));
      assert.deepEqual(
        under.map((node) => [node.kind, node.checkpointId]),
        [['checkpoint', fixture.ids.onEntire]],
      );
      assert.equal(label(api.sessionsTree.getTreeItem(under[0])), 'Tune the lexer');
      assert.equal(checkpointCalls('entire-session'), 1);
    });

    test('opens a session of another branch on the checkpoint Entire lists for it', async () => {
      await vscode.commands.executeCommand('entire.openDetail', {
        kind: 'session',
        repo,
        session: api.manager.sessionEntry(repo, 'entire-session'),
      });
      const shown = await until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.mode === 'session' && snapshot.turns > 0 ? snapshot : undefined;
      }, 'the panel to load the session');
      assert.equal(shown.header.checkpointId, fixture.ids.onEntire);
      assert.equal(shown.header.title, 'Tune the Lexer on Another Branch');
      assert.equal(checkpointCalls('entire-session'), 1, 'the list read for the row served the panel too');
    });

    test('names the tab of a session whose checkpoint the CLI cannot find, and points to entire.com', async () => {
      await vscode.commands.executeCommand('entire.openDetail', {
        kind: 'session',
        repo,
        session: api.manager.sessionEntry(repo, 'lost-session'),
      });
      const shown = await until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.lost ? snapshot : undefined;
      }, 'the panel to load the session');
      // The clone knew no checkpoint of the session, so the panel asked Entire which one to open.
      assert.equal(shown.header.mode, 'session');
      assert.equal(shown.header.title, 'Trim the Changelog');
      assert.equal(shown.transcript.source, 'none');
      assert.match(shown.transcript.notice, /could not find the session data .* page on entire\.com/);
      assert.equal(shown.header.canOpenOnWeb, true);
    });

    test('reads the list again on a manual refresh, and falls back to local names when Entire cannot be read', async () => {
      await vscode.commands.executeCommand('entire.refresh');
      await until(() => entireListCalls() === 2, "a second read of Entire's list");
      await until(async () => (await rowOf('imported-session'))?.session.name === 'Port the Importer', 'the name to hold');

      // The saved login is gone. The names read before stay, and the view says what to do.
      const listKey = Object.keys(fixture.scenario).find((key) => key.startsWith('api ') && key.includes('/sessions?'));
      fs.writeFileSync(
        fixture.scenarioFile,
        JSON.stringify({
          ...fixture.scenario,
          [listKey]: { stderr: "not logged in: run 'entire login' to authenticate\n", exitCode: 1 },
        }),
      );
      try {
        await vscode.commands.executeCommand('entire.refresh');
        await until(() => repo.remoteSessions?.failure?.kind === 'notLoggedIn', 'the failed read');
        assert.equal((await rowOf('imported-session')).session.name, 'Port the Importer');
        await until(() => /not logged in to Entire/.test(api.sessionsView.message ?? ''), 'the notice in the view');

        // In a window that never had the names, the rows are named from the clone.
        repo.forgetRemoteSessions();
        await api.manager.loadRemoteSessions(repo);
        assert.equal(repo.remoteSessions.failure.kind, 'notLoggedIn');
        const row = await rowOf('imported-session');
        assert.equal(row.session.listedCheckpoints, undefined);
        assert.equal(await rowOf('entire-session'), undefined);
      } finally {
        fs.writeFileSync(fixture.scenarioFile, JSON.stringify(fixture.scenario));
      }
      await vscode.commands.executeCommand('entire.refresh');
      await until(() => repo.remoteSessions?.failure === undefined && repo.remoteSessions?.sessions.size === 3, 'the names to return');
      assert.equal(api.sessionsView.message, undefined);
    });
  });

  suite('the selected row', () => {
    const sessionRow = async (sessionId) => {
      const groups = await api.sessionsTree.getChildren();
      const lists = await Promise.all(groups.map((group) => api.sessionsTree.getChildren(group)));
      return lists.flat().find((node) => node.kind === 'session' && node.session.sessionId === sessionId);
    };
    const commitRow = async (sha) =>
      (await api.checkpointsTree.getChildren()).find((node) => node.kind === 'commit' && node.commit.sha === sha);
    /** Selects a row the way a click does, without opening it. */
    const select = async (view, node) => {
      await view.reveal(node, { select: true, focus: false });
      await until(() => view.selection[0] === node, 'the row to be selected');
    };
    const shownOn = (checkpointId) =>
      until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === checkpointId ? snapshot : undefined;
      }, `the panel to show ${checkpointId}`);
    const selectionOf = (view, matches, what) =>
      until(() => {
        const selected = view.selection[0];
        return selected && matches(selected) ? selected : undefined;
      }, what);

    test('is one object for each row, however often a view is drawn', async () => {
      const first = await commitRow(fixture.parserCommit);
      const session = await sessionRow('session-0');
      const under = await api.sessionsTree.getChildren(session);
      api.manager.noteSessionName(repo, 'session-0', 'Sketch the parser, again');
      await until(async () => (await sessionRow('session-0')).session.name === 'Sketch the parser, again', 'the views to redraw');
      // A redrawn row is the same object with what is now known, which is what lets the editor find it.
      assert.equal(await commitRow(fixture.parserCommit), first);
      assert.equal(await sessionRow('session-0'), session);
      assert.equal(session.session.name, 'Sketch the parser, again');
      assert.deepEqual(await api.sessionsTree.getChildren(session), under);
      assert.equal((await api.sessionsTree.getChildren(session))[0], under[0]);
      assert.equal(api.sessionsTree.getParent(under[0]), session);
      api.manager.noteSessionName(repo, 'session-0', 'Sketch the parser');
    });

    test('moves to the checkpoint that Previous and Next step to, in the Checkpoints view', async () => {
      await vscode.commands.executeCommand('entire.checkpoints.focus');
      await until(() => api.checkpointsView.visible, 'the Checkpoints view');
      const squash = await commitRow(fixture.squashCommit);
      const legacy = (await api.checkpointsTree.getChildren(squash)).find((node) => node.checkpointId === fixture.ids.legacy);
      await select(api.checkpointsView, legacy);
      await vscode.commands.executeCommand('entire.openDetail', legacy);
      await shownOn(fixture.ids.legacy);

      // The session's earlier checkpoint is on another commit, which carries only that checkpoint.
      api.panels.current.step('previous');
      const parser = await selectionOf(
        api.checkpointsView,
        (node) => node.kind === 'commit' && node.commit.sha === fixture.parserCommit,
        'the selection to move to the commit of the earlier checkpoint',
      );
      assert.equal(parser, await commitRow(fixture.parserCommit));
      await shownOn(fixture.ids.refs);

      // And back: the later checkpoint has a row of its own, under a commit that carries two.
      api.panels.current.step('next');
      await selectionOf(api.checkpointsView, (node) => node === legacy, 'the selection to move back');
      await shownOn(fixture.ids.legacy);
    });

    test('moves to the checkpoint under its session, in the Sessions view, and leaves the other view alone', async () => {
      await vscode.commands.executeCommand('entire.sessions.focus');
      await until(() => api.sessionsView.visible, 'the Sessions view');
      const under = await api.sessionsTree.getChildren(await sessionRow('session-0'));
      const legacy = under.find((node) => node.checkpointId === fixture.ids.legacy);
      await select(api.sessionsView, legacy);
      const elsewhere = api.checkpointsView.selection[0];
      await vscode.commands.executeCommand('entire.openDetail', legacy);
      await shownOn(fixture.ids.legacy);

      api.panels.current.step('previous');
      const moved = await selectionOf(
        api.sessionsView,
        (node) => node.kind === 'checkpoint' && node.checkpointId === fixture.ids.refs,
        'the selection to move to the earlier checkpoint of the session',
      );
      assert.equal(moved.sessionId, 'session-0');
      assert.equal(api.sessionsTree.getParent(moved).session.sessionId, 'session-0');
      await shownOn(fixture.ids.refs);
      await api.selectionSync.settled;
      // The tab was opened from the Sessions view, so the Checkpoints view keeps the row it had.
      assert.equal(api.checkpointsView.selection[0], elsewhere);
    });

    test('stays on the row of a session while the tab shows that session', async () => {
      const session = await sessionRow('session-0');
      await select(api.sessionsView, session);
      await vscode.commands.executeCommand('entire.openDetail', session);
      const shown = await until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.mode === 'session' && snapshot.header.checkpointId === fixture.ids.legacy
          ? snapshot
          : undefined;
      }, 'the panel to show the session');
      // A tab on a session shows the whole conversation. It has no place in the session and nothing to step to.
      assert.equal(shown.header.position, undefined);
      api.panels.current.step('previous');
      await api.selectionSync.settled;
      assert.equal(api.sessionsView.selection[0], session);
      assert.equal(api.panels.current.snapshot().header.checkpointId, fixture.ids.legacy);
    });

    test('moves to the other session of a checkpoint when the tab switches to it', async () => {
      await vscode.commands.executeCommand('entire.checkpoints.focus');
      await until(() => api.checkpointsView.visible, 'the Checkpoints view');
      const slots = await api.checkpointsTree.getChildren(await commitRow(fixture.parserCommit));
      assert.deepEqual(
        slots.map((node) => [node.kind, node.session.sessionId]),
        [
          ['slot', 'session-0'],
          ['slot', 'session-1'],
        ],
      );
      await select(api.checkpointsView, slots[0]);
      await vscode.commands.executeCommand('entire.openDetail', slots[0]);
      await until(() => {
        const snapshot = api.panels.current?.snapshot();
        return snapshot && 'header' in snapshot && snapshot.header.checkpointId === fixture.ids.refs && snapshot.header.selected === 0;
      }, 'the panel to show the first session');

      api.panels.current.selectSession(1);
      const moved = await selectionOf(
        api.checkpointsView,
        (node) => node.kind === 'slot' && node.session.sessionId === 'session-1',
        'the selection to move to the other session',
      );
      assert.equal(moved, slots[1]);
    });

    test('goes to the commit of a checkpoint that was opened from somewhere other than a row', async () => {
      // A trail's timeline opens checkpoints this way.
      api.panels.open(
        { repoRoot: repo.root, mode: 'checkpoint', checkpointId: fixture.ids.imported },
        { newTab: false },
      );
      // No commit on the branch carries this one. Its row is under Other Checkpoints.
      const moved = await selectionOf(
        api.checkpointsView,
        (node) => node.kind === 'checkpoint' && node.checkpointId === fixture.ids.imported,
        'the selection to go to the checkpoint',
      );
      assert.equal(api.checkpointsTree.getParent(moved).kind, 'otherGroup');
      await shownOn(fixture.ids.imported);
    });

    test('does not open the sidebar to select a row', async () => {
      const squash = await commitRow(fixture.squashCommit);
      const legacy = (await api.checkpointsTree.getChildren(squash)).find((node) => node.checkpointId === fixture.ids.legacy);
      await select(api.checkpointsView, legacy);
      await vscode.commands.executeCommand('entire.openDetail', legacy);
      await shownOn(fixture.ids.legacy);
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await until(() => !api.checkpointsView.visible, 'the sidebar to close');

      api.panels.current.step('previous');
      await shownOn(fixture.ids.refs);
      await api.selectionSync.settled;
      assert.equal(api.checkpointsView.visible, false, 'the sidebar stayed closed');

      await vscode.commands.executeCommand('entire.checkpoints.focus');
      await until(() => api.checkpointsView.visible, 'the Checkpoints view');
    });
  });

  test('opens a session that has no checkpoint with its facts and no transcript', async () => {
    await vscode.commands.executeCommand('entire.openDetail', {
      kind: 'session',
      repo,
      session: api.manager.sessionEntry(repo, 'local-session'),
    });
    const shown = await until(() => {
      const snapshot = api.panels.current?.snapshot();
      return snapshot && 'header' in snapshot && snapshot.header.mode === 'session' ? snapshot : undefined;
    }, 'the panel to load the session');
    assert.equal(shown.header.title, 'Refactor the lexer');
    assert.equal(shown.header.localSession.pendingTurns, 1);
    assert.equal(shown.transcript.source, 'none');
    assert.match(shown.transcript.notice, /no checkpoint yet/);
  });
});
