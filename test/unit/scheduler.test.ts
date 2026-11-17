import { describe, expect, it } from 'vitest';
import { Lane, type Priority } from '../../src/core/scheduler';
import { deferred, settle, type Deferred } from './support';

/** Tracks what a lane starts, and lets the test finish each job by name. */
function harness(lane: Lane) {
  const started: string[] = [];
  const running = new Set<string>();
  const gates = new Map<string, Deferred<string>>();
  let maxRunning = 0;
  let maxBackground = 0;
  const background = new Set<string>();

  const add = (name: string, priority?: Priority, key?: string): Promise<string> => {
    const gate = deferred<string>();
    gates.set(name, gate);
    return lane.run(
      async () => {
        started.push(name);
        running.add(name);
        if (priority === 'background') background.add(name);
        maxRunning = Math.max(maxRunning, running.size);
        maxBackground = Math.max(maxBackground, background.size);
        try {
          return await gate.promise;
        } finally {
          running.delete(name);
          background.delete(name);
        }
      },
      { ...(priority ? { priority } : {}), ...(key === undefined ? {} : { key }) },
    );
  };

  const finish = async (name: string): Promise<void> => {
    gates.get(name)?.resolve(`${name} done`);
    await settle();
  };

  return {
    add,
    finish,
    started,
    running: () => [...running].sort(),
    maxRunning: () => maxRunning,
    maxBackground: () => maxBackground,
  };
}

describe('Lane concurrency limit', () => {
  it('runs a job at once when a slot is free and returns its result', async () => {
    const lane = new Lane(2);
    expect(await lane.run(async () => 42)).toBe(42);
  });

  it('never runs more jobs than the limit', async () => {
    const h = harness(new Lane(2));
    const jobs = ['a', 'b', 'c', 'd', 'e'].map((name) => h.add(name));
    await settle();
    expect(h.running()).toEqual(['a', 'b']);

    await h.finish('a');
    expect(h.running()).toEqual(['b', 'c']);
    await h.finish('c');
    expect(h.running()).toEqual(['b', 'd']);
    await h.finish('b');
    await h.finish('d');
    await h.finish('e');

    expect(await Promise.all(jobs)).toEqual(['a done', 'b done', 'c done', 'd done', 'e done']);
    expect(h.maxRunning()).toBe(2);
    expect(h.started).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('runs one job at a time with a limit of one, in the order they were added', async () => {
    const h = harness(new Lane(1));
    for (const name of ['a', 'b', 'c']) void h.add(name);
    await settle();
    expect(h.started).toEqual(['a']);
    await h.finish('a');
    expect(h.started).toEqual(['a', 'b']);
    await h.finish('b');
    expect(h.started).toEqual(['a', 'b', 'c']);
    expect(h.maxRunning()).toBe(1);
  });

  it('uses every slot when enough jobs are waiting', async () => {
    const h = harness(new Lane(3));
    for (const name of ['a', 'b', 'c', 'd']) void h.add(name);
    await settle();
    expect(h.running()).toEqual(['a', 'b', 'c']);
  });

  it('passes a rejection to the caller', async () => {
    const lane = new Lane(1);
    await expect(lane.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('frees the slot of a job that rejects', async () => {
    const lane = new Lane(1);
    const gate = deferred();
    const failing = lane.run(() => gate.promise);
    const next = lane.run(async () => 'next ran');
    gate.reject(new Error('boom'));
    await expect(failing).rejects.toThrow('boom');
    expect(await next).toBe('next ran');
    expect(await lane.run(async () => 'and again')).toBe('and again');
  });

  // A task that throws before it returns a promise leaves its slot taken
  // forever. No caller in src/ does this today: every task is an async
  // function. This guards the lane against a future caller that does.
  it('frees the slot of a job that throws before returning a promise', async () => {
    const lane = new Lane(1);
    const throwing = lane.run((): Promise<string> => {
      throw new Error('threw synchronously');
    });
    await expect(throwing).rejects.toThrow('threw synchronously');

    const next = lane.run(async () => 'next ran');
    const outcome = await Promise.race([next, settle().then(() => settle()).then(() => 'still queued')]);
    expect(outcome).toBe('next ran');
  });
});

describe('Lane priority', () => {
  it('treats a job with no priority as a user job', async () => {
    const h = harness(new Lane(1));
    void h.add('blocker');
    void h.add('background', 'background');
    void h.add('default');
    await settle();
    await h.finish('blocker');
    expect(h.started).toEqual(['blocker', 'default']);
  });

  it('runs queued user jobs before queued background jobs', async () => {
    const h = harness(new Lane(1));
    void h.add('blocker', 'user');
    void h.add('bg1', 'background');
    void h.add('bg2', 'background');
    void h.add('user1', 'user');
    void h.add('user2', 'user');
    await settle();
    expect(h.started).toEqual(['blocker']);

    await h.finish('blocker');
    await h.finish('user1');
    await h.finish('user2');
    await h.finish('bg1');
    await h.finish('bg2');
    expect(h.started).toEqual(['blocker', 'user1', 'user2', 'bg1', 'bg2']);
  });

  it('lets a user job that arrives later overtake background jobs that are still queued', async () => {
    const h = harness(new Lane(1));
    void h.add('blocker', 'user');
    void h.add('bg1', 'background');
    await settle();
    void h.add('late user', 'user');
    await h.finish('blocker');
    expect(h.started).toEqual(['blocker', 'late user']);
    await h.finish('late user');
    expect(h.started).toEqual(['blocker', 'late user', 'bg1']);
  });

  it('starts a background job at once when the lane is idle', async () => {
    const h = harness(new Lane(2));
    void h.add('bg1', 'background');
    await settle();
    expect(h.started).toEqual(['bg1']);
  });

  it('does not stop a background job that is already running when a user job arrives', async () => {
    const h = harness(new Lane(2));
    const background = h.add('bg1', 'background');
    await settle();
    void h.add('user1', 'user');
    await settle();
    expect(h.running()).toEqual(['bg1', 'user1']);
    await h.finish('bg1');
    expect(await background).toBe('bg1 done');
  });
});

describe('Lane background limit', () => {
  it('runs at most one background job at a time, even with free slots', async () => {
    const h = harness(new Lane(4));
    void h.add('bg1', 'background');
    void h.add('bg2', 'background');
    void h.add('bg3', 'background');
    await settle();
    expect(h.running()).toEqual(['bg1']);

    await h.finish('bg1');
    expect(h.running()).toEqual(['bg2']);
    await h.finish('bg2');
    expect(h.running()).toEqual(['bg3']);
    await h.finish('bg3');
    expect(h.maxBackground()).toBe(1);
    expect(h.started).toEqual(['bg1', 'bg2', 'bg3']);
  });

  it('keeps the other slots available to user jobs while a background job runs', async () => {
    const h = harness(new Lane(3));
    void h.add('bg1', 'background');
    void h.add('bg2', 'background');
    void h.add('user1', 'user');
    void h.add('user2', 'user');
    void h.add('user3', 'user');
    await settle();
    expect(h.running()).toEqual(['bg1', 'user1', 'user2']);

    await h.finish('user1');
    expect(h.running()).toEqual(['bg1', 'user2', 'user3']);
    await h.finish('user2');
    // A slot is free, but the queued background job waits for the running one.
    expect(h.running()).toEqual(['bg1', 'user3']);
    await h.finish('bg1');
    expect(h.running()).toEqual(['bg2', 'user3']);
    expect(h.maxBackground()).toBe(1);
  });

  it('starts the next background job after one fails', async () => {
    const lane = new Lane(2);
    const gate = deferred();
    const failing = lane.run(() => gate.promise, { priority: 'background' });
    const next = lane.run(async () => 'next background ran', { priority: 'background' });
    gate.reject(new Error('fetch failed'));
    await expect(failing).rejects.toThrow('fetch failed');
    expect(await next).toBe('next background ran');
  });
});

describe('Lane keys', () => {
  it('shares one run between calls with the same key', async () => {
    const lane = new Lane(2);
    const gate = deferred<string>();
    let runs = 0;
    const task = (): Promise<string> => {
      runs += 1;
      return gate.promise;
    };

    const first = lane.run(task, { key: 'status' });
    const second = lane.run(task, { key: 'status' });
    const third = lane.run(task, { key: 'status', priority: 'background' });
    await settle();
    expect(runs).toBe(1);

    gate.resolve('shared result');
    expect(await Promise.all([first, second, third])).toEqual(['shared result', 'shared result', 'shared result']);
    expect(runs).toBe(1);
  });

  it('shares a run that is still waiting in the queue', async () => {
    const h = harness(new Lane(1));
    void h.add('blocker');
    const first = h.add('keyed', 'user', 'k');
    const second = h.add('keyed twin', 'user', 'k');
    await settle();
    await h.finish('blocker');
    await h.finish('keyed');
    expect(await first).toBe('keyed done');
    expect(await second).toBe('keyed done');
    expect(h.started).toEqual(['blocker', 'keyed']);
  });

  it('runs again for a call that arrives after the shared run finished', async () => {
    const lane = new Lane(2);
    let runs = 0;
    const task = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    expect(await lane.run(task, { key: 'status' })).toBe(1);
    await settle();
    expect(await lane.run(task, { key: 'status' })).toBe(2);
  });

  it('runs calls with different keys separately', async () => {
    const lane = new Lane(4);
    let runs = 0;
    const task = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    await Promise.all([lane.run(task, { key: 'a' }), lane.run(task, { key: 'b' }), lane.run(task, { key: '' })]);
    expect(runs).toBe(3);
  });

  it('never shares calls that have no key', async () => {
    const lane = new Lane(4);
    let runs = 0;
    const task = async (): Promise<number> => {
      runs += 1;
      return runs;
    };
    const results = await Promise.all([lane.run(task), lane.run(task), lane.run(task)]);
    expect(runs).toBe(3);
    expect(results).toEqual([1, 2, 3]);
  });

  it('shares a failure, then runs again for the next call', async () => {
    const lane = new Lane(2);
    const gate = deferred<string>();
    let runs = 0;
    const failingTask = (): Promise<string> => {
      runs += 1;
      return gate.promise;
    };
    const first = lane.run(failingTask, { key: 'k' });
    const second = lane.run(failingTask, { key: 'k' });
    gate.reject(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).rejects.toThrow('boom');
    expect(runs).toBe(1);

    await settle();
    expect(await lane.run(async () => 'recovered', { key: 'k' })).toBe('recovered');
  });

  it('counts a shared run as one job against the limit', async () => {
    const h = harness(new Lane(2));
    void h.add('keyed', 'user', 'k');
    void h.add('keyed twin', 'user', 'k');
    void h.add('other');
    await settle();
    expect(h.running()).toEqual(['keyed', 'other']);
    expect(h.started).not.toContain('keyed twin');
  });
});
