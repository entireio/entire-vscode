import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, isTrailWebviewMessage, isWebviewMessage, type TrailWebviewMessage } from '../../src/shared/protocol';

/** One valid message of every type. The `satisfies` clause keeps this list honest. */
const VALID = [
  { type: 'ready', protocol: PROTOCOL_VERSION },
  { type: 'retry' },
  { type: 'openLink', href: 'https://example.com/docs' },
  { type: 'selectChange', position: 0 },
  { type: 'selectChange', position: 4 },
  { type: 'openOnWeb' },
  { type: 'openChangeOnWeb' },
  { type: 'openCheck', run: 0 },
  { type: 'openCheckpoint', event: 3, checkpoint: 1 },
  { type: 'showCommitDiff', event: 0 },
  { type: 'copyCommitSha', event: 12 },
  { type: 'copyBranch' },
  { type: 'copyLink' },
  { type: 'loadMoreTimeline' },
] satisfies TrailWebviewMessage[];

/** Values that are not a position in a list. */
const BAD_POSITIONS: [string, unknown][] = [
  ['missing', undefined],
  ['negative', -1],
  ['a fraction', 1.5],
  ['a string', '1'],
  ['null', null],
  ['not a number', Number.NaN],
  ['infinite', Number.POSITIVE_INFINITY],
  ['an object', { valueOf: () => 1 }],
];

describe('isTrailWebviewMessage', () => {
  it.each(VALID)('accepts $type: %j', (message) => {
    expect(isTrailWebviewMessage(message)).toBe(true);
  });

  it('covers every message type in the protocol', () => {
    const types: Record<TrailWebviewMessage['type'], true> = {
      ready: true,
      retry: true,
      openLink: true,
      selectChange: true,
      openOnWeb: true,
      openChangeOnWeb: true,
      openCheck: true,
      openCheckpoint: true,
      showCommitDiff: true,
      copyCommitSha: true,
      copyBranch: true,
      copyLink: true,
      loadMoreTimeline: true,
    };
    expect(new Set(VALID.map((message) => message.type))).toEqual(new Set(Object.keys(types)));
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'retry'],
    ['a number', 3],
    ['an array', [{ type: 'retry' }]],
    ['an object with no type', {}],
    ['an unknown type', { type: 'runCommand' }],
    ['a type that differs in case', { type: 'Retry' }],
    ['an inherited property name as the type', { type: 'constructor' }],
    ['a message of the detail panel', { type: 'selectSession', position: 0 }],
    ['a message of the detail panel that names a file', { type: 'openFile', index: 0 }],
  ])('rejects %s', (_label, value) => {
    expect(isTrailWebviewMessage(value)).toBe(false);
  });

  describe.each(BAD_POSITIONS)('a position that is %s', (_label, bad) => {
    const withBad = (message: Record<string, unknown>, key: string): Record<string, unknown> => {
      const copy = { ...message };
      if (bad === undefined) delete copy[key];
      else copy[key] = bad;
      return copy;
    };

    it('is rejected in ready.protocol', () => {
      expect(isTrailWebviewMessage(withBad({ type: 'ready', protocol: 1 }, 'protocol'))).toBe(false);
    });

    it('is rejected in selectChange.position', () => {
      expect(isTrailWebviewMessage(withBad({ type: 'selectChange', position: 0 }, 'position'))).toBe(false);
    });

    it('is rejected in openCheck.run', () => {
      expect(isTrailWebviewMessage(withBad({ type: 'openCheck', run: 0 }, 'run'))).toBe(false);
    });

    it('is rejected in either field of openCheckpoint', () => {
      const message = { type: 'openCheckpoint', event: 0, checkpoint: 0 };
      expect(isTrailWebviewMessage(withBad(message, 'event'))).toBe(false);
      expect(isTrailWebviewMessage(withBad(message, 'checkpoint'))).toBe(false);
    });

    it('is rejected in showCommitDiff.event and copyCommitSha.event', () => {
      expect(isTrailWebviewMessage(withBad({ type: 'showCommitDiff', event: 0 }, 'event'))).toBe(false);
      expect(isTrailWebviewMessage(withBad({ type: 'copyCommitSha', event: 0 }, 'event'))).toBe(false);
    });
  });

  it.each([
    ['missing', {}],
    ['a number', { href: 1 }],
    ['null', { href: null }],
    ['an array', { href: ['https://example.com'] }],
  ])('rejects openLink when href is %s', (_label, extra) => {
    expect(isTrailWebviewMessage({ type: 'openLink', ...extra })).toBe(false);
  });

  it('keeps the two panels apart: the detail panel does not accept trail messages', () => {
    expect(isWebviewMessage({ type: 'selectChange', position: 0 })).toBe(false);
    expect(isWebviewMessage({ type: 'openCheckpoint', event: 0, checkpoint: 0 })).toBe(false);
    expect(isWebviewMessage({ type: 'loadMoreTimeline' })).toBe(false);
  });
});
