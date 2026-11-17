import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fail, ok, type Result } from './errors';

export interface ServerOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Reads one line of stdout, and returns the server's address once a line carries it. */
  ready: (line: string) => string | undefined;
  /** How long the program may take to print its address. */
  readyTimeoutMs: number;
  /** Gives up on a start that is still under way. It does not stop a server that has started. */
  signal?: AbortSignal;
}

/** A local server that this process started and has to stop. */
export interface RunningServer {
  url: string;
  /** Asks the server to stop, and forces it after a grace period. Safe to call more than once. */
  stop(): void;
  /** Resolves once the process is gone, however it ended. */
  exited: Promise<void>;
}

export type StartServer = (file: string, args: readonly string[], options: ServerOptions) => Promise<Result<RunningServer>>;

const KILL_GRACE_MS = 2000;
/** Most stderr kept for the reason a start failed. */
const STDERR_CAP = 16 * 1024;
/** A line longer than this is not the one that carries the address. */
const LINE_CAP = 64 * 1024;

/**
 * Starts a program that serves until it is stopped, and resolves once it has
 * printed its address. `exec` runs a program to its end, which a server does
 * not have.
 *
 * On POSIX the program gets its own process group, so stopping it also stops
 * what it started: the Entire CLI runs a plugin as a child of its own.
 *
 * After the address arrives the output is still read, and thrown away. A
 * pipe that nobody reads fills up and stalls the program that writes to it.
 */
export const startServer: StartServer = (file, args, options) =>
  new Promise<Result<RunningServer>>((resolve) => {
    if (options.signal?.aborted) {
      resolve(fail('aborted', 'Cancelled.'));
      return;
    }
    const posix = process.platform !== 'win32';
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: posix,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let gone = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let stderr = '';
    let pending = '';
    const decoder = new StringDecoder('utf8');
    let markExited: () => void = () => {};
    const exited = new Promise<void>((done) => {
      markExited = done;
    });

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined || gone) return;
      try {
        if (posix) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process has already exited.
      }
    };
    const stop = (): void => {
      if (gone) return;
      kill('SIGTERM');
      forceTimer ??= setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      forceTimer.unref();
    };

    const timer = setTimeout(() => {
      settle(fail('timeout', 'The program took too long to start.', stderr.trim()));
      stop();
    }, options.readyTimeoutMs);
    timer.unref();
    const onAbort = (): void => {
      settle(fail('aborted', 'Cancelled.'));
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    function settle(result: Result<RunningServer>): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (settled) return;
      pending += decoder.write(chunk);
      let end = pending.indexOf('\n');
      while (end >= 0 && !settled) {
        const url = options.ready(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
        if (url !== undefined) settle(ok({ url, stop, exited }));
        end = pending.indexOf('\n');
      }
      if (settled || pending.length > LINE_CAP) pending = '';
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (settled || stderr.length >= STDERR_CAP) return;
      stderr += chunk.toString('utf8').slice(0, STDERR_CAP - stderr.length);
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      gone = true;
      settle(fail('cliMissing', 'The program could not be started.', error.message));
      markExited();
    });
    child.on('close', (code) => {
      gone = true;
      if (forceTimer) clearTimeout(forceTimer);
      settle(fail('exit', 'The program stopped before it was ready.', stderr.trim() || `exit code ${code ?? 'none'}`));
      markExited();
    });
  });
