import { describe, expect, it } from 'vitest';
import {
  cliProgram,
  installOptions,
  isCliAction,
  isMachineAction,
  quoteProgram,
  readSetupAction,
  runKey,
  SETUP_ARGS,
  setupCommandLine,
  setupModel,
  shellKind,
  type MachineFacts,
  type RepoFacts,
  type SetupModel,
  type SetupStepView,
} from '../../src/core/setup';

const ROOT = '/repos/widget';

const machine = (overrides: Partial<MachineFacts> = {}): MachineFacts => ({
  cli: 'ok',
  cliVersion: '0.13.4',
  minVersion: '0.12.0',
  login: 'loggedIn',
  user: 'github:octocat',
  graphPlugin: 'installed',
  ...overrides,
});

const repo = (overrides: Partial<RepoFacts> = {}): RepoFacts => ({
  root: ROOT,
  name: 'widget',
  enabled: true,
  hosted: true,
  graphGuide: true,
  brain: 'built',
  brainHosted: 'connected',
  ...overrides,
});

/** Each step as "id: state", with its buttons' actions. */
function summary(model: SetupModel): string[] {
  const line = (view: SetupStepView): string =>
    `${view.id}: ${view.state}${view.buttons.length > 0 ? ` [${view.buttons.map((button) => button.action).join(', ')}]` : ''}`;
  return [...model.machine.map(line), ...model.repos.flatMap((entry) => entry.steps.map(line))];
}

describe('setupModel', () => {
  it('says everything is done for a repository that is fully set up', () => {
    const model = setupModel(machine(), [repo()]);
    expect(summary(model)).toEqual([
      'cli: done',
      'login: done',
      'enable: done',
      'graph: done',
      'brain: done',
      'connect: done',
    ]);
    expect(model.complete).toBe(true);
    expect(model.machine[0]?.text).toBe('Entire CLI 0.13.4 is installed.');
    expect(model.machine[1]?.text).toBe('Logged in to Entire as github:octocat.');
  });

  it('offers to install the CLI, and blocks every other step on it', () => {
    const model = setupModel({ cli: 'missing' }, [repo({ enabled: undefined, brain: undefined, graphGuide: undefined, brainHosted: undefined })]);
    expect(summary(model)).toEqual([
      'cli: needed [installCli, setCliPath]',
      'login: blocked',
      'enable: blocked',
      'graph: blocked',
      'brain: blocked',
      'connect: blocked',
    ]);
    expect(model.complete).toBe(false);
    expect(model.repos[0]?.steps.every((view) => view.text === 'Needs the Entire CLI.')).toBe(true);
  });

  it('offers to update a CLI that is too old, and names the versions', () => {
    const model = setupModel({ cli: 'tooOld', cliVersion: '0.11.9', minVersion: '0.12.0' }, [repo()]);
    expect(model.machine[0]).toMatchObject({ state: 'needed', text: 'Entire CLI 0.11.9 is older than 0.12.0. Update it.' });
    expect(model.machine[0]?.buttons.map((button) => button.action)).toEqual(['updateCli', 'setCliPath']);
  });

  it('offers each step that is missing in a repository where Entire is not enabled', () => {
    const model = setupModel(machine({ login: 'loggedOut', user: undefined, graphPlugin: 'missing' }), [
      repo({ enabled: false, graphGuide: false, brain: 'pluginMissing', brainHosted: undefined }),
    ]);
    expect(summary(model)).toEqual([
      'cli: done',
      // The repository is on Entire, so its trails and hosted brain need the login.
      'login: needed [login]',
      'enable: needed [enable]',
      'graph: optional [installGraph]',
      'brain: optional [installBrain]',
      'connect: blocked',
    ]);
  });

  it('offers to set up Graph and Brain once their plugins are installed', () => {
    const model = setupModel(machine(), [repo({ graphGuide: false, brain: 'noBrain', brainHosted: undefined })]);
    expect(summary(model).slice(3)).toEqual(['graph: optional [setupGraph]', 'brain: optional [setupBrain]', 'connect: blocked']);
    expect(model.repos[0]?.steps[3]?.text).toBe('Needs the brain. Set up Brain first.');
  });

  it('waits for a login before it offers to connect the brain, and then offers it', () => {
    const loggedOut = setupModel(machine({ login: 'loggedOut' }), [repo({ brainHosted: 'disconnected' })]);
    expect(loggedOut.repos[0]?.steps[3]).toMatchObject({ id: 'connect', state: 'blocked', text: 'Needs a login to Entire.' });
    const loggedIn = setupModel(machine(), [repo({ brainHosted: 'disconnected' })]);
    expect(loggedIn.repos[0]?.steps[3]).toMatchObject({ id: 'connect', state: 'optional' });
    expect(loggedIn.repos[0]?.steps[3]?.buttons).toEqual([{ label: 'Connect', action: 'connectBrain', primary: true }]);
  });

  it('leaves out Brain Connect for a repository that is not on Entire, and does not ask for the login there', () => {
    const model = setupModel(machine({ login: 'loggedOut' }), [repo({ hosted: false, brainHosted: undefined })]);
    expect(model.repos[0]?.steps.map((view) => view.id)).toEqual(['enable', 'graph', 'brain']);
    expect(model.machine[1]?.state).toBe('optional');
  });

  it('says it is checking what it has not read yet', () => {
    const model = setupModel({ cli: 'ok' }, [{ root: ROOT, name: 'widget' }]);
    expect(summary(model)).toEqual(['cli: done', 'login: checking', 'enable: checking', 'graph: checking', 'brain: checking']);
    expect(setupModel({ cli: 'unknown' }, []).machine[0]?.state).toBe('checking');
  });

  it('offers the step again when what it depends on could not be read', () => {
    const model = setupModel(machine({ login: 'unknown', graphPlugin: 'unknown' }), [repo({ brain: 'failed', hosted: false })]);
    expect(summary(model)).toEqual([
      'cli: done',
      'login: optional [login]',
      'enable: done',
      'graph: optional [installGraph]',
      'brain: optional [setupBrain]',
    ]);
  });

  it('shows a step as running while its command runs, for its own repository only', () => {
    const other = '/repos/other';
    const running = new Set([runKey(ROOT, 'enable'), runKey(undefined, 'login'), runKey(other, 'setupBrain')]);
    const model = setupModel(
      machine({ login: 'loggedOut' }),
      [
        repo({ enabled: false, brain: 'noBrain', brainHosted: undefined }),
        repo({ root: other, name: 'other', enabled: false, brainHosted: undefined }),
      ],
      running,
    );
    expect(model.machine[1]?.state).toBe('running');
    expect(model.repos[0]?.steps.map((view) => view.state)).toEqual(['running', 'done', 'optional', 'blocked']);
    expect(model.repos[1]?.steps.map((view) => view.state)).toEqual(['needed', 'done', 'running', 'blocked']);
    // A running step offers no button: its command is in the terminal.
    expect(model.machine[1]?.buttons).toEqual([]);
  });
});

describe('runKey', () => {
  it('ignores the repository for a step of the machine', () => {
    expect(runKey(ROOT, 'login')).toBe(runKey(undefined, 'login'));
    expect(runKey(ROOT, 'enable')).not.toBe(runKey('/repos/other', 'enable'));
  });
});

describe('actions', () => {
  it('reads only the actions it knows', () => {
    expect(readSetupAction('enable')).toBe('enable');
    expect(readSetupAction('connectBrain')).toBe('connectBrain');
    expect(readSetupAction('rm -rf')).toBeUndefined();
    expect(readSetupAction('constructor')).toBeUndefined();
    expect(readSetupAction(undefined)).toBeUndefined();
  });

  it('runs entire with constant arguments, and the install steps without it', () => {
    expect(SETUP_ARGS).toEqual({
      login: ['login'],
      enable: ['enable'],
      installGraph: ['plugin', 'install', 'graph'],
      setupGraph: ['graph', 'setup'],
      installBrain: ['plugin', 'install', 'brain'],
      setupBrain: ['brain', 'setup'],
      connectBrain: ['brain', 'connect'],
    });
    expect(isCliAction('enable')).toBe(true);
    expect(isCliAction('installCli')).toBe(false);
    expect(isCliAction('setCliPath')).toBe(false);
    expect(isMachineAction('login')).toBe(true);
    expect(isMachineAction('connectBrain')).toBe(false);
  });
});

describe('command lines', () => {
  it('names the CLI by name when it is on PATH, and by its path otherwise', () => {
    expect(cliProgram('/usr/local/bin/entire', 'path')).toBe('entire');
    expect(cliProgram('/home/me/.local/bin/entire', 'known')).toBe('/home/me/.local/bin/entire');
    expect(cliProgram('/opt/tools/entire', 'setting')).toBe('/opt/tools/entire');
    expect(cliProgram(undefined, undefined)).toBe('entire');
  });

  it('quotes a path for each kind of shell, so that nothing in it is read as shell syntax', () => {
    expect(quoteProgram('/home/me/.local/bin/entire', 'posix')).toBe('/home/me/.local/bin/entire');
    expect(quoteProgram('/Users/Jo Doe/bin/entire', 'posix')).toBe(`'/Users/Jo Doe/bin/entire'`);
    expect(quoteProgram(`/tmp/it's $(rm -rf ~)/entire`, 'posix')).toBe(`'/tmp/it'\\''s $(rm -rf ~)/entire'`);
    expect(quoteProgram(`C:\\Users\\O'Neil\\entire.exe`, 'powershell')).toBe(`& 'C:\\Users\\O''Neil\\entire.exe'`);
    expect(quoteProgram('C:\\Program Files\\Entire\\entire.exe', 'cmd')).toBe('"C:\\Program Files\\Entire\\entire.exe"');
    expect(quoteProgram('entire', 'powershell')).toBe('entire');
  });

  it('builds the command line of each step from the program and its arguments', () => {
    expect(setupCommandLine('enable', 'entire', 'posix')).toBe('entire enable');
    expect(setupCommandLine('installGraph', '/Users/Jo Doe/bin/entire', 'posix')).toBe(`'/Users/Jo Doe/bin/entire' plugin install graph`);
    expect(setupCommandLine('connectBrain', 'C:\\entire\\entire.exe', 'powershell')).toBe(`& 'C:\\entire\\entire.exe' brain connect`);
  });

  it('tells shells apart by their path', () => {
    expect(shellKind('/bin/zsh', 'darwin')).toBe('posix');
    expect(shellKind('/usr/bin/fish', 'linux')).toBe('posix');
    expect(shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'win32')).toBe('powershell');
    expect(shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'win32')).toBe('powershell');
    expect(shellKind('C:\\Windows\\System32\\cmd.exe', 'win32')).toBe('cmd');
    expect(shellKind('', 'win32')).toBe('powershell');
    expect(shellKind('C:\\Program Files\\Git\\bin\\bash.exe', 'win32')).toBe('posix');
  });
});

describe('installOptions', () => {
  it('offers Homebrew first on a Mac that has it, then the install script', () => {
    expect(installOptions('darwin', { hasBrew: true, update: false }).map((option) => option.commandLine)).toEqual([
      'brew install --cask entireio/tap/entire',
      'curl -fsSL https://entire.com/install.sh | bash',
    ]);
    expect(installOptions('darwin', { hasBrew: false, update: false }).map((option) => option.commandLine)).toEqual([
      'curl -fsSL https://entire.com/install.sh | bash',
    ]);
  });

  it('offers the install script on Linux, and PowerShell on Windows', () => {
    expect(installOptions('linux', { hasBrew: true, update: false }).map((option) => option.commandLine)).toEqual([
      'curl -fsSL https://entire.com/install.sh | bash',
    ]);
    expect(installOptions('win32', { hasBrew: false, update: false })[0]?.commandLine).toBe(
      'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://entire.com/install.ps1 | iex"',
    );
  });

  it('updates the way the CLI was installed first', () => {
    const brewFirst = installOptions('darwin', { hasBrew: true, update: true, cliPath: '/opt/homebrew/bin/entire' });
    expect(brewFirst.map((option) => option.commandLine)).toEqual([
      'brew upgrade --cask entireio/tap/entire',
      'curl -fsSL https://entire.com/install.sh | bash',
    ]);
    const scriptFirst = installOptions('darwin', { hasBrew: true, update: true, cliPath: '/Users/me/.local/bin/entire' });
    expect(scriptFirst.map((option) => option.label)).toEqual(['Update with the Install Script', 'Update with Homebrew']);
  });
});
