export type Priority = 'user' | 'background';

interface Job {
  priority: Priority;
  start: () => void;
}

/**
 * Limits how many processes of one kind run at once.
 *
 * User actions run before queued background work, at most one background job
 * runs at a time, and callers that pass the same key share one run.
 */
export class Lane {
  private running = 0;
  private runningBackground = 0;
  private readonly queue: Job[] = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly limit: number) {}

  run<T>(task: () => Promise<T>, options: { priority?: Priority; key?: string } = {}): Promise<T> {
    const { priority = 'user', key } = options;
    if (key !== undefined) {
      const existing = this.inFlight.get(key);
      if (existing) return existing as Promise<T>;
    }

    const promise = new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.running += 1;
        if (priority === 'background') this.runningBackground += 1;
        // A task that throws before it returns a promise still has to free its slot.
        let work: Promise<T>;
        try {
          work = task();
        } catch (error) {
          work = Promise.reject(error);
        }
        work
          .then(resolve, reject)
          .finally(() => {
            this.running -= 1;
            if (priority === 'background') this.runningBackground -= 1;
            this.drain();
          });
      };
      this.queue.push({ priority, start });
      this.drain();
    });

    if (key !== undefined) {
      this.inFlight.set(key, promise);
      const clear = (): void => {
        if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
      };
      promise.then(clear, clear);
    }
    return promise;
  }

  private drain(): void {
    while (this.running < this.limit) {
      const index = this.nextIndex();
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      job?.start();
    }
  }

  private nextIndex(): number {
    const user = this.queue.findIndex((job) => job.priority === 'user');
    if (user >= 0) return user;
    if (this.runningBackground > 0) return -1;
    return this.queue.findIndex((job) => job.priority === 'background');
  }
}
