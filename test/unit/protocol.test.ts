import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isWebviewMessage, type WebviewMessage } from '../../src/shared/protocol';

/** One valid message of every type. The `satisfies` clause keeps this list honest. */
const VALID = [
  { type: 'ready', protocol: PROTOCOL_VERSION },
  { type: 'selectSession', position: 0 },
  { type: 'selectSession', position: 3 },
  { type: 'requestToolBody', requestId: 1, turn: 0, block: 2 },
  { type: 'requestImage', requestId: 7, turn: 12, block: 0 },
  { type: 'openToolBody', turn: 4, block: 1 },
  { type: 'openOnWeb' },
  { type: 'showCommitDiff' },
  { type: 'openFile', index: 0 },
  { type: 'stepSession', direction: 'previous' },
  { type: 'stepSession', direction: 'next' },
  { type: 'openRawTranscript' },
  { type: 'openLink', href: 'https://example.com/docs' },
  { type: 'copy', target: 'checkpointId' },
  { type: 'copy', target: 'commitSha' },
  { type: 'copy', target: 'sessionId' },
  { type: 'retry' },
] satisfies WebviewMessage[];

describe('isWebviewMessage', () => {
  it.each(VALID)('accepts $type: %j', (message) => {
    expect(isWebviewMessage(message)).toBe(true);
  });

  it('covers every message type in the protocol', () => {
    const covered = new Set(VALID.map((message) => message.type));
    const all: Record<WebviewMessage['type'], true> = {
      ready: true,
      selectSession: true,
      stepSession: true,
      requestToolBody: true,
      requestImage: true,
      openToolBody: true,
      openOnWeb: true,
      showCommitDiff: true,
      openFile: true,
      openRawTranscript: true,
      openLink: true,
      copy: true,
      retry: true,
    };
    expect([...covered].sort()).toEqual(Object.keys(all).sort());
  });

  it('accepts a message with extra properties', () => {
    expect(isWebviewMessage({ type: 'retry', extra: 1 })).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'retry'],
    ['a number', 1],
    ['a boolean', true],
    ['an array', ['retry']],
    ['an empty object', {}],
    ['an unknown type', { type: 'shutdown' }],
    ['a host message type', { type: 'init', protocol: 1 }],
    ['a type that differs in case', { type: 'Retry' }],
    ['a type that is not a string', { type: 1 }],
    ['a type with whitespace', { type: 'retry ' }],
  ])('rejects %s', (_label, value) => {
    expect(isWebviewMessage(value)).toBe(false);
  });

  it.each([
    ['missing', { type: 'stepSession' }],
    ['another word', { type: 'stepSession', direction: 'first' }],
    ['a different case', { type: 'stepSession', direction: 'Next' }],
    ['a checkpoint ID', { type: 'stepSession', direction: 'abcdef012345' }],
    ['a number', { type: 'stepSession', direction: 1 }],
  ])('rejects a stepSession direction that is %s', (_label, value) => {
    expect(isWebviewMessage(value)).toBe(false);
  });

  const BAD_INDEXES: [string, unknown][] = [
    ['missing', undefined],
    ['negative', -1],
    ['fractional', 1.5],
    ['a numeric string', '1'],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a boolean', true],
    ['an object', {}],
  ];

  describe.each(BAD_INDEXES)('an index that is %s', (_label, bad) => {
    const withBad = (message: Record<string, unknown>, key: string): Record<string, unknown> => {
      const copy = { ...message };
      if (bad === undefined) delete copy[key];
      else copy[key] = bad;
      return copy;
    };

    it('is rejected in ready.protocol', () => {
      expect(isWebviewMessage(withBad({ type: 'ready', protocol: 1 }, 'protocol'))).toBe(false);
    });

    it('is rejected in selectSession.position', () => {
      expect(isWebviewMessage(withBad({ type: 'selectSession', position: 0 }, 'position'))).toBe(false);
    });

    it.each(['requestId', 'turn', 'block'])('is rejected in requestToolBody.%s', (key) => {
      expect(isWebviewMessage(withBad({ type: 'requestToolBody', requestId: 1, turn: 0, block: 0 }, key))).toBe(false);
    });

    it.each(['requestId', 'turn', 'block'])('is rejected in requestImage.%s', (key) => {
      expect(isWebviewMessage(withBad({ type: 'requestImage', requestId: 1, turn: 0, block: 0 }, key))).toBe(false);
    });

    it.each(['turn', 'block'])('is rejected in openToolBody.%s', (key) => {
      expect(isWebviewMessage(withBad({ type: 'openToolBody', turn: 0, block: 0 }, key))).toBe(false);
    });

    it('is rejected in openFile.index', () => {
      expect(isWebviewMessage(withBad({ type: 'openFile', index: 0 }, 'index'))).toBe(false);
    });
  });

  it.each([
    ['missing', {}],
    ['a number', { href: 1 }],
    ['null', { href: null }],
    ['an object', { href: { toString: () => 'https://example.com' } }],
    ['an array', { href: ['https://example.com'] }],
  ])('rejects openLink when href is %s', (_label, extra) => {
    expect(isWebviewMessage({ type: 'openLink', ...extra })).toBe(false);
  });

  it.each([
    ['missing', {}],
    ['an unknown target', { target: 'repoRoot' }],
    ['a target that differs in case', { target: 'CheckpointId' }],
    ['a number', { target: 0 }],
    ['an inherited property name', { target: 'constructor' }],
  ])('rejects copy when the target is %s', (_label, extra) => {
    expect(isWebviewMessage({ type: 'copy', ...extra })).toBe(false);
  });
});
