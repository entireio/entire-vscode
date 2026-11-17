import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exec, type ExecOptions } from '../../src/core/exec';

const NODE = process.execPath;
const CWD = realpathSync(os.tmpdir());
const posix = process.platform !== 'win32';

/** Runs a Node script in a child process through the code under test. */
function runNode(script: string, options: Partial<ExecOptions> = {}, args: string[] = []) {
  return exec(NODE, ['-e', script, '--', ...args], { cwd: CWD, timeoutMs: 15_000, ...options });
}

/** A script that stays alive until it is killed. */
const HANG = 'setInterval(() => {}, 1000);';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilDead(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !isAlive(pid);
}

describe('exec', () => {
  it('collects stdout as bytes and reports a clean exit', async () => {
    const result = await runNode('process.stdout.write("hello\\n")');
    expect(result.stdout).toBeInstanceOf(Buffer);
    expect(result.stdout.toString('utf8')).toBe('hello\n');
    expect(result).toMatchObject({ code: 0, stderr: '', timedOut: false, aborted: false, truncated: false });
    expect(result.spawnError).toBeUndefined();
  });

  it('does not decode stdout, so binary output survives', async () => {
    const result = await runNode('process.stdout.write(Buffer.from([0, 255, 254, 10, 13, 128]))');
    expect([...result.stdout]).toEqual([0, 255, 254, 10, 13, 128]);
  });

  it('reports a non-zero exit code', async () => {
    const result = await runNode('process.exit(3)');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('captures stderr separately from stdout', async () => {
    const result = await runNode('process.stderr.write("warning: careful\\n"); process.stdout.write("data"); process.exit(2)');
    expect(result.stderr).toBe('warning: careful\n');
    expect(result.stdout.toString('utf8')).toBe('data');
    expect(result.code).toBe(2);
  });

  it('caps the stderr it keeps', async () => {
    const result = await runNode('process.stderr.write("e".repeat(300000))');
    expect(result.code).toBe(0);
    expect(result.stderr.length).toBeGreaterThan(0);
    expect(result.stderr.length).toBeLessThanOrEqual(64 * 1024);
    expect(result.stderr).toMatch(/^e+$/);
  });

  // stderr is decoded one chunk at a time, so a character whose bytes arrive
  // in two chunks becomes two replacement characters.
  it('decodes a multi-byte character on stderr that arrives split across chunks', async () => {
    const script = `
      const bytes = Buffer.from('é');
      process.stderr.write(bytes.subarray(0, 1));
      setTimeout(() => process.stderr.write(bytes.subarray(1)), 500);
    `;
    const result = await runNode(script);
    expect(result.stderr).toBe('é');
  });

  it('runs the program in the given directory', async () => {
    const result = await runNode('process.stdout.write(process.cwd())');
    expect(realpathSync(result.stdout.toString('utf8'))).toBe(CWD);
  });

  it('passes the given environment, and the parent environment by default', async () => {
    const script = 'process.stdout.write(String(process.env.EXEC_TEST_VALUE))';
    const given = await runNode(script, { env: { ...process.env, EXEC_TEST_VALUE: 'from-options' } });
    expect(given.stdout.toString('utf8')).toBe('from-options');

    process.env.EXEC_TEST_VALUE = 'from-parent';
    try {
      const inherited = await runNode(script);
      expect(inherited.stdout.toString('utf8')).toBe('from-parent');
    } finally {
      delete process.env.EXEC_TEST_VALUE;
    }
  });

  it('passes arguments without a shell', async () => {
    const tricky = ['$(echo injected)', 'a b', '; echo injected', '`id`', '"quoted"', '*'];
    const result = await runNode('process.stdout.write(JSON.stringify(process.argv.slice(1)))', {}, tricky);
    expect(JSON.parse(result.stdout.toString('utf8'))).toEqual(tricky);
  });

  it('gives the child no stdin to wait on', async () => {
    const result = await runNode(
      'process.stdin.on("data", () => {}); process.stdin.on("end", () => process.stdout.write("stdin closed"));',
      { timeoutMs: 5000 },
    );
    expect(result.timedOut).toBe(false);
    expect(result.stdout.toString('utf8')).toBe('stdin closed');
  });
});

describe('exec timeout', () => {
  it('kills a process that runs past the timeout', async () => {
    const started = Date.now();
    const result = await runNode(`process.stdout.write(String(process.pid)); ${HANG}`, { timeoutMs: 400 });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    expect(result.aborted).toBe(false);
    expect(result.truncated).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(result.stdout.toString('utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(await waitUntilDead(pid, 3000)).toBe(true);
  });

  it('does not flag a process that finishes in time', async () => {
    const result = await runNode('setTimeout(() => process.stdout.write("done"), 50)', { timeoutMs: 10_000 });
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.toString('utf8')).toBe('done');
  });

  it('keeps the output that arrived before the timeout', async () => {
    const result = await runNode(`process.stdout.write("partial"); process.stderr.write("still working"); ${HANG}`, {
      timeoutMs: 600,
    });
    expect(result.timedOut).toBe(true);
    expect(result.stdout.toString('utf8')).toBe('partial');
    expect(result.stderr).toBe('still working');
  });

  it.skipIf(!posix)('also stops the processes that the program started', async () => {
    // The grandchild inherits stdout, so the call cannot finish while it lives.
    const script = `
      const { spawn } = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(HANG)}], { stdio: 'inherit' });
      process.stdout.write(String(grandchild.pid));
      ${HANG}
    `;
    const started = Date.now();
    const result = await runNode(script, { timeoutMs: 800 });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const grandchild = Number(result.stdout.toString('utf8'));
    expect(grandchild).toBeGreaterThan(0);
    expect(await waitUntilDead(grandchild, 3000)).toBe(true);
  });

  it.skipIf(!posix)('force-kills a process that ignores the first signal', async () => {
    const script = `process.on('SIGTERM', () => {}); process.stdout.write(String(process.pid)); ${HANG}`;
    const result = await runNode(script, { timeoutMs: 1000 });

    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    const pid = Number(result.stdout.toString('utf8'));
    expect(await waitUntilDead(pid, 3000)).toBe(true);
  });
});

describe('exec abort', () => {
  it('kills the process when the signal aborts', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runNode(`process.stdout.write(String(process.pid)); ${HANG}`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 400);
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
    const pid = Number(result.stdout.toString('utf8'));
    expect(await waitUntilDead(pid, 3000)).toBe(true);
  });

  it('does not start the process when the signal is already aborted', async () => {
    const marker = path.join(CWD, `exec-test-marker-${process.pid}-${Date.now()}`);
    const result = await runNode(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, {
      signal: AbortSignal.abort(),
    });

    expect(result).toMatchObject({ aborted: true, code: null, timedOut: false, truncated: false, stderr: '' });
    expect(result.stdout).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const ran = existsSync(marker);
    rmSync(marker, { force: true });
    expect(ran).toBe(false);
  });

  it('does not report an abort that happens after the process has finished', async () => {
    const controller = new AbortController();
    const result = await runNode('process.stdout.write("done")', { signal: controller.signal });
    controller.abort();
    expect(result.aborted).toBe(false);
    expect(result.code).toBe(0);
  });
});

describe('exec maxBytes', () => {
  it('stops collecting and kills the process once stdout passes the limit', async () => {
    const limit = 64 * 1024;
    const started = Date.now();
    const script = `
      process.stderr.write(String(process.pid));
      const chunk = 'x'.repeat(16 * 1024);
      setInterval(() => process.stdout.write(chunk), 5);
    `;
    const result = await runNode(script, { maxBytes: limit });

    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(limit);
    expect(result.timedOut).toBe(false);
    expect(result.aborted).toBe(false);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(await waitUntilDead(Number(result.stderr), 3000)).toBe(true);
  });

  it('keeps output that is exactly at the limit', async () => {
    const result = await runNode('process.stdout.write("x".repeat(4096))', { maxBytes: 4096 });
    expect(result.truncated).toBe(false);
    expect(result.stdout).toHaveLength(4096);
    expect(result.code).toBe(0);
  });

  it('truncates output that is one byte past the limit', async () => {
    const result = await runNode('process.stdout.write("x".repeat(4097))', { maxBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(4096);
  });

  it('collects more than a megabyte by default', async () => {
    const result = await runNode('process.stdout.write("x".repeat(2 * 1024 * 1024))');
    expect(result.truncated).toBe(false);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
  });
});

describe('exec stdoutFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(CWD, 'entire-exec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes stdout to the file and keeps none of it in memory', async () => {
    const file = path.join(dir, 'out.txt');
    const result = await runNode(`process.stdout.write('héllo\\n'); process.stderr.write('note');`, { stdoutFile: file });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(result.bytes).toBe(Buffer.byteLength('héllo\n'));
    expect(result.stderr).toBe('note');
    expect(readFileSync(file, 'utf8')).toBe('héllo\n');
  });

  it('counts the bytes of output it collects in memory too', async () => {
    const result = await runNode(`process.stdout.write('héllo');`);
    expect(result.bytes).toBe(Buffer.byteLength('héllo'));
    expect(result.stdout.toString('utf8')).toBe('héllo');
  });

  // The in-memory limit exists to bound memory. Output that goes to a file
  // does not use memory, so the limit must not cut it off.
  it('writes all of an output that is larger than the in-memory limit', async () => {
    const file = path.join(dir, 'large.txt');
    const total = 24 * 1024 * 1024;
    const script = `
      const chunk = 'x'.repeat(64 * 1024);
      let left = ${total};
      const pump = () => {
        while (left > 0) {
          left -= chunk.length;
          if (!process.stdout.write(chunk)) { process.stdout.once('drain', pump); return; }
        }
      };
      pump();
    `;
    const result = await runNode(script, { stdoutFile: file, maxBytes: 1024 });
    expect(result.code).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.bytes).toBe(total);
    expect(statSync(file).size).toBe(total);
  });

  it('has written everything by the time it resolves, even when the process exits at once', async () => {
    const file = path.join(dir, 'burst.txt');
    const result = await runNode(`process.stdout.write('y'.repeat(3 * 1024 * 1024));`, { stdoutFile: file });
    expect(result.bytes).toBe(3 * 1024 * 1024);
    expect(statSync(file).size).toBe(3 * 1024 * 1024);
  });

  it.skipIf(!posix)('creates the file with access for its owner only', async () => {
    const file = path.join(dir, 'private.txt');
    await runNode(`process.stdout.write('secret');`, { stdoutFile: file });
    expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('reports a file it cannot write, and stops the process instead of waiting for it', async () => {
    const started = Date.now();
    // The process would run until the timeout if nothing stopped it.
    const result = await runNode(HANG, {
      stdoutFile: path.join(dir, 'no-such-directory', 'out.txt'),
      timeoutMs: 20_000,
    });
    expect(result.writeError).toBeInstanceOf(Error);
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(null);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('still stops at the timeout while writing to a file', async () => {
    const file = path.join(dir, 'slow.txt');
    const result = await runNode(`process.stdout.write('partial'); ${HANG}`, { stdoutFile: file, timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(null);
    expect(readFileSync(file, 'utf8')).toBe('partial');
  });

  it('reports a program that cannot be started', async () => {
    const result = await exec(path.join(dir, 'no-such-program'), [], {
      cwd: CWD,
      timeoutMs: 5000,
      stdoutFile: path.join(dir, 'never.txt'),
    });
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result.bytes).toBe(0);
  });
});

describe('exec stdoutFile for a program that cannot be started', () => {
  let dir: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-exec-missing-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('has finished with the file by the time it resolves, so the file does not turn up afterwards', async () => {
    // The file is opened in the background. An answer that came before the
    // open finished would let the file appear after the caller has cleaned up.
    for (let round = 0; round < 25; round += 1) {
      const file = path.join(dir, `never-${round}.txt`);
      const result = await exec(path.join(dir, 'no-such-program'), [], { cwd: dir, timeoutMs: 15_000, stdoutFile: file });
      expect(result.spawnError).toBeDefined();
      const present = existsSync(file);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(existsSync(file)).toBe(present);
    }
  });

  it('leaves a directory the caller can remove at once', async () => {
    for (let round = 0; round < 25; round += 1) {
      const scratch = mkdtempSync(path.join(dir, 'round-'));
      await exec(path.join(scratch, 'no-such-program'), [], {
        cwd: scratch,
        timeoutMs: 15_000,
        stdoutFile: path.join(scratch, 'out.txt'),
      });
      // Fails with ENOTEMPTY when the file is created while the directory is being removed.
      rmSync(scratch, { recursive: true });
      await new Promise((resolve) => setTimeout(resolve, 2));
      expect(existsSync(scratch)).toBe(false);
    }
  });
});

describe('exec spawn errors', () => {
  it('reports ENOENT for a program that does not exist', async () => {
    const result = await exec(path.join(CWD, 'no-such-dir', 'entire'), ['version'], { cwd: CWD, timeoutMs: 5000 });
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result).toMatchObject({ code: null, timedOut: false, aborted: false, truncated: false, stderr: '' });
    expect(result.stdout).toHaveLength(0);
  });

  it('reports ENOENT for a bare command name that is not on PATH', async () => {
    const result = await exec('entire-command-that-does-not-exist', [], { cwd: CWD, timeoutMs: 5000 });
    expect(result.spawnError?.code).toBe('ENOENT');
    expect(result.code).toBeNull();
  });

  it('reports a spawn error instead of rejecting when the working directory is missing', async () => {
    const result = await exec(NODE, ['-e', '0'], { cwd: path.join(CWD, 'no-such-dir'), timeoutMs: 5000 });
    expect(result.spawnError).toBeDefined();
    expect(result.code).toBeNull();
  });
});
