import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MIN_CLI_VERSION,
  MIN_CLI_VERSION_TEXT,
  isExecutableFile,
  isSupportedVersion,
  locateCli,
  loginShellProbe,
  parseCliVersion,
  type CliVersion,
  type LocateDeps,
} from '../../src/core/cliLocator';
import type { Exec, ExecOptions } from '../../src/core/exec';

const FAKE_ENTIRE = fileURLToPath(new URL('../fake-entire/entire', import.meta.url));

describe('parseCliVersion', () => {
  it('reads the output of `entire version`', () => {
    expect(parseCliVersion('Entire CLI 0.13.3\nGo version: go1.27.4\nOS/Arch: darwin/arm64\n')).toEqual({
      raw: '0.13.3',
      major: 0,
      minor: 13,
      patch: 3,
    });
  });

  it('reads multi-digit components as numbers', () => {
    expect(parseCliVersion('Entire CLI 10.20.30')).toEqual({ raw: '10.20.30', major: 10, minor: 20, patch: 30 });
  });

  it('accepts a leading v', () => {
    expect(parseCliVersion('Entire CLI v1.2.3')).toMatchObject({ major: 1, minor: 2, patch: 3 });
  });

  it.each([
    ['0.14.0-rc.1', 0, 14, 0],
    ['0.12.0-dev', 0, 12, 0],
    ['1.0.0-beta.2+build.5', 1, 0, 0],
    ['0.13.4+abc1234', 0, 13, 4],
  ])('keeps the pre-release suffix of %s in `raw` and out of the numbers', (text, major, minor, patch) => {
    expect(parseCliVersion(`Entire CLI ${text}\n`)).toEqual({ raw: text, major, minor, patch });
  });

  // A build from source has no release number: the CLI's version variable defaults to "dev".
  it('reads a build from source as a development build', () => {
    expect(parseCliVersion('Entire CLI dev\nGo version: go1.27.4\n')).toEqual({
      raw: 'dev',
      major: 0,
      minor: 0,
      patch: 0,
      development: true,
    });
    expect(parseCliVersion('Entire CLI dev')?.development).toBe(true);
  });

  it('does not read other words as a development build', () => {
    expect(parseCliVersion('Entire CLI devious')).toBeUndefined();
    expect(parseCliVersion('Entire CLI unknown')).toBeUndefined();
  });

  it('stops at whitespace after the version', () => {
    expect(parseCliVersion('Entire CLI 0.13.3 (abc1234)')?.raw).toBe('0.13.3');
  });

  it('reads output with Windows line endings', () => {
    expect(parseCliVersion('Entire CLI 0.13.3\r\nGo version: go1.27.4\r\n')).toEqual({
      raw: '0.13.3',
      major: 0,
      minor: 13,
      patch: 3,
    });
  });

  it.each([
    ['empty output', ''],
    ['a shell error', 'zsh: command not found: entire'],
    ['another program', 'git version 2.56.0'],
    ['two components', 'Entire CLI 0.13'],
    ['no number', 'Entire CLI'],
    ['the name in the middle of a line', 'This is not the Entire CLI 0.13.3'],
  ])('returns undefined for %s', (_label, output) => {
    expect(parseCliVersion(output)).toBeUndefined();
  });
});

function version(text: string): CliVersion {
  const parsed = parseCliVersion(`Entire CLI ${text}`);
  if (!parsed) throw new Error(`not a version: ${text}`);
  return parsed;
}

describe('isSupportedVersion', () => {
  it('accepts a development build, which has no number to compare', () => {
    const dev = parseCliVersion('Entire CLI dev');
    expect(dev && isSupportedVersion(dev)).toBe(true);
  });

  it('has a floor of 0.12.0', () => {
    expect(MIN_CLI_VERSION).toEqual({ major: 0, minor: 12, patch: 0 });
    expect(MIN_CLI_VERSION_TEXT).toBe('0.12.0');
  });

  it.each(['0.12.0', '0.12.1', '0.12.99', '0.13.0', '0.13.3', '0.100.0', '1.0.0', '2.3.4', '10.0.0'])(
    'supports %s',
    (text) => {
      expect(isSupportedVersion(version(text))).toBe(true);
    },
  );

  it.each(['0.11.99', '0.11.0', '0.9.50', '0.2.12', '0.0.99', '0.0.0'])('does not support %s', (text) => {
    expect(isSupportedVersion(version(text))).toBe(false);
  });

  it('supports pre-release builds of the minimum version', () => {
    expect(isSupportedVersion(version('0.12.0-rc.1'))).toBe(true);
    expect(isSupportedVersion(version('0.12.0-dev+abc1234'))).toBe(true);
  });

  it('does not support a pre-release of an older version', () => {
    expect(isSupportedVersion(version('0.11.9-rc.1'))).toBe(false);
  });
});

const HOME = path.join(path.sep, 'home', 'dev');
const KNOWN = {
  localBin: path.join(HOME, '.local', 'bin', 'entire'),
  homebrew: path.join('/opt/homebrew/bin', 'entire'),
  usrLocal: path.join('/usr/local/bin', 'entire'),
  goBin: path.join(HOME, 'go', 'bin', 'entire'),
  mise: path.join(HOME, '.local', 'share', 'mise', 'shims', 'entire'),
};

interface FakeOptions {
  executables?: string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  probe?: () => Promise<string | undefined>;
}

function fakeDeps(options: FakeOptions = {}): { deps: LocateDeps; checked: string[] } {
  const checked: string[] = [];
  const executables = new Set(options.executables ?? []);
  const deps: LocateDeps = {
    env: options.env ?? { PATH: ['/usr/bin', '/bin'].join(path.delimiter) },
    platform: options.platform ?? 'linux',
    homedir: HOME,
    isExecutable: async (file) => {
      checked.push(file);
      return executables.has(file);
    },
    ...(options.probe ? { probeLoginShell: options.probe } : {}),
  };
  return { deps, checked };
}

function posixPath(...dirs: string[]): NodeJS.ProcessEnv {
  return { PATH: dirs.join(':') };
}

describe('locateCli with a configured path', () => {
  it('uses the configured path and looks nowhere else', async () => {
    let probed = false;
    const { deps, checked } = fakeDeps({
      executables: ['/custom/entire', path.join('/usr/bin', 'entire'), KNOWN.localBin],
      probe: async () => {
        probed = true;
        return '/probe/entire';
      },
    });

    expect(await locateCli('/custom/entire', deps)).toEqual({ path: '/custom/entire', source: 'setting' });
    expect(checked).toEqual(['/custom/entire']);
    expect(probed).toBe(false);
  });

  it('returns undefined when the configured path points nowhere, without falling back', async () => {
    let probed = false;
    const { deps, checked } = fakeDeps({
      executables: [path.join('/usr/bin', 'entire'), KNOWN.localBin, KNOWN.homebrew, '/probe/entire'],
      probe: async () => {
        probed = true;
        return '/probe/entire';
      },
    });

    expect(await locateCli('/missing/entire', deps)).toBeUndefined();
    expect(checked).toEqual(['/missing/entire']);
    expect(probed).toBe(false);
  });

  it('trims whitespace around the configured path', async () => {
    const { deps } = fakeDeps({ executables: ['/custom/entire'] });
    expect(await locateCli('  /custom/entire \n', deps)).toEqual({ path: '/custom/entire', source: 'setting' });
  });

  it('expands a leading ~ to the home directory', async () => {
    const expanded = path.join(HOME, 'bin', 'entire');
    const { deps } = fakeDeps({ executables: [expanded] });
    expect(await locateCli('~/bin/entire', deps)).toEqual({ path: expanded, source: 'setting' });
  });

  it.each([undefined, '', '   '])('treats %j as not configured', async (configured) => {
    const onPath = path.join('/usr/bin', 'entire');
    const { deps } = fakeDeps({ executables: [onPath] });
    expect(await locateCli(configured, deps)).toEqual({ path: onPath, source: 'path' });
  });
});

describe('locateCli search order', () => {
  it('finds the binary on PATH', async () => {
    const onPath = path.join('/usr/bin', 'entire');
    const { deps } = fakeDeps({ executables: [onPath], env: posixPath('/nope', '/usr/bin', '/bin') });
    expect(await locateCli(undefined, deps)).toEqual({ path: onPath, source: 'path' });
  });

  it('prefers the earlier PATH entry', async () => {
    const first = path.join('/first', 'entire');
    const second = path.join('/second', 'entire');
    const { deps } = fakeDeps({ executables: [second, first], env: posixPath('/first', '/second') });
    expect(await locateCli(undefined, deps)).toEqual({ path: first, source: 'path' });
  });

  it('prefers PATH over the known directories and the login shell', async () => {
    const onPath = path.join('/usr/bin', 'entire');
    let probed = false;
    const { deps } = fakeDeps({
      executables: [onPath, ...Object.values(KNOWN), '/probe/entire'],
      probe: async () => {
        probed = true;
        return '/probe/entire';
      },
    });
    expect(await locateCli(undefined, deps)).toEqual({ path: onPath, source: 'path' });
    expect(probed).toBe(false);
  });

  it('skips empty PATH entries instead of looking in the current directory', async () => {
    const onPath = path.join('/usr/bin', 'entire');
    const { deps, checked } = fakeDeps({ executables: [onPath, 'entire'], env: { PATH: ':/nope::/usr/bin:' } });
    expect(await locateCli(undefined, deps)).toEqual({ path: onPath, source: 'path' });
    expect(checked).not.toContain('entire');
  });

  it.each(Object.entries(KNOWN))('falls back to the known directory %s', async (_name, file) => {
    const { deps } = fakeDeps({ executables: [file] });
    expect(await locateCli(undefined, deps)).toEqual({ path: file, source: 'known' });
  });

  it('searches the known directories when PATH is not set at all', async () => {
    const { deps } = fakeDeps({ executables: [KNOWN.homebrew], env: {} });
    expect(await locateCli(undefined, deps)).toEqual({ path: KNOWN.homebrew, source: 'known' });
  });

  it('prefers a known directory over the login shell', async () => {
    let probed = false;
    const { deps } = fakeDeps({
      executables: [KNOWN.usrLocal, '/probe/entire'],
      probe: async () => {
        probed = true;
        return '/probe/entire';
      },
    });
    expect(await locateCli(undefined, deps)).toEqual({ path: KNOWN.usrLocal, source: 'known' });
    expect(probed).toBe(false);
  });

  it('asks the login shell last', async () => {
    const { deps, checked } = fakeDeps({ executables: ['/probe/entire'], probe: async () => '/probe/entire' });
    expect(await locateCli(undefined, deps)).toEqual({ path: '/probe/entire', source: 'shell' });
    // PATH and every known directory were tried before the shell's answer.
    expect(checked.indexOf('/probe/entire')).toBe(checked.length - 1);
    for (const file of Object.values(KNOWN)) expect(checked).toContain(file);
    expect(checked).toContain(path.join('/usr/bin', 'entire'));
  });

  it('ignores a login-shell answer that is not an absolute path', async () => {
    for (const answer of ['entire', "alias entire='/opt/entire'", 'bin/entire']) {
      const { deps } = fakeDeps({ executables: [answer], probe: async () => answer });
      expect(await locateCli(undefined, deps)).toBeUndefined();
    }
  });

  it('ignores a login-shell answer that is not executable', async () => {
    const { deps } = fakeDeps({ probe: async () => '/probe/entire' });
    expect(await locateCli(undefined, deps)).toBeUndefined();
  });

  it('returns undefined when the login shell finds nothing', async () => {
    const { deps } = fakeDeps({ probe: async () => undefined });
    expect(await locateCli(undefined, deps)).toBeUndefined();
  });

  it('returns undefined when there is no login-shell probe and nothing is found', async () => {
    const { deps } = fakeDeps();
    expect(await locateCli(undefined, deps)).toBeUndefined();
  });

  it('does not look for Windows binary names on POSIX', async () => {
    const { deps, checked } = fakeDeps({ executables: [path.join('/usr/bin', 'entire.exe')] });
    expect(await locateCli(undefined, deps)).toBeUndefined();
    expect(checked.filter((file) => /\.(exe|cmd|bat)$/.test(file))).toEqual([]);
  });
});

describe('locateCli on Windows', () => {
  const tools = 'C:\\tools';
  const other = 'D:\\other bin';
  const windows = (executables: string[], env: NodeJS.ProcessEnv = { PATH: `${other};${tools}` }): FakeOptions => ({
    executables,
    env,
    platform: 'win32',
  });

  it('finds entire.exe on a PATH separated by semicolons', async () => {
    const file = path.join(tools, 'entire.exe');
    const { deps } = fakeDeps(windows([file]));
    expect(await locateCli(undefined, deps)).toEqual({ path: file, source: 'path' });
  });

  // The CLI is started without a shell, and Node refuses to start a .cmd or
  // .bat file that way, so finding one would only fail later.
  it('ignores .cmd and .bat wrappers, which cannot be started without a shell', async () => {
    const exe = path.join(tools, 'entire.exe');
    const cmd = path.join(tools, 'entire.cmd');
    const bat = path.join(tools, 'entire.bat');
    expect(await locateCli(undefined, fakeDeps(windows([bat, cmd, exe])).deps)).toEqual({ path: exe, source: 'path' });
    expect(await locateCli(undefined, fakeDeps(windows([bat, cmd])).deps)).toBeUndefined();
  });

  it('does not match a binary with no extension', async () => {
    const { deps, checked } = fakeDeps(windows([path.join(tools, 'entire')]));
    expect(await locateCli(undefined, deps)).toBeUndefined();
    expect(checked).not.toContain(path.join(tools, 'entire'));
  });

  it('reads the variable when it is spelled Path', async () => {
    const file = path.join(tools, 'entire.exe');
    const { deps } = fakeDeps(windows([file], { Path: `${other};${tools}` }));
    expect(await locateCli(undefined, deps)).toEqual({ path: file, source: 'path' });
  });

  it('does not search the POSIX install directories', async () => {
    const { deps, checked } = fakeDeps(windows(Object.values(KNOWN)));
    expect(await locateCli(undefined, deps)).toBeUndefined();
    expect(checked.some((file) => file.includes('homebrew') || file.includes('mise'))).toBe(false);
  });

  it('still honors a configured path', async () => {
    const configured = 'C:\\Program Files\\Entire\\entire.exe';
    const { deps } = fakeDeps(windows([configured]));
    expect(await locateCli(configured, deps)).toEqual({ path: configured, source: 'setting' });
  });
});

describe('isExecutableFile', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('is true for an executable file', async () => {
    expect(await isExecutableFile(FAKE_ENTIRE)).toBe(true);
  });

  it('is false for a path that does not exist', async () => {
    expect(await isExecutableFile(path.join(os.tmpdir(), 'entire-missing', 'entire'))).toBe(false);
  });

  it('is false for a directory', async () => {
    expect(await isExecutableFile(path.dirname(FAKE_ENTIRE))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('is false for a file without the execute bit', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'entire-locator-'));
    const file = path.join(dir, 'entire');
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o644);
    expect(await isExecutableFile(file)).toBe(false);
    chmodSync(file, 0o755);
    expect(await isExecutableFile(file)).toBe(true);
  });
});

interface ShellCall {
  file: string;
  args: readonly string[];
  options: ExecOptions;
}

/**
 * Stands in for a login shell. It prints `banner`, then runs the probe's
 * `printf` with `found` as the result of `command -v entire`, then `trailer`.
 */
function fakeShell(found: string, banner = '', trailer = ''): { calls: ShellCall[]; exec: Exec } {
  const calls: ShellCall[] = [];
  const exec: Exec = async (file, args, options) => {
    calls.push({ file, args, options });
    const format = /printf '([^']*)'/.exec(args.join(' '))?.[1] ?? '';
    const stdout = `${banner}${format.replace('%s', found)}${trailer}`;
    return {
      code: 0,
      stdout: Buffer.from(stdout),
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      bytes: Buffer.byteLength(stdout),
    };
  };
  return { calls, exec };
}

describe('loginShellProbe', () => {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' };

  it('runs the user shell as an interactive login shell and returns what it found', async () => {
    const shell = fakeShell('/opt/entire/bin/entire');
    const probe = loginShellProbe(shell.exec, env, '/work');

    expect(await probe()).toBe('/opt/entire/bin/entire');
    expect(shell.calls).toHaveLength(1);
    const call = shell.calls[0];
    expect(call?.file).toBe('/bin/zsh');
    expect(call?.args[0]).toMatch(/^-[a-z]*$/);
    for (const flag of ['i', 'l', 'c']) expect(call?.args[0]).toContain(flag);
    expect(call?.args[1]).toContain('command -v entire');
    expect(call?.options.cwd).toBe('/work');
    expect(call?.options.env).toBe(env);
    expect(call?.options.timeoutMs).toBeGreaterThan(0);
    expect(call?.options.timeoutMs).toBeLessThanOrEqual(10_000);
  });

  it('is not misled by text that the shell profile prints', async () => {
    const shell = fakeShell(
      '/opt/entire/bin/entire',
      'Welcome back!\n/usr/local/bin/entire is deprecated\n',
      '\nLast login: today\n',
    );
    expect(await loginShellProbe(shell.exec, env, '/work')()).toBe('/opt/entire/bin/entire');
  });

  it('trims whitespace around the answer', async () => {
    const shell = fakeShell('  /opt/entire/bin/entire\n');
    expect(await loginShellProbe(shell.exec, env, '/work')()).toBe('/opt/entire/bin/entire');
  });

  it('returns undefined when the shell does not know the command', async () => {
    const shell = fakeShell('');
    expect(await loginShellProbe(shell.exec, env, '/work')()).toBeUndefined();
  });

  it('returns undefined when the shell printed no marked answer', async () => {
    const exec: Exec = async () => ({
      code: 1,
      stdout: Buffer.from('zsh: permission denied\n/usr/bin/entire\n'),
      stderr: '',
      timedOut: false,
      aborted: false,
      truncated: false,
      bytes: 39,
    });
    expect(await loginShellProbe(exec, env, '/work')()).toBeUndefined();
  });

  it.each([
    ['unset', {}],
    ['empty', { SHELL: '' }],
    ['not an absolute path', { SHELL: 'zsh' }],
  ])('does not run anything when SHELL is %s', async (_label, shellEnv) => {
    const shell = fakeShell('/opt/entire/bin/entire');
    expect(await loginShellProbe(shell.exec, shellEnv, '/work')()).toBeUndefined();
    expect(shell.calls).toEqual([]);
  });

  it('feeds locateCli as the last resort', async () => {
    const shell = fakeShell('/opt/entire/bin/entire', 'banner\n');
    const { deps } = fakeDeps({
      executables: ['/opt/entire/bin/entire'],
      probe: loginShellProbe(shell.exec, env, '/work'),
    });
    expect(await locateCli(undefined, deps)).toEqual({ path: '/opt/entire/bin/entire', source: 'shell' });
  });
});
