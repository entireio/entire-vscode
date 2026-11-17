import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Exec } from './exec';

export interface CliVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Built from source, so there is no release number to compare. */
  development?: boolean;
}

/** The oldest CLI whose JSON output this extension was written against. */
export const MIN_CLI_VERSION: Readonly<Pick<CliVersion, 'major' | 'minor' | 'patch'>> = {
  major: 0,
  minor: 12,
  patch: 0,
};

export const MIN_CLI_VERSION_TEXT = `${MIN_CLI_VERSION.major}.${MIN_CLI_VERSION.minor}.${MIN_CLI_VERSION.patch}`;

/** Reads the first line of `entire version`, for example `Entire CLI 0.13.3`. */
export function parseCliVersion(output: string): CliVersion | undefined {
  const match = /^Entire CLI v?(\d+)\.(\d+)\.(\d+)(\S*)/m.exec(output);
  if (!match) {
    // A build from source reports "dev" where a release reports a number.
    if (/^Entire CLI dev\s*$/m.test(output)) return { raw: 'dev', major: 0, minor: 0, patch: 0, development: true };
    return undefined;
  }
  const [, major, minor, patch, suffix] = match;
  return {
    raw: `${major}.${minor}.${patch}${suffix ?? ''}`,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
  };
}

/** Pre-release builds of the minimum version count as supported. */
export function isSupportedVersion(version: CliVersion): boolean {
  if (version.development) return true;
  const { major, minor, patch } = MIN_CLI_VERSION;
  if (version.major !== major) return version.major > major;
  if (version.minor !== minor) return version.minor > minor;
  return version.patch >= patch;
}

export type CliSource = 'setting' | 'path' | 'known' | 'shell';

export interface LocatedCli {
  path: string;
  source: CliSource;
}

export interface LocateDeps {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  isExecutable: (file: string) => Promise<boolean>;
  /** Asks the user's login shell where `entire` is. Skipped when absent. */
  probeLoginShell?: () => Promise<string | undefined>;
}

export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function binaryNames(platform: NodeJS.Platform): string[] {
  // Only the executable: Node refuses to start a .cmd or .bat file without a shell.
  return platform === 'win32' ? ['entire.exe'] : ['entire'];
}

function knownDirs(deps: LocateDeps): string[] {
  if (deps.platform === 'win32') return [];
  return [
    path.join(deps.homedir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(deps.homedir, 'go', 'bin'),
    path.join(deps.homedir, '.local', 'share', 'mise', 'shims'),
  ];
}

/**
 * Finds the Entire CLI. A configured path wins and is never second-guessed:
 * when it points nowhere, the result is undefined so the UI can say so.
 */
export async function locateCli(configured: string | undefined, deps: LocateDeps): Promise<LocatedCli | undefined> {
  const setting = configured?.trim();
  if (setting) {
    const expanded = setting.startsWith('~') ? path.join(deps.homedir, setting.slice(1)) : setting;
    return (await deps.isExecutable(expanded)) ? { path: expanded, source: 'setting' } : undefined;
  }

  const names = binaryNames(deps.platform);
  const pathVar = deps.env.PATH ?? deps.env.Path ?? '';
  const separator = deps.platform === 'win32' ? ';' : ':';
  const search = async (dirs: string[], source: CliSource): Promise<LocatedCli | undefined> => {
    for (const dir of dirs) {
      if (!dir) continue;
      for (const name of names) {
        const candidate = path.join(dir, name);
        if (await deps.isExecutable(candidate)) return { path: candidate, source };
      }
    }
    return undefined;
  };

  const onPath = await search(pathVar.split(separator), 'path');
  if (onPath) return onPath;
  const known = await search(knownDirs(deps), 'known');
  if (known) return known;

  const probed = await deps.probeLoginShell?.();
  if (probed && path.isAbsolute(probed) && (await deps.isExecutable(probed))) {
    return { path: probed, source: 'shell' };
  }
  return undefined;
}

const START = '__ENTIRE_PATH_START__';
const END = '__ENTIRE_PATH_END__';

/**
 * A GUI-launched editor can miss PATH entries that the user's shell profile
 * adds. This asks an interactive login shell, and marks the answer so that
 * banner text printed by the profile cannot be mistaken for it.
 */
export function loginShellProbe(exec: Exec, env: NodeJS.ProcessEnv, cwd: string): () => Promise<string | undefined> {
  return async () => {
    const shell = env.SHELL;
    if (!shell || !path.isAbsolute(shell)) return undefined;
    const script = `printf '${START}%s${END}' "$(command -v entire)"`;
    const result = await exec(shell, ['-ilc', script], { cwd, timeoutMs: 5000, env });
    const match = new RegExp(`${START}(.*?)${END}`, 's').exec(result.stdout.toString('utf8'));
    const found = match?.[1]?.trim();
    return found ? found : undefined;
  };
}
