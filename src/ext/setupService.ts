import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import { MIN_CLI_VERSION_TEXT } from '../core/cliLocator';
import type { Failure } from '../core/errors';
import {
  cliProgram,
  INSTALL_URL,
  installOptions,
  isCliAction,
  isMachineAction,
  readSetupAction,
  runKey,
  setupCommandLine,
  setupModel,
  shellKind,
  type MachineFacts,
  type RepoFacts,
  type SetupAction,
} from '../core/setup';
import type { SetupPage } from '../core/setupPage';
import { parseEntireRemote } from '../core/webLinks';
import type { BrainService } from './brainService';
import type { RepoContext, RepoManager, ViewState } from './repoManager';
import { TerminalRunner, type SetupRunner, type SetupRunResult } from './setupTerminal';

/** The states in which Entire cannot show anything yet, so the Setup view shows itself. */
const SETUP_STATES: ReadonlySet<ViewState> = new Set(['cliMissing', 'cliTooOld', 'notEnabled']);

/** Where the workspace remembers that the Setup view stays until it is hidden. */
const PINNED_KEY = 'entire.setup.pinned';

/** The agent guide that `entire graph setup` writes, which AGENTS.md and CLAUDE.md point to. */
const AGENT_GUIDE = path.join('.entire', 'agent-guide.md');
const GUIDE_MAX_BYTES = 256 * 1024;

/** What one read found about a repository, apart from what the manager and the brain service know. */
interface RepoReading {
  graphGuide?: boolean;
  /** Read from the `origin` remote, for a repository whose status the CLI has not read. */
  hosted?: boolean;
}

/**
 * The steps that set up Entire, for the Setup view: what is known about each,
 * and the running of their commands.
 *
 * Nothing here reads anything until the Setup view is on screen, or a step is
 * run: the login check asks entire.io, and the brain check runs a plugin
 * that may not be installed. Each command runs in a terminal through the
 * runner, where the user sees it and answers its prompts. The extension never
 * runs one any other way.
 */
export class SetupService implements vscode.Disposable {
  /** Runs the steps' commands. The extension-host tests replace it. */
  runner: SetupRunner;

  /** The Setup view is open and on screen. The view sets this. */
  visible = false;

  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when anything the Setup view shows has changed. */
  readonly onDidChange = this.changed.event;

  private login?: MachineFacts['login'];
  private user?: string;
  private graphPlugin?: MachineFacts['graphPlugin'];
  private readonly readings = new Map<string, RepoReading>();
  /** Counts the reads, so a late answer to an earlier one is dropped. */
  private reads = 0;
  /** The actions under way, by {@link runKey}. */
  private readonly running = new Set<string>();
  /**
   * Actions typed into a terminal without shell integration, which cannot say
   * when they end. They count as running until the user is back in the
   * window, closes the terminal, or clicks Check Again.
   */
  private readonly waiting = new Set<SetupAction>();
  private shownContext: boolean | undefined;
  private readonly subscriptions: vscode.Disposable[];
  private readonly ownRunner?: TerminalRunner;

  constructor(
    private readonly manager: RepoManager,
    private readonly brain: BrainService,
    private readonly memento: vscode.Memento,
    private readonly log: vscode.LogOutputChannel,
    runner?: SetupRunner,
  ) {
    if (runner) {
      this.runner = runner;
    } else {
      this.ownRunner = new TerminalRunner();
      this.runner = this.ownRunner;
    }
    this.subscriptions = [
      manager.onDidChange(() => {
        // A repository that left the window takes what was read about it along.
        for (const root of [...this.readings.keys()]) {
          if (!manager.repoFor(root)) this.readings.delete(root);
        }
        this.syncContext();
        this.changed.fire();
      }),
      brain.onDidChange(() => this.changed.fire()),
      // A command typed into a terminal may have ended by the time the user is back.
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.settleWaiting();
      }),
      vscode.window.onDidCloseTerminal(() => void this.settleWaiting()),
    ];
    this.syncContext();
  }

  dispose(): void {
    for (const subscription of this.subscriptions) subscription.dispose();
    this.ownRunner?.dispose();
    this.changed.dispose();
  }

  /** The Setup view stays in the sidebar after its steps are done, until the user hides it. */
  get pinned(): boolean {
    return this.memento.get<boolean>(PINNED_KEY, false);
  }

  /**
   * Whether the sidebar shows the Setup view: while Entire cannot show
   * anything without a step, and after that until the user hides it. It
   * stays once it has been used, so that enabling Entire does not take away
   * the steps that follow.
   */
  get showSetup(): boolean {
    return SETUP_STATES.has(this.manager.viewState) || this.pinned;
  }

  /** The view came on screen. In a state that needs a step, it stays from now on. */
  viewShown(): void {
    if (SETUP_STATES.has(this.manager.viewState) && !this.pinned) void this.pin();
    void this.refresh();
  }

  async pin(): Promise<void> {
    if (!this.pinned) await this.memento.update(PINNED_KEY, true);
    await this.syncContext();
  }

  async hide(): Promise<void> {
    await this.memento.update(PINNED_KEY, false);
    await this.syncContext();
    this.changed.fire();
  }

  /** What the Setup view shows. */
  page(): SetupPage {
    if (this.manager.repos.length === 0) {
      return this.manager.viewState === 'loading' ? { kind: 'loading' } : { kind: 'noRepository' };
    }
    return { kind: 'steps', model: setupModel(this.machineFacts(), this.manager.repos.map((repo) => this.repoFacts(repo)), this.running) };
  }

  machineFacts(): MachineFacts {
    const state = this.manager.viewState;
    const cli: MachineFacts['cli'] =
      state === 'cliMissing' ? 'missing' : state === 'cliTooOld' ? 'tooOld' : this.manager.cli ? 'ok' : 'unknown';
    const facts: MachineFacts = { cli, minVersion: MIN_CLI_VERSION_TEXT };
    if (this.manager.cliVersion) facts.cliVersion = this.manager.cliVersion.raw;
    if (cli !== 'ok') return facts;
    if (this.login) facts.login = this.login;
    if (this.user) facts.user = this.user;
    if (this.graphPlugin) facts.graphPlugin = this.graphPlugin;
    return facts;
  }

  repoFacts(repo: RepoContext): RepoFacts {
    const reading = this.readings.get(repo.root) ?? {};
    const facts: RepoFacts = { root: repo.root, name: repo.name };
    // The CLI has read the status only when it is available.
    if (this.manager.cli && repo.status) facts.enabled = repo.enabled;
    const hosted = repo.entireRepo !== undefined ? true : reading.hosted;
    if (hosted !== undefined) facts.hosted = hosted;
    if (reading.graphGuide !== undefined) facts.graphGuide = reading.graphGuide;
    const info = this.brain.details(repo.root);
    if (info?.status) {
      const state = info.status.manifestState;
      facts.brain = state === 'absent' ? 'noBrain' : state === 'current' ? 'built' : 'failed';
      if (info.status.hosted) facts.brainHosted = info.status.hosted;
    } else if (info?.failure) {
      facts.brain = info.failure.kind === 'pluginMissing' ? 'pluginMissing' : 'failed';
    } else if (info?.loading) {
      facts.brain = 'loading';
    }
    return facts;
  }

  /**
   * Reads what the steps depend on: the login, the Graph plugin, and for each
   * repository its agent guide, its origin, and its brain. Only while the
   * Setup view is on screen, unless `force` says a step has just run.
   */
  async refresh(options: { force?: boolean } = {}): Promise<void> {
    if (!this.visible && !options.force) return;
    const read = ++this.reads;
    const cli = this.manager.cli;
    const repos = [...this.manager.repos];
    const cwd = repos[0]?.root;
    const machine = cli && cwd ? Promise.all([cli.authStatus(cwd), cli.graphVersion(cwd)]) : Promise.resolve(undefined);
    const perRepo = repos.map(async (repo) => {
      const [graphGuide, origin] = await Promise.all([
        readGraphGuide(repo.root),
        repo.entireRepo ? Promise.resolve(undefined) : this.manager.git.originUrl(repo.root),
      ]);
      // The brain service keeps the report, which the Brain view shows too.
      if (cli) await this.brain.loadStatus(repo);
      return { repo, reading: { graphGuide, hosted: repo.entireRepo !== undefined || parseEntireRemote(origin) !== undefined } };
    });
    const [checks, ...readings] = await Promise.all([machine, ...perRepo]);
    if (read !== this.reads) return;

    if (checks) {
      const [auth, graph] = checks;
      if (auth.ok) {
        this.login = auth.value.loggedIn ? 'loggedIn' : 'loggedOut';
        this.user = auth.value.user;
      } else {
        this.login = auth.failure.kind === 'notLoggedIn' ? 'loggedOut' : 'unknown';
        this.user = undefined;
        if (auth.failure.kind !== 'notLoggedIn') this.warn('the login', auth.failure);
      }
      if (graph.ok) this.graphPlugin = 'installed';
      else {
        this.graphPlugin = graph.failure.kind === 'pluginMissing' ? 'missing' : 'unknown';
        if (graph.failure.kind !== 'pluginMissing') this.warn('the Graph plugin', graph.failure);
      }
    } else {
      this.login = undefined;
      this.user = undefined;
      this.graphPlugin = undefined;
    }
    for (const { repo, reading } of readings) this.readings.set(repo.root, reading);
    this.changed.fire();
  }

  /**
   * Runs the command of one step in a terminal, then reads again what it
   * changed. `root` names the repository for a step of a repository, and is
   * ignored for a step of the machine. Both come from a page link, so both
   * are checked here.
   */
  async runStep(root: unknown, actionArg: unknown): Promise<void> {
    const action = readSetupAction(actionArg);
    if (!action) return;
    if (action === 'setCliPath') {
      await vscode.commands.executeCommand('entire.setCliPath');
      return;
    }
    const repo = typeof root === 'string' ? this.manager.repoFor(root) : undefined;
    if (!isMachineAction(action) && !repo) return;

    let commandLine: string | undefined;
    if (isCliAction(action)) {
      if (!this.manager.cliPath) {
        void vscode.window.showWarningMessage('Install the Entire CLI first.');
        return;
      }
      const program = cliProgram(this.manager.cliPath, this.manager.cliSource);
      commandLine = setupCommandLine(action, program, shellKind(vscode.env.shell, process.platform));
    } else {
      commandLine = await this.pickInstall(action === 'updateCli');
    }
    if (!commandLine) return;

    const key = runKey(repo?.root, action);
    if (this.running.has(key)) return;
    await this.pin();
    this.running.add(key);
    this.changed.fire();

    const cwd = repo?.root ?? this.manager.repos[0]?.root ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const terminalName = repo && this.manager.repos.length > 1 ? `Entire Setup: ${repo.name}` : 'Entire Setup';
    this.log.info(`Setup: running "${commandLine}" in a terminal in ${cwd}.`);
    let result: SetupRunResult;
    try {
      result = await this.runner.run({ cwd, terminalName, commandLine });
    } catch (error) {
      this.log.warn(`Setup: could not run "${commandLine}": ${error instanceof Error ? error.message : String(error)}`);
      result = { tracked: true };
    }
    if (!result.tracked) {
      // The terminal cannot say when it ends. The step shows as running until the user is back.
      this.waiting.add(action);
      this.changed.fire();
      return;
    }
    this.running.delete(key);
    if (result.exitCode !== undefined && result.exitCode !== 0) {
      this.log.warn(`Setup: "${commandLine}" exited with code ${result.exitCode}.`);
    }
    await this.afterRun([action]);
  }

  /** Reads everything again, as Check Again asks. A command typed into a terminal counts as ended. */
  async check(): Promise<void> {
    if (this.waiting.size > 0) {
      await this.settleWaiting();
      return;
    }
    await this.refresh({ force: true });
  }

  /** What has to be read again after these actions ran. */
  private async afterRun(actions: readonly SetupAction[]): Promise<void> {
    if (actions.includes('login')) {
      // Only a manual refresh reads the trails and Entire's session list again, which a login changes.
      await vscode.commands.executeCommand('entire.refresh');
    } else if (actions.some((action) => action === 'installCli' || action === 'updateCli' || action === 'enable')) {
      await this.manager.reload({ manual: false });
    }
    await this.refresh({ force: true });
  }

  /** Treats the commands typed into a terminal as ended, and reads again what they changed. */
  private async settleWaiting(): Promise<void> {
    if (this.waiting.size === 0) return;
    const actions = [...this.waiting];
    this.waiting.clear();
    for (const key of [...this.running]) {
      const action = readSetupAction(key.split('\x00')[1]);
      if (action && actions.includes(action)) this.running.delete(key);
    }
    this.changed.fire();
    await this.afterRun(actions);
  }

  /**
   * Asks how to install or update the CLI, and returns the command line. The
   * picker shows each command in full before anything runs.
   */
  private async pickInstall(update: boolean): Promise<string | undefined> {
    const hasBrew =
      process.platform === 'darwin' && (existsSync('/opt/homebrew/bin/brew') || existsSync('/usr/local/bin/brew'));
    const options = installOptions(process.platform, {
      hasBrew,
      update,
      ...(this.manager.cliPath ? { cliPath: this.manager.cliPath } : {}),
    });
    interface Item extends vscode.QuickPickItem {
      commandLine?: string;
    }
    const items: Item[] = [
      ...options.map((option): Item => ({
        label: option.label,
        description: option.description,
        detail: option.commandLine,
        commandLine: option.commandLine,
      })),
      { label: 'Open the Installation Guide', description: INSTALL_URL.replace(/^https:\/\//, '') },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: update ? 'Update the Entire CLI' : 'Install the Entire CLI',
      placeHolder: 'The command runs in a terminal',
    });
    if (pick && !pick.commandLine) {
      await vscode.env.openExternal(vscode.Uri.parse(INSTALL_URL));
      return undefined;
    }
    return pick?.commandLine;
  }

  /** Publishes whether the sidebar shows the Setup view. Resolves once the editor has it. */
  private async syncContext(): Promise<void> {
    const show = this.showSetup;
    if (show === this.shownContext) return;
    this.shownContext = show;
    await vscode.commands.executeCommand('setContext', 'entire.showSetup', show);
  }

  private warn(what: string, failure: Failure): void {
    this.log.warn(`Setup: could not check ${what}: ${failure.message} ${failure.detail ?? ''}`.trim());
  }
}

/** Whether the repository's agent guide is installed and tells agents to use Graph. */
async function readGraphGuide(root: string): Promise<boolean> {
  try {
    const text = await readFile(path.join(root, AGENT_GUIDE), 'utf8');
    return /\bentire graph\b/.test(text.slice(0, GUIDE_MAX_BYTES));
  } catch {
    return false;
  }
}
