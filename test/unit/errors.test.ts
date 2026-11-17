import { describe, expect, it } from 'vitest';
import { fail, ok } from '../../src/core/errors';

describe('ok', () => {
  it('wraps a value', () => {
    expect(ok(42)).toStrictEqual({ ok: true, value: 42 });
  });

  it('wraps falsy values without losing them', () => {
    expect(ok(undefined)).toStrictEqual({ ok: true, value: undefined });
    expect(ok('')).toStrictEqual({ ok: true, value: '' });
    expect(ok([])).toStrictEqual({ ok: true, value: [] });
  });
});

describe('fail', () => {
  it('carries the kind and a message', () => {
    expect(fail('timeout', 'The Entire CLI took too long.')).toStrictEqual({
      ok: false,
      failure: { kind: 'timeout', message: 'The Entire CLI took too long.' },
    });
  });

  it('carries the detail when there is one, including an empty one', () => {
    expect(fail('exit', 'Git could not read the commit history.', 'fatal: bad object')).toStrictEqual({
      ok: false,
      failure: { kind: 'exit', message: 'Git could not read the commit history.', detail: 'fatal: bad object' },
    });
    expect(fail('exit', 'Failed.', '')).toStrictEqual({ ok: false, failure: { kind: 'exit', message: 'Failed.', detail: '' } });
  });

  it('leaves the detail absent when there is none', () => {
    const result = fail('notGit', 'This folder is not a Git repository.');
    expect(result.ok).toBe(false);
    expect(!result.ok && 'detail' in result.failure).toBe(false);
  });
});
