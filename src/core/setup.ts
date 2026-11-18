/**
 * What setting up Entire takes, step by step, and the command each step runs.
 *
 * The Setup view lists the steps with what is known about each. Its buttons
 * run the commands in a terminal, where the user sees them and answers their
 * prompts. This module only decides what to show and builds the command
 * lines. Each line is the CLI followed by constant arguments, so nothing a
 * repository or the CLI reports can end up in one.
 *
 * It uses nothing from Node, so the Setup view's page and its tests can share it.
 */

/** The Entire CLI's installation guide. */
export const INSTALL_URL = 'https://docs.entire.io/installation';

/** The steps, in the order the view lists them. CLI and Login are for the machine, the rest for each repository. */
export type SetupStepId = 'cli' | 'login' | 'enable' | 'graph' | 'brain' | 'connect';

/** What a step's button does. Every one of them is a command line, except `setCliPath` and `openInstallDocs`. */
export type SetupAction =
  | 'installCli'
  | 'updateCli'
  | 'setCliPath'
  | 'login'
  | 'enable'
  | 'installGraph'
  | 'setupGraph'
  | 'installBrain'
  | 'setupBrain'
  | 'connectBrain';

/** The actions that run `entire` itself with constant arguments. */
export type CliAction = Exclude<SetupAction, 'installCli' | 'updateCli' | 'setCliPath'>;

/** The arguments of each action that runs `entire`. */
export const SETUP_ARGS: Readonly<Record<CliAction, readonly string[]>> = {
  login: ['login'],
  enable: ['enable'],
  installGraph: ['plugin', 'install', 'graph'],
  setupGraph: ['graph', 'setup'],
  installBrain: ['plugin', 'install', 'brain'],
  setupBrain: ['brain', 'setup'],
  connectBrain: ['brain', 'connect'],
};

const ACTIONS: readonly SetupAction[] = [
  'installCli',
  'updateCli',
  'setCliPath',
  'login',
  'enable',
  'installGraph',
  'setupGraph',
  'installBrain',
  'setupBrain',
  'connectBrain',
];

export function readSetupAction(value: unknown): SetupAction | undefined {
  return typeof value === 'string' && (ACTIONS as readonly string[]).includes(value) ? (value as SetupAction) : undefined;
}

export function isCliAction(action: SetupAction): action is CliAction {
  return action in SETUP_ARGS;
}

/** Whether an action belongs to the machine rather than to one repository. */
export function isMachineAction(action: SetupAction): boolean {
  return action === 'installCli' || action === 'updateCli' || action === 'setCliPath' || action === 'login';
}

/** What is known about this machine. Undefined means not read yet. */
export interface MachineFacts {
  cli: 'ok' | 'missing' | 'tooOld' | 'unknown';
  cliVersion?: string;
  /** The oldest version the extension works with, for the message about an old CLI. */
  minVersion?: string;
  login?: 'loggedIn' | 'loggedOut' | 'unknown';
  /** Who is logged in, such as `github:octocat`. */
  user?: string;
  graphPlugin?: 'installed' | 'missing' | 'unknown';
}

/** What is known about one repository. Undefined means not known yet. */
export interface RepoFacts {
  root: string;
  name: string;
  enabled?: boolean;
  /** The `origin` remote uses the `entire://` scheme, so the repository is on Entire. */
  hosted?: boolean;
  /** The repository's agent guide is installed and tells agents to use Graph. */
  graphGuide?: boolean;
  brain?: 'loading' | 'pluginMissing' | 'noBrain' | 'built' | 'failed';
  /** `connected` once the brain is bound to its hosted brain on Entire. */
  brainHosted?: string;
}

export type SetupStepState = 'done' | 'needed' | 'optional' | 'blocked' | 'running' | 'checking';

export interface SetupButton {
  label: string;
  action: SetupAction;
  primary?: boolean;
}

/** One row of the Setup view. */
export interface SetupStepView {
  id: SetupStepId;
  title: string;
  state: SetupStepState;
  /** One sentence: what the step gives, what it found, or what it waits for. */
  text: string;
  buttons: SetupButton[];
}

export interface SetupRepoView {
  root: string;
  name: string;
  steps: SetupStepView[];
}

/** Everything the Setup view shows. */
export interface SetupModel {
  machine: SetupStepView[];
  repos: SetupRepoView[];
  /** Every step that applies is done. */
  complete: boolean;
}

/** The key of an action under way: the repository's root, or nothing for the machine, and the action. */
export function runKey(root: string | undefined, action: SetupAction): string {
  return `${isMachineAction(action) ? '' : (root ?? '')}\x00${action}`;
}

const RUNNING = 'Running in the terminal. This list updates when it ends.';
const NEEDS_CLI = 'Needs the Entire CLI.';

function step(
  id: SetupStepId,
  title: string,
  state: SetupStepState,
  text: string,
  buttons: SetupButton[] = [],
): SetupStepView {
  return { id, title, state, text, buttons };
}

/**
 * The steps of the Setup view, from what is known so far. `running` holds the
 * keys of the actions under way in a terminal (see {@link runKey}).
 */
export function setupModel(
  machine: MachineFacts,
  repos: readonly RepoFacts[],
  running: ReadonlySet<string> = new Set(),
): SetupModel {
  const isRunning = (root: string | undefined, ...actions: SetupAction[]): boolean =>
    actions.some((action) => running.has(runKey(root, action)));
  const cliOk = machine.cli === 'ok';

  const cli = ((): SetupStepView => {
    const title = 'Entire CLI';
    if (isRunning(undefined, 'installCli', 'updateCli')) return step('cli', title, 'running', RUNNING);
    switch (machine.cli) {
      case 'ok':
        return step('cli', title, 'done', machine.cliVersion ? `Entire CLI ${machine.cliVersion} is installed.` : 'The Entire CLI is installed.');
      case 'missing':
        return step('cli', title, 'needed', 'Install the Entire CLI. The extension reads checkpoints and sessions through it.', [
          { label: 'Install', action: 'installCli', primary: true },
          { label: 'Set Path', action: 'setCliPath' },
        ]);
      case 'tooOld':
        return step(
          'cli',
          title,
          'needed',
          `Entire CLI ${machine.cliVersion ?? ''} is older than ${machine.minVersion ?? 'this extension needs'}. Update it.`.replace('  ', ' '),
          [
            { label: 'Update', action: 'updateCli', primary: true },
            { label: 'Set Path', action: 'setCliPath' },
          ],
        );
      case 'unknown':
        return step('cli', title, 'checking', 'Looking for the Entire CLI.');
    }
  })();

  const anyHosted = repos.some((repo) => repo.hosted === true);
  const login = ((): SetupStepView => {
    const title = 'Login';
    if (!cliOk) return step('login', title, 'blocked', NEEDS_CLI);
    if (isRunning(undefined, 'login')) return step('login', title, 'running', RUNNING);
    switch (machine.login) {
      case 'loggedIn':
        return step('login', title, 'done', machine.user ? `Logged in to Entire as ${machine.user}.` : 'Logged in to Entire.');
      case 'loggedOut':
        return step(
          'login',
          title,
          anyHosted ? 'needed' : 'optional',
          'Log in to Entire to search sessions on Entire, read trails, and connect the brain.',
          [{ label: 'Log In', action: 'login', primary: true }],
        );
      case 'unknown':
        return step('login', title, 'optional', 'Entire could not say whether you are logged in.', [
          { label: 'Log In', action: 'login', primary: true },
        ]);
      default:
        return step('login', title, 'checking', 'Checking the login.');
    }
  })();

  const repoViews = repos.map((repo): SetupRepoView => {
    const { root } = repo;
    const steps: SetupStepView[] = [];

    const enableTitle = 'Enable Entire';
    if (!cliOk) steps.push(step('enable', enableTitle, 'blocked', NEEDS_CLI));
    else if (isRunning(root, 'enable')) steps.push(step('enable', enableTitle, 'running', RUNNING));
    else if (repo.enabled === true) {
      steps.push(step('enable', enableTitle, 'done', 'Entire records the agent sessions in this repository.'));
    } else if (repo.enabled === false) {
      steps.push(
        step('enable', enableTitle, 'needed', 'Turn on Entire to record agent sessions as checkpoints on your commits.', [
          { label: 'Enable', action: 'enable', primary: true },
        ]),
      );
    } else steps.push(step('enable', enableTitle, 'checking', 'Checking whether Entire is enabled.'));

    const graphTitle = 'Graph';
    if (!cliOk) steps.push(step('graph', graphTitle, 'blocked', NEEDS_CLI));
    else if (isRunning(root, 'installGraph', 'setupGraph')) steps.push(step('graph', graphTitle, 'running', RUNNING));
    else if (machine.graphPlugin === 'missing') {
      steps.push(
        step(
          'graph',
          graphTitle,
          'optional',
          'Install the Graph plugin: a local code graph that agents ask for definitions, callers, and the impact of a change.',
          [{ label: 'Install Plugin', action: 'installGraph', primary: true }],
        ),
      );
    } else if (machine.graphPlugin === 'installed' && repo.graphGuide === true) {
      steps.push(step('graph', graphTitle, 'done', "The repository's agent guide tells agents to use Graph."));
    } else if (machine.graphPlugin === 'installed' && repo.graphGuide === false) {
      steps.push(
        step('graph', graphTitle, 'optional', 'Set up Graph to add its agent guide to AGENTS.md and CLAUDE.md.', [
          { label: 'Set Up', action: 'setupGraph', primary: true },
        ]),
      );
    } else if (machine.graphPlugin === 'unknown') {
      steps.push(
        step('graph', graphTitle, 'optional', 'Entire could not say whether the Graph plugin is installed.', [
          { label: 'Install Plugin', action: 'installGraph', primary: true },
        ]),
      );
    } else steps.push(step('graph', graphTitle, 'checking', 'Checking the Graph plugin.'));

    const brainTitle = 'Brain';
    if (!cliOk) steps.push(step('brain', brainTitle, 'blocked', NEEDS_CLI));
    else if (isRunning(root, 'installBrain', 'setupBrain')) steps.push(step('brain', brainTitle, 'running', RUNNING));
    else {
      switch (repo.brain) {
        case 'built':
          steps.push(step('brain', brainTitle, 'done', 'The brain of this repository is built.'));
          break;
        case 'pluginMissing':
          steps.push(
            step(
              'brain',
              brainTitle,
              'optional',
              'Install the Brain plugin, which builds a brain of the repository from its sessions, history, and docs.',
              [{ label: 'Install Plugin', action: 'installBrain', primary: true }],
            ),
          );
          break;
        case 'noBrain':
          steps.push(
            step('brain', brainTitle, 'optional', 'Build the brain of this repository and keep it up to date in the background.', [
              { label: 'Set Up', action: 'setupBrain', primary: true },
            ]),
          );
          break;
        case 'failed':
          steps.push(
            step('brain', brainTitle, 'optional', 'Entire could not read the brain of this repository. Setting it up again may help.', [
              { label: 'Set Up', action: 'setupBrain', primary: true },
            ]),
          );
          break;
        default:
          steps.push(step('brain', brainTitle, 'checking', 'Checking the brain.'));
      }
    }

    // Only a repository on Entire has a hosted brain to connect to.
    if (repo.hosted === true) {
      const connectTitle = 'Brain Connect';
      if (!cliOk) steps.push(step('connect', connectTitle, 'blocked', NEEDS_CLI));
      else if (isRunning(root, 'connectBrain')) steps.push(step('connect', connectTitle, 'running', RUNNING));
      else if (repo.brainHosted === 'connected') {
        steps.push(step('connect', connectTitle, 'done', "The brain shares its memories with the repository's hosted brain on Entire."));
      } else if (repo.brain !== 'built') {
        steps.push(step('connect', connectTitle, 'blocked', 'Needs the brain. Set up Brain first.'));
      } else if (machine.login !== 'loggedIn') {
        steps.push(step('connect', connectTitle, 'blocked', 'Needs a login to Entire.'));
      } else {
        steps.push(
          step('connect', connectTitle, 'optional', "Connect the brain to the repository's hosted brain on Entire to share memories with your team.", [
            { label: 'Connect', action: 'connectBrain', primary: true },
          ]),
        );
      }
    }
    return { root, name: repo.name, steps };
  });

  const all = [cli, login, ...repoViews.flatMap((repo) => repo.steps)];
  return { machine: [cli, login], repos: repoViews, complete: all.every((view) => view.state === 'done') };
}

/** Which shell a terminal runs, which decides how a path is quoted. */
export type ShellKind = 'posix' | 'powershell' | 'cmd';

/** The kind of the editor's default shell, from its path, such as `/bin/zsh` or `C:\...\pwsh.exe`. */
export function shellKind(shell: string, platform: string): ShellKind {
  const name = (shell.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.exe$/, '');
  if (name === 'pwsh' || name === 'powershell') return 'powershell';
  if (name === 'cmd') return 'cmd';
  // Windows opens PowerShell when no shell is configured.
  if (name === '' && platform === 'win32') return 'powershell';
  return 'posix';
}

/**
 * The program part of a command line: `entire` when the CLI was found on
 * `PATH`, where the terminal finds it too, and its full path otherwise.
 */
export function cliProgram(cliPath: string | undefined, source: string | undefined): string {
  return !cliPath || source === 'path' ? 'entire' : cliPath;
}

/** A program as the shell has to read it: a bare name as is, and a path quoted. */
export function quoteProgram(program: string, kind: ShellKind): string {
  if (program === 'entire') return program;
  switch (kind) {
    case 'posix':
      return /^[A-Za-z0-9_./+-]+$/.test(program) ? program : `'${program.replace(/'/g, `'\\''`)}'`;
    case 'powershell':
      return `& '${program.replace(/'/g, "''")}'`;
    case 'cmd':
      // A Windows path cannot hold a double quote, so this cannot be closed early.
      return `"${program.replace(/"/g, '')}"`;
  }
}

/** The command line for an action that runs `entire`. */
export function setupCommandLine(action: CliAction, program: string, kind: ShellKind): string {
  return [quoteProgram(program, kind), ...SETUP_ARGS[action]].join(' ');
}

/** One way to install or update the CLI, as the installation guide gives it. */
export interface InstallOption {
  label: string;
  /** The exact command line, shown before it runs. */
  commandLine: string;
  description: string;
}

const BREW_INSTALL = 'brew install --cask entireio/tap/entire';
const BREW_UPGRADE = 'brew upgrade --cask entireio/tap/entire';
const INSTALL_SCRIPT = 'curl -fsSL https://entire.com/install.sh | bash';
// Run through PowerShell itself, so the line works from cmd too.
const INSTALL_POWERSHELL = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://entire.com/install.ps1 | iex"';

/**
 * The ways to install the CLI on this platform, or to update it. An update
 * offers Homebrew first when the CLI lives under Homebrew, and the install
 * script first otherwise.
 */
export function installOptions(
  platform: string,
  options: { hasBrew: boolean; update: boolean; cliPath?: string },
): InstallOption[] {
  if (platform === 'win32') {
    return [
      {
        label: options.update ? 'Update with the Install Script' : 'Install with the Install Script',
        commandLine: INSTALL_POWERSHELL,
        description: 'PowerShell',
      },
    ];
  }
  const script: InstallOption = {
    label: options.update ? 'Update with the Install Script' : 'Install with the Install Script',
    commandLine: INSTALL_SCRIPT,
    description: 'Installs to ~/.local/bin',
  };
  if (platform !== 'darwin' || !options.hasBrew) return [script];
  const brew: InstallOption = {
    label: options.update ? 'Update with Homebrew' : 'Install with Homebrew',
    commandLine: options.update ? BREW_UPGRADE : BREW_INSTALL,
    description: 'Homebrew cask',
  };
  const underBrew = /(^|\/)(homebrew|Caskroom|Cellar)\//.test(options.cliPath ?? '');
  return options.update && !underBrew ? [script, brew] : [brew, script];
}
