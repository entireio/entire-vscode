import { spawn } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';

export interface ExecOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Stop collecting stdout past this many bytes and kill the process. */
  maxBytes?: number;
  /**
   * Write stdout to this file instead of collecting it, for output that can be
   * too large to hold in memory. `stdout` is then empty, `bytes` says how much
   * was written, and `maxBytes` does not apply. The file is created with
   * access for its owner only.
   */
  stdoutFile?: string;
}

export interface ExecResult {
  /** Exit code, or null when the process was killed or never started. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  /** stdout hit `maxBytes`. */
  truncated: boolean;
  /** How many bytes of stdout the process produced before it stopped or was cut off. */
  bytes: number;
  /** Set when the process could not be started, for example ENOENT. */
  spawnError?: NodeJS.ErrnoException;
  /** Set when stdout could not be written to `stdoutFile`, for example on a full disk. */
  writeError?: Error;
}

export type Exec = (file: string, args: readonly string[], options: ExecOptions) => Promise<ExecResult>;

const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;
const KILL_GRACE_MS = 2000;

/**
 * Runs a program without a shell and collects its output, or streams it to a
 * file.
 *
 * On POSIX the child gets its own process group, so a timeout or abort also
 * stops the git transports that the Entire CLI starts.
 */
export const exec: Exec = (file, args, options) =>
  new Promise<ExecResult>((resolve) => {
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const posix = process.platform !== 'win32';
    const chunks: Buffer[] = [];
    let bytes = 0;
    // Collected as bytes and decoded once, so a character split across chunks survives.
    const stderrChunks: Buffer[] = [];
    let stderrSize = 0;
    let timedOut = false;
    let aborted = false;
    let truncated = false;
    let settled = false;
    let writeError: Error | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    let sink: WriteStream | undefined;
    /** Resolves once the output file has been flushed and closed. */
    let sinkClosed: Promise<void> = Promise.resolve();

    if (options.signal?.aborted) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: '', timedOut: false, aborted: true, truncated: false, bytes: 0 });
      return;
    }

    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: posix,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const kill = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (posix) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process has already exited.
      }
    };

    const stop = (): void => {
      kill('SIGTERM');
      forceTimer ??= setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      forceTimer.unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null, spawnError?: NodeJS.ErrnoException): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      options.signal?.removeEventListener('abort', onAbort);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      const result: ExecResult = { code, stdout: Buffer.concat(chunks), stderr, timedOut, aborted, truncated, bytes };
      if (spawnError) result.spawnError = spawnError;
      if (writeError) result.writeError = writeError;
      resolve(result);
    };

    if (options.stdoutFile !== undefined && child.stdout) {
      const target = createWriteStream(options.stdoutFile, { mode: 0o600 });
      sink = target;
      sinkClosed = new Promise((closed) => target.once('close', () => closed()));
      target.on('error', (error) => {
        writeError ??= error;
        stop();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
      });
      // `pipe` waits for the file when the process writes faster than the disk takes it.
      child.stdout.pipe(target);
    } else {
      child.stdout?.on('data', (chunk: Buffer) => {
        if (truncated) return;
        bytes += chunk.length;
        if (bytes > maxBytes) {
          truncated = true;
          stop();
          return;
        }
        chunks.push(chunk);
      });
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrSize >= STDERR_CAP) return;
      const kept = chunk.subarray(0, STDERR_CAP - stderrSize);
      stderrChunks.push(kept);
      stderrSize += kept.length;
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      // A process that never started leaves the output file open, and the
      // file may not even exist yet: it is opened in the background. The
      // answer waits until the file is closed, so the caller can remove it or
      // its directory without the file turning up afterwards.
      sink?.destroy();
      void sinkClosed.then(() => finish(null, error));
    });
    // The process can exit before its last output has reached the file.
    child.on('close', (code) => void sinkClosed.then(() => finish(code)));
  });
