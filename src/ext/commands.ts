import * as vscode from 'vscode';
import type { Actions } from './actions';
import type { BrainOutcome, BrainService } from './brainService';
import type { PanelManager } from './panel/panelManager';
import {
  readTrailFilter,
  trailFilterKey,
  trailFilterLabel,
  trailFilters,
  words,
  type TrailFilter,
} from '../core/trails';
import type { RepoContext, RepoManager } from './repoManager';
import { detailTarget, detailViewOf, nodeFacts, trailTarget, type DetailView, type Node } from './views/nodes';

const INSTALL_URL = 'https://docs.entire.io/installation';

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { kind?: unknown }).kind === 'string';
}

export function registerCommands(
  manager: RepoManager,
  panels: PanelManager,
  actions: Actions,
  log: vscode.LogOutputChannel,
  brain: BrainService,
): vscode.Disposable[] {
  /** Registers a command that acts on a tree row and ignores calls without one. */
  const onNode = (command: string, handler: (node: Node) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(command, (node?: unknown) => {
      if (isNode(node)) return handler(node);
      return undefined;
    });

  /** The view a row is in, which then follows the tab the row opens. */
  const originOf = (node: Node): { origin?: DetailView } => {
    const origin = detailViewOf(node);
    return origin ? { origin } : {};
  };

  const pickWebRepo = async (): Promise<RepoContext | undefined> => {
    const repos = manager.repos.filter((repo) => repo.entireRepo !== undefined);
    if (repos.length <= 1) return repos[0];
    const pick = await vscode.window.showQuickPick(
      repos.map((repo) => ({ label: repo.name, description: repo.root, repo })),
      { placeHolder: 'Select a repository to open on entire.com' },
    );
    return pick?.repo;
  };

  /** The repository whose brain to show. Entire has to be enabled in it. */
  const pickEnabledRepo = async (): Promise<RepoContext | undefined> => {
    const repos = manager.enabledRepos;
    if (repos.length <= 1) return repos[0];
    const pick = await vscode.window.showQuickPick(
      repos.map((repo) => ({ label: repo.name, description: repo.root, repo })),
      { placeHolder: 'Select a repository to show the brain graph of' },
    );
    return pick?.repo;
  };

  /**
   * Says why the brain graph did not open. Installing the plugin and
   * building a brain are the user's to do, in a terminal, so the message
   * hands over the command and the extension runs neither.
   */
  const reportBrain = (outcome: BrainOutcome): void => {
    const offer = (message: string, command: string): void => {
      void vscode.window.showInformationMessage(message, 'Copy Command').then((choice) => {
        if (choice === 'Copy Command') void actions.copy(command, command);
      });
    };
    if (outcome.kind === 'pluginMissing') {
      offer(
        'The brain graph needs the entire-brain plugin. Run "entire plugin install brain" in a terminal, then try again.',
        'entire plugin install brain',
      );
    } else if (outcome.kind === 'noBrain') {
      offer(
        'This repository has no brain yet. Run "entire brain setup" in a terminal to build one, then try again.',
        'entire brain setup',
      );
    } else if (outcome.kind === 'failed') {
      void vscode.window.showErrorMessage(outcome.message, 'Show Log').then((choice) => {
        if (choice === 'Show Log') log.show();
      });
    }
  };

  /**
   * Asks which trails to show. A trail is open or closed, and an open trail
   * is in a phase, so the list has one entry for each of those, and one for
   * every trail.
   */
  const pickTrailFilter = (): Promise<TrailFilter | undefined> => {
    const seen = manager.trailRepos.flatMap((repo) => repo.trails?.trails.map((trail) => trail.phase) ?? []);
    const current = trailFilterKey(manager.trailFilter);
    const describe = (filter: TrailFilter): string => {
      if (filter.phase) return `Open trails in the ${words(filter.phase)} phase`;
      if (filter.status === 'all') return 'Open and closed trails';
      return filter.status === 'closed' ? 'Trails that are closed' : 'Trails that are not closed, in any phase';
    };
    interface Item extends vscode.QuickPickItem {
      filter?: TrailFilter;
    }
    const item = (filter: TrailFilter): Item => ({
      label: trailFilterLabel(filter),
      description: trailFilterKey(filter) === current ? `${describe(filter)} (shown now)` : describe(filter),
      filter,
    });
    const filters = trailFilters(seen);
    const items: Item[] = [
      ...filters.filter((filter) => !filter.phase).map(item),
      { label: 'Open Trails by Phase', kind: vscode.QuickPickItemKind.Separator },
      ...filters.filter((filter) => filter.phase).map(item),
    ];
    return new Promise((resolve) => {
      const picker = vscode.window.createQuickPick<Item>();
      picker.title = 'Filter Trails';
      picker.placeholder = 'Show only the trails that are…';
      picker.matchOnDescription = true;
      picker.items = items;
      // The picker opens on the filter in use.
      picker.activeItems = items.filter((candidate) => candidate.filter && trailFilterKey(candidate.filter) === current);
      let picked: TrailFilter | undefined;
      picker.onDidAccept(() => {
        picked = picker.selectedItems[0]?.filter;
        picker.hide();
      });
      picker.onDidHide(() => {
        picker.dispose();
        resolve(picked);
      });
      picker.show();
    });
  };

  return [
    vscode.commands.registerCommand('entire.refresh', () => {
      // The brain's report is read on request, like the trails. A refresh reads again what has been read.
      brain.refresh();
      return manager.reload({ manual: true });
    }),

    vscode.commands.registerCommand('entire.openRepoOnWeb', async () => {
      const repo = await pickWebRepo();
      if (repo) await actions.openRepoOnWeb(repo);
      else void vscode.window.showInformationMessage('No open repository has an entire:// origin remote.');
    }),

    // Opens the graph of the repository's brain in the browser. See BrainGraph for why not in a tab.
    // The Brain view's button passes its repository. From the title bar or the command palette, a picker asks.
    vscode.commands.registerCommand('entire.openBrainGraph', async (root?: unknown) => {
      const repo =
        typeof root === 'string' ? manager.enabledRepos.find((candidate) => candidate.root === root) : await pickEnabledRepo();
      if (!repo) {
        if (manager.enabledRepos.length === 0) {
          void vscode.window.showInformationMessage('Entire is not enabled in an open repository.');
        }
        return undefined;
      }
      // A server that is already up opens at once. Starting one takes a moment, and can be cancelled.
      const outcome = brain.needsStart(repo)
        ? await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Starting the brain graph…', cancellable: true },
            (_progress, token) => {
              const abort = new AbortController();
              token.onCancellationRequested(() => abort.abort());
              return brain.open(repo, abort.signal);
            },
          )
        : await brain.open(repo);
      reportBrain(outcome);
      return outcome;
    }),

    // The Brain view's Stop button passes its repository. From the command palette, every server stops.
    vscode.commands.registerCommand('entire.stopBrainGraph', (root?: unknown) => {
      brain.stop(typeof root === 'string' ? root : undefined);
    }),

    // Installing the plugin and building a brain are the user's to do, in a terminal.
    vscode.commands.registerCommand('entire.copyBrainInstallCommand', () =>
      actions.copy('entire plugin install brain', 'entire plugin install brain'),
    ),
    vscode.commands.registerCommand('entire.copyBrainSetupCommand', () => actions.copy('entire brain setup', 'entire brain setup')),

    vscode.commands.registerCommand('entire.setCliPath', async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: 'Use This Entire CLI',
        title: 'Select the Entire CLI Binary',
      });
      const file = picked?.[0];
      if (!file) return;
      await vscode.workspace.getConfiguration('entire').update('cliPath', file.fsPath, vscode.ConfigurationTarget.Global);
    }),

    vscode.commands.registerCommand('entire.installCli', () => vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL))),

    vscode.commands.registerCommand('entire.showLog', () => log.show()),

    vscode.commands.registerCommand('entire.copyEnableCommand', () => actions.copy('entire enable', 'entire enable')),

    // Logging in is the user's to do, in a terminal. The extension only hands over the command.
    vscode.commands.registerCommand('entire.copyLoginCommand', () => actions.copy('entire login', 'entire login')),

    // With a filter's key as the argument, the command applies it. With none, it asks.
    vscode.commands.registerCommand('entire.filterTrails', async (key?: unknown) => {
      const filter = readTrailFilter(key) ?? (await pickTrailFilter());
      if (filter) await manager.setTrailFilter(filter);
    }),

    onNode('entire.loadMore', (node) => {
      if (node.kind === 'loadMore') return manager.showMore(node.repo, node.list);
      return undefined;
    }),

    onNode('entire.openDetail', (node) => {
      const trail = trailTarget(node);
      if (trail) return panels.openTrail(trail, { newTab: false });
      const target = detailTarget(node);
      if (target) panels.open(target, { newTab: false, ...originOf(node) });
    }),

    onNode('entire.openDetailInNewTab', (node) => {
      const trail = trailTarget(node);
      if (trail) return panels.openTrail(trail, { newTab: true });
      const target = detailTarget(node);
      if (target) panels.open(target, { newTab: true, ...originOf(node) });
    }),

    onNode('entire.openOnWeb', (node) => {
      if (node.kind === 'trail') return actions.openTrailOnWeb(node.repo, node.trail.number);
      const { repo, commitSha, sessionId } = nodeFacts(node);
      if (!repo) return undefined;
      // A session row and a session slot open the session page. Commit and
      // checkpoint rows open the commit page, where entire.com shows the checkpoint.
      const preferSession = node.kind === 'session' || node.kind === 'slot';
      if (sessionId && (preferSession || !commitSha)) return actions.openSessionOnWeb(repo, sessionId);
      if (commitSha) return actions.openCommitOnWeb(repo, commitSha);
      return undefined;
    }),

    onNode('entire.showCommitDiff', (node) => {
      const { repo, commitSha } = nodeFacts(node);
      if (repo && commitSha) return actions.showCommitDiff(repo, commitSha);
      return undefined;
    }),

    onNode('entire.openRawTranscript', async (node) => {
      // A slot, or a commit or checkpoint row that stands for its only session.
      const facts = nodeFacts(node);
      if (node.kind !== 'session' && facts.repo && facts.checkpointId && facts.sessionIndex !== undefined) {
        return actions.openRawCheckpointTranscript(facts.repo, facts.checkpointId, facts.sessionIndex);
      }
      if (node.kind !== 'session') return undefined;
      const { repo, session } = node;
      const checkpointId = session.checkpoints[0]?.checkpointId;
      if (checkpointId) {
        const detail = await manager.detail(repo, checkpointId);
        const slot = detail.ok ? detail.value.sessions.find((s) => s.sessionId === session.sessionId) : undefined;
        if (slot) return actions.openRawCheckpointTranscript(repo, checkpointId, slot.index);
      }
      return actions.openRawSessionTranscript(repo, session.sessionId);
    }),

    onNode('entire.copyCheckpointId', (node) => {
      const { checkpointId } = nodeFacts(node);
      if (checkpointId) return actions.copy(checkpointId, 'checkpoint ID');
      return undefined;
    }),

    onNode('entire.copyCommitSha', (node) => {
      const { commitSha } = nodeFacts(node);
      if (commitSha) return actions.copy(commitSha, 'commit SHA');
      return undefined;
    }),

    onNode('entire.copyTrailLink', (node) => {
      if (node.kind === 'trail') return actions.copyTrailLink(node.repo, node.trail.number);
      return undefined;
    }),

    onNode('entire.copySessionId', (node) => {
      const { sessionId } = nodeFacts(node);
      if (sessionId) return actions.copy(sessionId, 'session ID');
      return undefined;
    }),
  ];
}
