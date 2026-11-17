# Contributing

## Development

Node 22.18 or later is required.

```sh
npm install
npm run build                      # bundle the extension and the panel into dist/
npm run check                      # lint, type-check, and unit tests
npm run test:host                  # run the extension in a VS Code instance against a fixture repository
npm run smoke -- /path/to/repo     # print what the extension would show for a real repository
npm run notices                    # rewrite THIRD_PARTY_NOTICES.md after a bundled dependency changes
```

Press F5 in VS Code to start an Extension Development Host with the extension loaded.

The extension-host tests open real editor windows, one per launch, and close them when they finish. The windows start with Chromium's background throttling turned off, because they usually sit behind your other windows and the editor slows down there.

The extension-host tests run in VS Code by default. To run them in another editor built on VS Code, point `ENTIRE_TEST_EDITOR` at its executable. Each launch uses a profile of its own, so the editor's real settings and extensions are left alone.

```sh
ENTIRE_TEST_EDITOR=/Applications/Cursor.app/Contents/MacOS/Cursor npm run test:host
npx vscode-test --code-version 1.95.0    # the oldest VS Code the manifest allows
```

## Layout

| Path | Contents |
| --- | --- |
| `src/core` | Git and Entire CLI logic. It does not import `vscode`, so it runs under plain Node in tests. |
| `src/ext` | Tree views, commands, file watchers, and the panel hosts. |
| `src/webview` | The UI of the detail panel and the trail panel, bundled separately for the browser. One bundle serves both, and the host says which page to draw. |
| `src/shared` | Message types that the host and the panels both use. |
| `test/unit`, `test/webview` | `vitest` tests. Webview tests run on `happy-dom`, except the Markdown sanitizer tests and the trail panel tests, which need `jsdom` because DOMPurify does not work on `happy-dom`. |
| `test/integration` | Tests that run inside a VS Code extension host. |
| `test/fake-entire` | A stand-in for the Entire CLI that replays canned output. |

Ten things are easy to break without noticing:

- Automatic refresh calls `entire status --json` and git only. `entire session list` prunes old session state, so it runs when the Sessions view is first shown and on a manual refresh. An extension-host test asserts this.
- A list loads its next page when its Load More row scrolls into view. Tree views report nothing about scrolling, so `src/ext/views/scrollLoader.ts` relies on the editor asking for a row's file decoration when it draws the row. The row's `resourceUri` is what makes that work, and the extension-host tests in `test/integration/scroll.test.cjs` fail if an editor stops asking that way.
- The selected row follows the detail tab (`src/ext/views/selectionSync.ts`). A click selects a row, but Previous and Next move the tab without a click, and `TreeView.reveal` is the only way to move a selection. `reveal` takes a row object and looks for it among the ones the editor was given. An equal row that is another object is not found, and VS Code 1.95 refuses it as a duplicate. So the Checkpoints and Sessions trees hand out one object for each row ID and update it in place (`src/ext/views/rowRegistry.ts`). Do not return a freshly built row from `getChildren` past the registry, and do not keep a row object to compare its old fields with later ones. `reveal` also opens the sidebar on a view that is hidden, so a view that is not visible is left alone. The tests in `test/integration/extension.test.cjs` run against a real tree view, and are worth running on the oldest supported editor after a change here.
- A raw transcript goes from the CLI straight to a temporary file (`src/ext/transcriptFiles.ts`), not into memory. One long session's transcript measured 178 MB. Open such files with the `vscode.open` command: the extension host refuses to load documents over 50 MB.
- `src/core/checkpointStore.ts` is the only module that knows how checkpoints are stored in git. It exists to read the normalized transcript, which no CLI command outputs, and every reader in it falls back to the CLI on a surprise. The transcript is read whole to show it, and its first lines are read to name a session by its opening prompt. Most transcripts hold the session from its start, so each checkpoint of a session gives the same opening prompt. A transcript with no start line holds only its checkpoint's part, and its first prompt is not taken for the session's unless the checkpoint is the session's first.
- Trails and Entire's session list are the two features that reach the network. Trails go through `entire trail list`, `show`, and `timeline`. Those three only read. The other trail commands write, and the extension runs none of them. Nothing calls the three until the Trails view is on screen, which `test/integration/states.test.cjs` asserts, and nothing calls them while the `entire.trails.enabled` setting is off, which `test/integration/trails.test.cjs` asserts. A trail's web address comes from `entire trail show`, because the CLI asks callers not to build one. The CLI lists trails by status only, so `src/core/trails.ts` matches a phase filter against the trails read so far and limits how many pages one load may read.
- The Sessions view takes its names from Entire's API, through `entire api --to cell` (`src/core/remoteSessions.ts`, and `remoteSessions` and `remoteSessionCheckpoints` in `src/core/entireCli.ts`). The calls pass a path and no other flag, so the CLI sends a GET, and a test in `test/unit/remoteSessionsCli.test.ts` fails if a method, field, or body flag appears. The CLI calls these endpoints internal, so the readers take only the fields they know and every failure falls back to what the clone knows: the session list from the CLI and git, with names from stored transcripts. The API answers a refusal as JSON on stdout with a non-zero exit, which is why these calls do not use `jsonResult`. Nothing reads the list until the Sessions view is on screen, and automatic refresh never reads it, which `test/integration/extension.test.cjs` and `test/integration/states.test.cjs` assert. A session's checkpoints come with its whole transcript, so that call runs only for a session whose count on Entire exceeds what the clone knows, once, and the rows the clone knows are drawn without waiting for it.
- The trail panel reads a trail and its timeline side by side, because each call takes seconds (`src/ext/panel/trailPanelController.ts`). Until the trail is read, the timeline call can name only the trail, and the CLI then picks the change without saying which one it read. The panel uses that answer only when the trail has one change, and asks for the change by name otherwise. The CLI picks by branch, so it refuses a change whose branch is gone, and the panel asks for such a change by name without waiting for the refusal. `test/integration/trails.test.cjs` has a trail for each case. What the panel keeps in `src/core/trailMemory.ts` is a head start: it reads a trail again each time it draws one from there.
- The brain graph is a server that the extension starts and has to stop (`src/ext/brainService.ts`, `src/core/serverProcess.ts`). `entire brain viz` runs until it is stopped, as a child of the Entire CLI, so the extension stops the whole process group, and it stops every server when the window closes. The plugin's page forbids framing, which is why it opens in the browser and not in a panel. The address the extension opens is rebuilt from the port in the plugin's ready line (`parseVizUrl` in `src/core/brain.ts`) and is never that line's text. Nothing runs a brain command until the Brain view, which starts collapsed, is opened or View Brain is used. `test/integration/states.test.cjs` asserts that in windows whose sidebar stays closed. That file's fake server prints an address and serves nothing, so run the command against a real brain after a change here.
- The Brain view is a page and not a tree (`src/core/brainPage.ts`, `src/ext/views/brainView.ts`). Every row of a tree view looks clickable, and the brain's details are text with nothing to click. The page has no script. Its buttons are links to commands, and the view lets the editor run only the commands in `BRAIN_PAGE_COMMANDS`. A row that does nothing does not belong in a tree view: put it on a page, or leave it out.

## Screenshots

The two pictures in `images/` are of the extension in VS Code, on a demo repository with made-up commits, sessions, and trails. The fake Entire CLI in `test/fake-entire` supplies the data, as it does for the extension-host tests. Retake them when a view changes, and take them from made-up data: a screenshot of a real repository publishes its session names, prompts, and transcripts.

The README links to them by relative path. `vsce` rewrites those links to this repository on GitHub when it packages the extension, so the pictures are not in the VSIX, and they show on the Marketplace only while the repository is public.

## Releasing

A release is a tag. Pushing `v<version>` runs `.github/workflows/release.yml`, which builds the VSIX once and publishes that one file to the Visual Studio Marketplace and to Open VSX.

1. Update `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Run `npm run check`, `npm run test:host`, and `npm run package`. The last command writes `entire-<version>.vsix`.
3. Install that file with `code --install-extension entire-<version>.vsix` and open a repository that has checkpoints.
4. Commit, then tag and push the tag: `git tag v<version>` and `git push origin v<version>`.

### One-Time Setup

**Visual Studio Marketplace.** The workflow signs in with [GitHub Trusted Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension), so the repository stores no Marketplace token. The personal access tokens that `vsce` used before are retired on December 1, 2026.

1. Create the publisher `entire` at [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage). Its ID has to match `publisher` in `package.json`, and it cannot be changed later.
2. Open the publisher, select Trusted Publishing, and create a policy with repository owner `entireio`, repository `entire-vscode`, workflow `release.yml`, and environment `marketplace`.

**Open VSX.** The steps are in the [Open VSX publishing guide](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions).

1. Create an Eclipse account, sign in to open-vsx.org with GitHub, and accept the Publisher Agreement in the profile settings.
2. Generate an access token under Settings, Access Tokens, and create the namespace with `npx ovsx create-namespace entire -p <token>`.
3. Save the token as the secret `OVSX_PAT` in the repository's `open-vsx` environment.

The two publish jobs run in the `marketplace` and `open-vsx` environments. Add required reviewers to them in the repository settings if a release should wait for an approval.
