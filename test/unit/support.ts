import { vi } from 'vitest';
import type { CommitRecord } from '../../src/core/trailers';

/**
 * Keeps the developer's own git configuration out of the git calls that the
 * code under test makes. The fixture repo helper already does this for its
 * own calls. Undo with `vi.unstubAllEnvs()`.
 */
export function isolateGitConfig(): void {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

/** A promise that the test settles by hand. */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every pending promise callback run. */
export function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A 40-character commit SHA that is unique per `n`. */
export function fakeSha(n: number): string {
  return n.toString(16).padStart(40, '0');
}

/** A synthetic commit record. `n` orders records: a lower `n` is a newer commit. */
export function commitRecord(n: number, checkpointIds: string[] = []): CommitRecord {
  const sha = fakeSha(n);
  return {
    sha,
    shortSha: sha.slice(0, 7),
    authorTime: 1_700_000_000 - n * 60,
    author: 'Fixture Author',
    subject: `Commit ${n}`,
    checkpointIds,
  };
}

/** True when no surrogate half in the text is missing its partner. */
export function isWellFormed(text: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}
