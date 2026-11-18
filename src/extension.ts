import * as vscode from 'vscode';
import { exec } from './core/exec';
import { trailFilterLabel } from './core/trails';
import { Git } from './core/git';
import { Lane } from './core/scheduler';
import { Actions } from './ext/actions';
import { registerCommands } from './ext/commands';
import {
  GIT_SCHEME,
  GitContentProvider,
  TEXT_SCHEME,
  TextProvider,
} from './ext/gitContent';
import { BrainService } from './ext/brainService';
import { PANEL_VIEW_TYPE, PanelManager, TRAIL_PANEL_VIEW_TYPE } from './ext/panel/panelManager';
import { RefreshController } from './ext/refresh';
import { RepoManager } from './ext/repoManager';
import { SearchPicker } from './ext/searchPicker';
import { SetupService } from './ext/setupService';
import { TranscriptFiles } from './ext/transcriptFiles';
import { BRAIN_VIEW_ID, BrainView } from './ext/views/brainView';
import { SETUP_VIEW_ID, SetupView } from './ext/views/setupView';
import { CheckpointsTree } from './ext/views/checkpointsTree';
import type { Node } from './ext/views/nodes';
import { ScrollLoader } from './ext/views/scrollLoader';
import { SelectionSync } from './ext/views/selectionSync';
import { SessionsTree } from './ext/views/sessionsTree';
import { TrailsTree } from './ext/views/trailsTree';

/** The git binary VS Code is configured to use, or `git` from PATH. */
function gitPath(): string {
  const configured = vscode.workspace.getConfiguration('git').get<string | string[] | null>('path');
  const first = Array.isArray(configured) ? configured[0] : configured;
  return typeof first === 'string' && first.trim() !== '' ? first : 'git';
}

/** Internals handed to the extension-host tests. Not a supported API for other extensions. */
export interface EntireTestApi {
  manager: RepoManager;
  checkpointsTree: CheckpointsTree;
  sessionsTree: SessionsTree;
  trailsTree: TrailsTree;
  checkpointsView: vscode.TreeView<Node>;
  sessionsView: vscode.TreeView<Node>;
  trailsView: vscode.TreeView<Node>;
  scrollLoader: ScrollLoader;
  selectionSync: SelectionSync;
  panels: PanelManager;
  brain: BrainService;
  brainView: BrainView;
  setup: SetupService;
  setupView: SetupView;
  search: SearchPicker;
}

export function activate(context: vscode.ExtensionContext): EntireTestApi {
  const log = vscode.window.createOutputChannel('Entire', { log: true });
  const git = new Git(exec, new Lane(4), gitPath());
  const manager = new RepoManager(git, exec, log);
  const text = new TextProvider();
  const transcripts = new TranscriptFiles();
  const actions = new Actions(manager, text, transcripts);
  const panels = new PanelManager(manager, actions, context.extensionUri);
  const brain = new BrainService(manager, log);
  const setup = new SetupService(manager, brain, context.workspaceState, log);
  const search = new SearchPicker(manager, panels, actions, log);

  const checkpointsTree = new CheckpointsTree(manager);
  const sessionsTree = new SessionsTree(manager);
  const checkpointsView = vscode.window.createTreeView('entire.checkpoints', {
    treeDataProvider: checkpointsTree,
    showCollapseAll: true,
  });
  const sessionsView = vscode.window.createTreeView('entire.sessions', {
    treeDataProvider: sessionsTree,
    showCollapseAll: true,
  });
  // Shown only for a repository whose origin uses the entire:// scheme. See package.json.
  const trailsTree = new TrailsTree(manager);
  const trailsView = vscode.window.createTreeView('entire.trails', { treeDataProvider: trailsTree });

  // Last in the sidebar and collapsed until it is opened. Shown when Entire is enabled. See package.json.
  const brainView = new BrainView(manager, brain);
  // First in the sidebar, while Entire needs setting up and until it is hidden. See package.json.
  const setupView = new SetupView(setup);

  const scrollLoader = new ScrollLoader(manager);
  // The selected row follows a detail tab that moves on, in the view the tab was opened from.
  const selectionSync = new SelectionSync(
    {
      checkpoints: { view: checkpointsView, tree: checkpointsTree },
      sessions: { view: sessionsView, tree: sessionsTree },
    },
    panels,
    (line) => log.warn(line),
  );
  const refresh = new RefreshController(
    manager,
    () => checkpointsView.visible || sessionsView.visible || trailsView.visible || brainView.visible,
  );

  /**
   * The full session list loads when the Sessions view is first shown, and
   * again only on a manual refresh, because listing prunes old session state.
   * Entire's own list of the sessions, which names them, is read from
   * entire.io at the same two moments.
   */
  const ensureSessionRows = (): void => {
    if (!sessionsView.visible || manager.viewState !== 'ready') return;
    for (const repo of manager.enabledRepos) {
      if (repo.sessionRows === undefined) {
        repo.sessionRows = [];
        void manager.loadSessionRows(repo);
      }
    }
    manager.ensureRemoteSessions();
  };

  /**
   * Trails come from entire.io, so they load when the Trails view is first
   * shown and not before. After that, Refresh reads them again.
   */
  const ensureTrails = (): void => {
    if (trailsView.visible) manager.ensureTrails();
  };

  /**
   * The brain's report comes from the entire-brain plugin, which may not be
   * installed, so it is read when the Brain view is first shown and not
   * before. After that, Refresh reads it again.
   */
  const ensureBrain = (): void => {
    if (brainView.visible && manager.viewState === 'ready') brain.ensureStatus();
  };

  const updateChrome = (): void => {
    const loading = manager.viewState === 'loading' ? 'Loading…' : undefined;
    const gitError = manager.enabledRepos.find((repo) => repo.gitError)?.gitError;
    checkpointsView.message = loading ?? gitError;
    sessionsView.message = loading ?? manager.sessionsNotice();
    trailsView.message = loading ?? (manager.trailsState() === 'loading' ? 'Loading…' : undefined);
    trailsView.description = trailFilterLabel(manager.trailFilter);
    ensureTrails();
    ensureBrain();
    const active = manager.viewState === 'ready' ? sessionsTree.activeCount() : 0;
    sessionsView.badge =
      active > 0 ? { value: active, tooltip: active === 1 ? '1 active session' : `${active} active sessions` } : undefined;
    ensureSessionRows();
  };

  context.subscriptions.push(
    log,
    manager,
    transcripts,
    panels,
    // Stops the brain graph servers it started.
    brain,
    checkpointsTree,
    sessionsTree,
    trailsTree,
    checkpointsView,
    sessionsView,
    trailsView,
    refresh,
    manager.onDidChange(updateChrome),
    checkpointsView.onDidChangeVisibility((event) => {
      if (event.visible) refresh.flush();
    }),
    sessionsView.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      refresh.flush();
      ensureSessionRows();
    }),
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, new GitContentProvider(manager)),
    vscode.workspace.registerTextDocumentContentProvider(TEXT_SCHEME, text),
    trailsView.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      refresh.flush();
      ensureTrails();
    }),
    brainView,
    vscode.window.registerWebviewViewProvider(BRAIN_VIEW_ID, brainView),
    brainView.onDidShow(() => {
      refresh.flush();
      ensureBrain();
    }),
    setup,
    setupView,
    vscode.window.registerWebviewViewProvider(SETUP_VIEW_ID, setupView),
    vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, panels),
    vscode.window.registerWebviewPanelSerializer(TRAIL_PANEL_VIEW_TYPE, panels.trailSerializer),
    scrollLoader,
    selectionSync,
    vscode.window.registerFileDecorationProvider(scrollLoader),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void manager.reload({ manual: false })),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('entire.cliPath')) void manager.reload({ manual: false });
      if (event.affectsConfiguration('entire.trails.enabled')) {
        manager.applyTrailsSetting();
        // An open trail says that trails are off, or reads its trail now that they are on.
        for (const panel of panels.allTrails) panel.refresh();
      }
    }),
    ...registerCommands(manager, panels, actions, log, brain, setup, search),
  );

  updateChrome();
  void manager.reload({ manual: false });
  return {
    manager,
    checkpointsTree,
    sessionsTree,
    trailsTree,
    checkpointsView,
    sessionsView,
    trailsView,
    scrollLoader,
    selectionSync,
    panels,
    brain,
    brainView,
    setup,
    setupView,
    search,
  };
}

export function deactivate(): void {
  // Everything is released through context.subscriptions.
}
