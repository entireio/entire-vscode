import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exec } from '../../src/core/exec';
import { Git } from '../../src/core/git';
import { Lane } from '../../src/core/scheduler';
import { isCheckpointId, isCommitSha, parseCheckpointIds, parseLogRecords } from '../../src/core/trailers';
import { createFixtureRepo, type FixtureRepo } from '../helpers/fixtureRepo';
import { isolateGitConfig } from './support';

const HEX = 'abcdef012345';
const ULID = '01HZXK3M5N7P9R2T4V6W8Y0A1B';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('isCheckpointId', () => {
  it.each([HEX, '000000000000', 'a1b2c3d4e5f6', 'ffffffffffff'])('accepts the 12-character hex ID %s', (id) => {
    expect(isCheckpointId(id)).toBe(true);
  });

  it.each([ULID, '0123456789ABCDEFGHJKMNPQRS', '0TVWXYZ0123456789ABCDEFGHJ', '00000000000000000000000000', '7ZZZZZZZZZZZZZZZZZZZZZZZZZ'])(
    'accepts the 26-character ULID %s',
    (id) => {
      expect(isCheckpointId(id)).toBe(true);
    },
  );

  it.each([
    ['empty', ''],
    ['11 hex characters', 'abcdef01234'],
    ['13 hex characters', 'abcdef0123456'],
    ['a 40-character commit SHA', SHA_A],
    ['25 ULID characters', ULID.slice(0, 25)],
    ['27 ULID characters', `${ULID}0`],
  ])('rejects another length: %s', (_label, id) => {
    expect(isCheckpointId(id)).toBe(false);
  });

  it('rejects uppercase hex of the legacy length', () => {
    expect(isCheckpointId('ABCDEF012345')).toBe(false);
  });

  it('rejects a legacy ID with a character outside hex', () => {
    expect(isCheckpointId('abcdefg12345')).toBe(false);
  });

  it('rejects a lowercase ULID', () => {
    expect(isCheckpointId(ULID.toLowerCase())).toBe(false);
  });

  it('rejects a mixed-case ULID', () => {
    expect(isCheckpointId(`${ULID.slice(0, 25)}k`)).toBe(false);
  });

  it.each(['I', 'L', 'O', 'U'])('rejects a ULID that contains the letter %s, which Crockford base32 leaves out', (letter) => {
    for (const position of [0, 13, 25]) {
      const id = `${ULID.slice(0, position)}${letter}${ULID.slice(position + 1)}`;
      expect(id).toHaveLength(26);
      expect(isCheckpointId(id)).toBe(false);
    }
  });

  it.each([`${HEX}\n`, ` ${HEX}`, `${HEX} `, `${ULID}\n`, `-${HEX.slice(1)}`, `${ULID.slice(0, 25)}-`])(
    'rejects an ID with whitespace or punctuation: %j',
    (id) => {
      expect(isCheckpointId(id)).toBe(false);
    },
  );
});

describe('isCommitSha', () => {
  it('accepts SHA-1 and SHA-256 object names', () => {
    expect(isCommitSha(SHA_A)).toBe(true);
    expect(isCommitSha('0'.repeat(64))).toBe(true);
  });

  it.each(['', 'HEAD', 'main', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), `${'a'.repeat(39)}g`, `--all${'a'.repeat(35)}`])(
    'rejects %j',
    (value) => {
      expect(isCommitSha(value)).toBe(false);
    },
  );
});

/** Builds `git log -z` output: fields joined by US, records ended by NUL. The last field is the message. */
function logOutput(...records: string[][]): string {
  return records.map((fields) => `${fields.join('\x1f')}\x00`).join('');
}

/** A commit message: a subject, then the given lines as its last paragraph. */
function message(subject: string, ...lines: string[]): string {
  return lines.length > 0 ? `${subject}\n\n${lines.join('\n')}\n` : `${subject}\n`;
}

const link = (id: string): string => `Entire-Checkpoint: ${id}`;

describe('parseCheckpointIds', () => {
  it('reads a link from the last paragraph of a message', () => {
    expect(parseCheckpointIds(message('Add the parser', link(HEX)))).toEqual([HEX]);
  });

  // A squash merge joins the messages of the commits it squashed, so each
  // link ends a paragraph of its own. Git's trailer block is the last
  // paragraph only; the Entire CLI reads the whole message, and so does this.
  it('reads a link from every paragraph of a squash-merge message', () => {
    const squash = ['Add the parser (#12)', '', '* Add the parser', '', link(HEX), '', '* Fix the lexer', '', link(ULID), ''].join('\n');
    expect(parseCheckpointIds(squash)).toEqual([HEX, ULID]);
  });

  it('reads links that come before a paragraph of other trailers', () => {
    const squash = ['Subject', '', link(HEX), '', link(ULID), '', 'Co-authored-by: Someone <s@example.com>', ''].join('\n');
    expect(parseCheckpointIds(squash)).toEqual([HEX, ULID]);
  });

  it('keeps the first position of a repeated ID', () => {
    expect(parseCheckpointIds(message('s', link(HEX), link(ULID), link(HEX), link(ULID)))).toEqual([HEX, ULID]);
  });

  it('accepts any whitespace between the key and the ID, and after the ID', () => {
    expect(parseCheckpointIds(`s\n\nEntire-Checkpoint:   ${HEX}  \nEntire-Checkpoint:\t${ULID}\r\n`)).toEqual([HEX, ULID]);
    expect(parseCheckpointIds(`Entire-Checkpoint:${HEX}`)).toEqual([HEX]);
  });

  it.each([
    ['prose', 'not-an-id'],
    ['uppercase hex', 'ABCDEF012345'],
    ['a short hex value', 'abcdef01234'],
    ['a commit SHA', SHA_B],
    ['a lowercase ULID', ULID.toLowerCase()],
    ['an option-like value', '--checkpoint'],
    ['an ID with text stuck to its end', `${HEX}xyz`],
    ['a ULID with text stuck to its end', `${ULID}9`],
    ['nothing', ''],
  ])('ignores a link whose value is %s', (_label, value) => {
    expect(parseCheckpointIds(message('s', link(value)))).toEqual([]);
  });

  it('matches the key exactly, as the Entire CLI does', () => {
    expect(parseCheckpointIds(message('s', `entire-checkpoint: ${HEX}`))).toEqual([]);
    expect(parseCheckpointIds(message('s', `Entire-Checkpoints: ${HEX}`))).toEqual([]);
  });

  it('returns nothing for a message with no link', () => {
    expect(parseCheckpointIds('')).toEqual([]);
    expect(parseCheckpointIds(message('Plain commit', 'Signed-off-by: A <a@example.com>'))).toEqual([]);
  });
});

describe('parseLogRecords', () => {
  it('reads every field of a record', () => {
    const [record, ...rest] = parseLogRecords(
      logOutput([SHA_A, 'aaaaaaa', '1700000060', 'Ada Lovelace', 'Add the parser', message('Add the parser', link(HEX))]),
    );
    expect(rest).toEqual([]);
    expect(record).toEqual({
      sha: SHA_A,
      shortSha: 'aaaaaaa',
      authorTime: 1_700_000_060,
      author: 'Ada Lovelace',
      subject: 'Add the parser',
      checkpointIds: [HEX],
    });
  });

  it('keeps records in the order git printed them', () => {
    const records = parseLogRecords(
      logOutput([SHA_A, 'aaaaaaa', '2', 'A', 'newer', 'newer\n'], [SHA_B, 'bbbbbbb', '1', 'B', 'older', 'older\n']),
    );
    expect(records.map((record) => record.sha)).toEqual([SHA_A, SHA_B]);
  });

  it('reads several links on one commit, in order', () => {
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'A', 's', message('s', link(ULID), link(HEX))]));
    expect(record?.checkpointIds).toEqual([ULID, HEX]);
  });

  it('gives a commit with no link an empty list', () => {
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'A', 's', 's\n']));
    expect(record?.checkpointIds).toEqual([]);
  });

  it('gives a record with no message field at all an empty list', () => {
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'A', 's']));
    expect(record?.checkpointIds).toEqual([]);
  });

  it('keeps the valid links that sit among garbage ones', () => {
    const body = message('s', link('nope'), link(HEX), link('ABCDEF012345'), link(ULID));
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'A', 's', body]));
    expect(record?.checkpointIds).toEqual([HEX, ULID]);
  });

  it('reads a message that itself contains the field separator', () => {
    const body = `s\n\nodd \x1f byte\n\n${link(HEX)}\n`;
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'A', 's', body]));
    expect(record?.checkpointIds).toEqual([HEX]);
  });

  it('keeps commas, quotes, and non-ASCII text in the subject and author', () => {
    const subject = 'fix: handle "quotes", commas, and ünïcode → ok';
    const [record] = parseLogRecords(logOutput([SHA_A, 'aaaaaaa', '1', 'Zoë Müller', subject, message(subject, link(HEX))]));
    expect(record?.subject).toBe(subject);
    expect(record?.author).toBe('Zoë Müller');
    expect(record?.checkpointIds).toEqual([HEX]);
  });

  it('accepts SHA-256 commit names', () => {
    const sha = 'c'.repeat(64);
    const [record] = parseLogRecords(logOutput([sha, 'ccccccc', '1', 'A', 's', 's\n']));
    expect(record?.sha).toBe(sha);
  });

  it('returns nothing for empty output', () => {
    expect(parseLogRecords('')).toEqual([]);
    expect(parseLogRecords('\x00\x00')).toEqual([]);
    expect(parseLogRecords('\n')).toEqual([]);
  });

  it('skips a record whose first field is not a commit SHA', () => {
    const records = parseLogRecords(
      logOutput(
        ['warning: something', 'x', '1', 'A', 's', message('s', link(HEX))],
        [SHA_A, 'aaaaaaa', '1', 'A', 's', message('s', link(HEX))],
      ),
    );
    expect(records.map((record) => record.sha)).toEqual([SHA_A]);
  });

  it('defaults a missing short SHA and an unreadable time', () => {
    const [record] = parseLogRecords(logOutput([SHA_A, '', 'soon', 'A', 's', 's\n']));
    expect(record?.shortSha).toBe('aaaaaaa');
    expect(record?.authorTime).toBe(0);
  });
});

describe('trailers through real git log', () => {
  const git = new Git(exec, new Lane(4));
  let repo: FixtureRepo;

  beforeAll(() => isolateGitConfig());
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => {
    repo = createFixtureRepo();
  });
  afterEach(() => repo.dispose());

  it('round-trips subjects, authors, times, and checkpoint trailers', async () => {
    const plain = repo.commit('Plain commit with no trailer');
    const one = repo.commit('One checkpoint', [`Entire-Checkpoint: ${HEX}`]);
    const several = repo.commit('fix: "quotes", commas, and ünïcode', [
      `Entire-Checkpoint: ${ULID}`,
      `Entire-Checkpoint: ${HEX}`,
      `Entire-Checkpoint: ${ULID}`,
      'Entire-Checkpoint: not-an-id',
      'Signed-off-by: Fixture Author <fixture@example.com>',
    ]);

    const window = await git.logWindow(repo.root, several, 0, 10);
    expect(window.ok).toBe(true);
    if (!window.ok) return;

    expect(window.value.map((record) => record.sha)).toEqual([several, one, plain]);
    expect(window.value.map((record) => record.checkpointIds)).toEqual([[ULID, HEX], [HEX], []]);
    expect(window.value.map((record) => record.subject)).toEqual([
      'fix: "quotes", commas, and ünïcode',
      'One checkpoint',
      'Plain commit with no trailer',
    ]);
    for (const record of window.value) {
      expect(record.author).toBe('Fixture Author');
      expect(record.sha.startsWith(record.shortSha)).toBe(true);
      expect(record.shortSha.length).toBeGreaterThanOrEqual(4);
      expect(record.authorTime).toBe(Number(repo.git('log', '-1', '--format=%at', record.sha)));
    }
  });

  it('reads the trailers that sit beside other trailers in the last paragraph', async () => {
    const tip = repo.commit('Several kinds of trailer', [
      'Reviewed-by: Someone Else <someone@example.com>',
      `Entire-Checkpoint: ${HEX}`,
      'Entire-Agent: Claude Code',
      `Entire-Checkpoint: ${ULID}`,
      'Co-authored-by: Someone Else <someone@example.com>',
    ]);
    const window = await git.logWindow(repo.root, tip, 0, 10);
    expect(window.ok && window.value[0]?.checkpointIds).toEqual([HEX, ULID]);
  });

  // A squash merge joins the messages of the squashed commits, so each
  // `Entire-Checkpoint` line ends its own paragraph. The Entire CLI reads the
  // whole message for this reason (`ParseAllCheckpoints`), where git's own
  // trailer parsing would report only the last paragraph.
  it('reads every checkpoint of a squash-merge commit', async () => {
    const tip = repo.commit('Add the parser and fix the lexer (#12)', [
      '* Add the parser',
      '',
      `Entire-Checkpoint: ${HEX}`,
      '',
      '* Fix the lexer',
      '',
      `Entire-Checkpoint: ${ULID}`,
    ]);
    const window = await git.logWindow(repo.root, tip, 0, 10);
    expect(window.ok && window.value[0]?.checkpointIds).toEqual([HEX, ULID]);
  });

  it('reads the checkpoints of a squash-merge commit whose last paragraph holds other trailers', async () => {
    const tip = repo.commit('Add the parser and fix the lexer (#13)', [
      '* Add the parser',
      '',
      `Entire-Checkpoint: ${HEX}`,
      '',
      '* Fix the lexer',
      '',
      `Entire-Checkpoint: ${ULID}`,
      '',
      'Co-authored-by: Someone Else <someone@example.com>',
    ]);
    const window = await git.logWindow(repo.root, tip, 0, 10);
    expect(window.ok && window.value[0]?.checkpointIds).toEqual([HEX, ULID]);
  });
});
