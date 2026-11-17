import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startServer, type RunningServer, type ServerOptions } from '../../src/core/serverProcess';

const NODE = process.execPath;
const CWD = realpathSync(os.tmpdir());
const posix = process.platform !== 'win32';

/** The address in a line of the form `ready http://127.0.0.1:<port>`. */
const ready = (line: string): string | undefined => /^ready (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];

/** Servers started by a test, stopped after it whatever its outcome. */
const started: RunningServer[] = [];

/** Runs a Node script through the code under test. */
async function serve(script: string, options: Partial<ServerOptions> = {}) {
  const result = await startServer(NODE, ['-e', script], { cwd: CWD, ready, readyTimeoutMs: 15_000, ...options });
  if (result.ok) started.push(result.value);
  return result;
}

/** A script that listens on a free loopback port, prints its address, and serves `pong`. */
const SERVER = `
const http = require('node:http');
const server = http.createServer((request, response) => response.end('pong'));
server.listen(0, '127.0.0.1', () => console.log('ready http://127.0.0.1:' + server.address().port));
`;

function get(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let body = '';
        response.on('data', (chunk: Buffer) => (body += chunk.toString()));
        response.on('end', () => resolve(body));
      })
      .on('error', reject);
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  for (const server of started.splice(0)) {
    server.stop();
    await within(server.exited, 5000);
  }
});

describe('startServer', () => {
  it('resolves with the address once the program has printed it, and leaves the program running', async () => {
    const result = await serve(SERVER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await get(result.value.url)).toBe('pong');
  });

  it('reads the address from whichever line carries it', async () => {
    const result = await serve(`console.log('starting'); console.log('ready http://127.0.0.1:4321'); console.log('more'); setInterval(() => {}, 1000);`);
    expect(result.ok && result.value.url).toBe('http://127.0.0.1:4321');
  });

  it('reads a line that arrives in pieces, and only once it is whole', async () => {
    // A port cut in half would otherwise be read as another port.
    const script = `
      process.stdout.write('ready http://127.0.0.1:43');
      setTimeout(() => process.stdout.write('21\\n'), 150);
      setInterval(() => {}, 1000);`;
    const result = await serve(script);
    expect(result.ok && result.value.url).toBe('http://127.0.0.1:4321');
  });

  it('reads a line that ends with a carriage return', async () => {
    const result = await serve(`process.stdout.write('ready http://127.0.0.1:4321\\r\\n'); setInterval(() => {}, 1000);`);
    expect(result.ok && result.value.url).toBe('http://127.0.0.1:4321');
  });

  it('stops the program on request, and says when it is gone', async () => {
    const result = await serve(SERVER);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { url, stop, exited } = result.value;
    stop();
    expect(await within(exited, 5000)).toBeUndefined();
    await expect(get(url)).rejects.toThrow();
    // Stopping again, after it is gone, does nothing.
    stop();
  });

  it.skipIf(!posix)('stops what the program started, too', async () => {
    // The Entire CLI runs a plugin as a child of its own, and the child is the one that serves.
    const child = `setInterval(() => {}, 1000);`;
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { stdio: 'ignore' });
      console.log('ready http://127.0.0.1:' + child.pid);`;
    const result = await serve(script, { ready: (line) => /^ready (http:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const childPid = Number(result.value.url.split(':').pop());
    expect(isAlive(childPid)).toBe(true);
    result.value.stop();
    await within(result.value.exited, 5000);
    const deadline = Date.now() + 5000;
    while (isAlive(childPid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(isAlive(childPid)).toBe(false);
  });

  it.skipIf(!posix)('forces a program that ignores the request to stop', async () => {
    const script = `process.on('SIGTERM', () => {}); console.log('ready http://127.0.0.1:4321'); setInterval(() => {}, 1000);`;
    const result = await serve(script);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    result.value.stop();
    expect(await within(result.value.exited, 6000)).toBeUndefined();
  });

  it('keeps reading the output of a running server, so the server never waits on a full pipe', async () => {
    // Well past what a pipe holds. A program that nobody reads from stops here.
    const script = `
      console.log('ready http://127.0.0.1:4321');
      const line = 'x'.repeat(1024) + '\\n';
      let written = 0;
      const write = () => {
        while (written < 4096) {
          written += 1;
          if (!process.stdout.write(line) || !process.stderr.write(line)) return void setTimeout(write, 1);
        }
        process.exit(7);
      };
      write();`;
    const result = await serve(script);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // It reached its own exit, which it can only do after every write went through.
    expect(await within(result.value.exited, 10_000)).toBeUndefined();
  });

  it('fails with what the program said when it stops before it is ready', async () => {
    const result = await serve(`console.error('bind viz server: address already in use'); process.exit(1);`);
    expect(!result.ok && result.failure.kind).toBe('exit');
    expect(!result.ok && result.failure.detail).toBe('bind viz server: address already in use');
  });

  it('reports the exit code of a program that stops without a word', async () => {
    const result = await serve(`process.exit(3);`);
    expect(!result.ok && result.failure.kind).toBe('exit');
    expect(!result.ok && result.failure.detail).toBe('exit code 3');
  });

  it('gives up on a program that never prints its address, and stops it', async () => {
    const result = await serve(`console.log('still thinking'); setInterval(() => {}, 1000);`, { readyTimeoutMs: 300 });
    expect(!result.ok && result.failure.kind).toBe('timeout');
  });

  it('gives up when the caller cancels the start, and stops the program', async () => {
    const controller = new AbortController();
    const pending = serve(`setInterval(() => {}, 1000);`, { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    const result = await pending;
    expect(!result.ok && result.failure.kind).toBe('aborted');
  });

  it('does not start the program when the caller has already cancelled', async () => {
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'entire-serve-')));
    try {
      const marker = path.join(dir, 'ran.txt');
      const controller = new AbortController();
      controller.abort();
      const result = await serve(`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');`, { signal: controller.signal });
      expect(!result.ok && result.failure.kind).toBe('aborted');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(() => rmSync(marker)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not stop a server because the signal that could have cancelled its start fires later', async () => {
    const controller = new AbortController();
    const result = await serve(SERVER, { signal: controller.signal });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await get(result.value.url)).toBe('pong');
  });

  it('reports a program that cannot be started', async () => {
    const result = await startServer(path.join(CWD, 'no-such-program'), [], { cwd: CWD, ready, readyTimeoutMs: 5000 });
    expect(!result.ok && result.failure.kind).toBe('cliMissing');
  });

  it('passes the given environment and working directory', async () => {
    const script = `console.log('ready http://127.0.0.1:' + process.env.SERVE_PORT); setInterval(() => {}, 1000);`;
    const result = await serve(script, { env: { ...process.env, SERVE_PORT: '4444' } });
    expect(result.ok && result.value.url).toBe('http://127.0.0.1:4444');
  });
});
