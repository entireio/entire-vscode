import { describe, expect, it } from 'vitest';
import { parseCheckpointAuthor, parseCliText } from '../../../src/core/transcript/cliText';
import { toWireTurn, type FullTurn } from '../../../src/core/transcript/model';

/**
 * A synthetic sample with the shape of `entire checkpoint explain --full`
 * from CLI 0.13.3: a header block, a plain rule, Markdown sections, a
 * `Transcript` rule, then entries separated by blank lines.
 */
const HEADER = [
  '● Checkpoint 01HZXK3M5N7P9R2T4V6W8Y0A1B',
  '  session  11111111-2222-4333-8444-555555555555',
  '  created  2026-01-02 03:04:05',
  '  author   Fixture Author <fixture@example.com>',
  '  tokens   12.4k',
  '  commits  abc1234 docs(changelog): tidy the changelog',
  '────────────────────────────────────────────────────────────',
  '## Intent',
  '',
  'Tidy the changelog',
  '',
  '## Summary',
  '',
  '*Not generated yet. Run ‘entire checkpoint explain --generate 01HZXK3M5N7P9R2T4V6W8Y0A1B‘ to create an AI summary.*',
  '',
  '## Files (1)',
  '',
  '- `CHANGELOG.md`',
  '',
];
const RULE = '── Transcript (full session) ───────────────────────────────';

const SAMPLE = [
  ...HEADER,
  RULE,
  '[User] Tidy the changelog | docs',
  '',
  'Is the Upcoming section still needed?',
  '',
  "[Assistant] I'll check the changelog first.",
  '',
  '[Tool] Bash: List the changelog entries',
  '',
  '[Tool] Read: /repo/CHANGELOG.md',
  '',
  '[Assistant] The entry is stale: nothing refers to it.',
  '',
  'Removing it now.',
  '',
  '[Tool] Edit: /repo/CHANGELOG.md',
  '',
  '[Assistant] Done.',
  '',
  '[User] Thanks',
  '',
].join('\n');

function shape(turns: FullTurn[]): unknown[] {
  return turns.map((turn) => [
    turn.role,
    turn.blocks.map((block) => (block.kind === 'tool' ? `tool:${block.name}` : block.kind === 'text' ? block.text : block.kind)),
  ]);
}

describe('parseCliText', () => {
  it('reads the entries after the Transcript rule into turns', () => {
    const parsed = parseCliText(SAMPLE);
    expect(shape(parsed.turns)).toEqual([
      ['user', ['Tidy the changelog | docs\n\nIs the Upcoming section still needed?']],
      [
        'assistant',
        [
          "I'll check the changelog first.",
          'tool:Bash',
          'tool:Read',
          'The entry is stale: nothing refers to it.\n\nRemoving it now.',
          'tool:Edit',
          'Done.',
        ],
      ],
      ['user', ['Thanks']],
    ]);
  });

  it('always starts at the first turn, because the text has no checkpoint boundary', () => {
    expect(parseCliText(SAMPLE).startTurn).toBe(0);
  });

  it('keeps the header out of the transcript', () => {
    const everything = JSON.stringify(parseCliText(SAMPLE).turns);
    for (const headerText of ['Checkpoint 01HZXK3M5N7P9R2T4V6W8Y0A1B', 'fixture@example.com', '## Intent', '## Files', 'Not generated yet']) {
      expect(everything).not.toContain(headerText);
    }
  });

  it('reads a tool entry as a tool call named before the colon and described after it', () => {
    const [, assistant] = parseCliText(SAMPLE).turns;
    expect(assistant?.blocks.filter((block) => block.kind === 'tool')).toStrictEqual([
      { kind: 'tool', name: 'Bash', input: 'List the changelog entries' },
      { kind: 'tool', name: 'Read', input: '/repo/CHANGELOG.md' },
      { kind: 'tool', name: 'Edit', input: '/repo/CHANGELOG.md' },
    ]);
  });

  it('gives the wire turn a summary for each tool call', () => {
    const [, assistant] = parseCliText(SAMPLE).turns;
    const wire = assistant ? toWireTurn(assistant, 1) : undefined;
    expect(wire?.blocks[1]).toStrictEqual({
      kind: 'tool',
      block: 1,
      name: 'Bash',
      summary: 'List the changelog entries',
      hasBody: true,
    });
  });

  it('splits a tool entry at the first colon only', () => {
    const parsed = parseCliText([RULE, '[Tool] Bash: Run the suite: unit and e2e'].join('\n'));
    expect(parsed.turns[0]?.blocks).toStrictEqual([{ kind: 'tool', name: 'Bash', input: 'Run the suite: unit and e2e' }]);
  });

  it('reads a tool entry with no description', () => {
    const parsed = parseCliText([RULE, '[User] Go', '', '[Tool] TodoWrite', ''].join('\n'));
    expect(parsed.turns[1]?.blocks).toStrictEqual([{ kind: 'tool', name: 'TodoWrite', input: '' }]);
  });

  it('starts an assistant turn for a tool entry that follows a user entry', () => {
    const parsed = parseCliText([RULE, '[User] Run the tests', '', '[Tool] Bash: Run the test suite', '', '[Assistant] They pass.'].join('\n'));
    expect(shape(parsed.turns)).toEqual([
      ['user', ['Run the tests']],
      ['assistant', ['tool:Bash', 'They pass.']],
    ]);
  });

  it('puts consecutive assistant entries in one turn', () => {
    const parsed = parseCliText([RULE, '[Assistant] One.', '', '[Assistant] Two.', '', '[User] Next'].join('\n'));
    expect(shape(parsed.turns)).toEqual([
      ['assistant', ['One.', 'Two.']],
      ['user', ['Next']],
    ]);
  });

  it('keeps consecutive user entries as separate turns', () => {
    const parsed = parseCliText([RULE, '[User] One', '', '[User] Two'].join('\n'));
    expect(shape(parsed.turns)).toEqual([
      ['user', ['One']],
      ['user', ['Two']],
    ]);
  });

  it('keeps the lines of a multi-line entry, including code fences and indentation', () => {
    const body = ['Here is the fix:', '', '```ts', 'if (x) {', '  return 1;', '}', '```'];
    const parsed = parseCliText([RULE, `[Assistant] ${body[0]}`, ...body.slice(1), '', '[User] ok'].join('\n'));
    expect(parsed.turns[0]?.blocks).toStrictEqual([{ kind: 'text', text: body.join('\n') }]);
  });

  it('reads an entry whose text starts on the line after the marker', () => {
    const parsed = parseCliText([RULE, '[User]', 'The prompt is down here.', ''].join('\n'));
    expect(shape(parsed.turns)).toEqual([['user', ['The prompt is down here.']]]);
  });

  it('does not treat brackets in the middle of a line, or other bracketed words, as markers', () => {
    const parsed = parseCliText([RULE, '[User] See the [Assistant] docs', '[Note] this is not a marker', '  [Tool] nor is this'].join('\n'));
    expect(shape(parsed.turns)).toEqual([['user', ['See the [Assistant] docs\n[Note] this is not a marker\n  [Tool] nor is this']]]);
  });

  it('recognizes a Transcript rule with a different label', () => {
    const parsed = parseCliText([...HEADER, '── Transcript ────────────────────', '[User] Hello'].join('\n'));
    expect(shape(parsed.turns)).toEqual([['user', ['Hello']]]);
  });

  it('reads the entries when the output has no Transcript rule, leaving the header out', () => {
    const parsed = parseCliText([...HEADER, '[User] Hello', '', '[Assistant] Hi'].join('\n'));
    expect(shape(parsed.turns)).toEqual([
      ['user', ['Hello']],
      ['assistant', ['Hi']],
    ]);
  });

  // The entry marker is matched with `.` and `$`, and `.` does not match a
  // carriage return, so a marker line that contains one is not seen as a
  // marker. A prompt pasted with CRLF line endings is enough to cause it.
  it('recognizes an entry whose first line ends with a carriage return', () => {
    const parsed = parseCliText([RULE, '[User] First line of a pasted prompt\r', 'second line', '', '[Assistant] Hi'].join('\n'));
    expect(parsed.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    const [prompt] = parsed.turns[0]?.blocks ?? [];
    expect(prompt?.kind === 'text' && prompt.text).toContain('First line of a pasted prompt');
    expect(prompt?.kind === 'text' && prompt.text).toContain('second line');
  });

  it('reads output that uses Windows line endings throughout', () => {
    const parsed = parseCliText([RULE, '[User] Hello', '', '[Assistant] Hi', '', '[Tool] Bash: List files', ''].join('\r\n'));
    expect(shape(parsed.turns)).toEqual([
      ['user', ['Hello']],
      ['assistant', ['Hi', 'tool:Bash']],
    ]);
  });
});

describe('parseCliText with no entry markers', () => {
  it('shows the transcript section as one text turn', () => {
    const parsed = parseCliText([...HEADER, RULE, 'The agent wrote the transcript in a format', 'this CLI version prints verbatim.', ''].join('\n'));
    expect(parsed).toStrictEqual({
      turns: [
        {
          role: 'assistant',
          blocks: [{ kind: 'text', text: 'The agent wrote the transcript in a format\nthis CLI version prints verbatim.' }],
        },
      ],
      startTurn: 0,
    });
  });

  it('shows the whole output as one text turn when there is no rule either', () => {
    const output = 'Something unexpected\nacross two lines\n';
    expect(parseCliText(output)).toStrictEqual({
      turns: [{ role: 'assistant', blocks: [{ kind: 'text', text: 'Something unexpected\nacross two lines' }] }],
      startTurn: 0,
    });
  });

  it.each(['', '\n\n', '   \n  '])('returns no turns for the empty output %j', (output) => {
    expect(parseCliText(output)).toStrictEqual({ turns: [], startTurn: 0 });
  });

  it('returns no turns when the transcript section is empty', () => {
    expect(parseCliText([...HEADER, RULE, '', ''].join('\n'))).toStrictEqual({ turns: [], startTurn: 0 });
  });
});

describe('parseCheckpointAuthor', () => {
  /** The header of `entire checkpoint explain --short`, with the given author line. */
  const short = (author?: string): string =>
    [
      '● Checkpoint 01HZXK3M5N7P9R2T4V6W8Y0A1B',
      '  session  11111111-2222-4333-8444-555555555555',
      '  created  2026-01-02 03:04:05',
      ...(author === undefined ? [] : [author]),
      '  tokens   12.4k',
      '  commits  (none on this branch)',
      '────────────────────────────────────────────────────────────',
      '## Intent',
      '',
      'Tidy the changelog',
      '',
    ].join('\n');

  it('reads the name from the author line of the header, without the address', () => {
    expect(parseCheckpointAuthor(short('  author   Fixture Author <fixture@example.com>'))).toBe('Fixture Author');
    expect(parseCheckpointAuthor(HEADER.join('\n'))).toBe('Fixture Author');
  });

  it.each([
    ['a name alone', '  author   Ada Lovelace', 'Ada Lovelace'],
    ['a name with brackets of its own', '  author   Ada (she/her) Lovelace <ada@example.com>', 'Ada (she/her) Lovelace'],
    ['an address alone', '  author   <ada@example.com>', 'ada@example.com'],
    ['a name with no space before the address', '  author   Ada<ada@example.com>', 'Ada'],
    ['an empty address', '  author   Ada Lovelace <>', 'Ada Lovelace'],
    ['a tab between the label and the name', '\tauthor\tAda Lovelace <ada@example.com>', 'Ada Lovelace'],
    ['Windows line endings', '  author   Ada Lovelace <ada@example.com>\r', 'Ada Lovelace'],
    ['a line with no indent', 'author   Ada Lovelace <ada@example.com>', 'Ada Lovelace'],
  ])('reads %s', (_label, line, expected) => {
    expect(parseCheckpointAuthor(short(line))).toBe(expected);
  });

  it.each([
    ['no author line', undefined],
    ['an author line with nothing after the label', '  author   '],
    ['an author line with an empty address and no name', '  author   <>'],
    ['a line that only starts with the word', '  authors  Ada Lovelace'],
    ['the word as part of a longer label', '  coauthor Ada Lovelace'],
  ])('finds no author in a header with %s', (_label, line) => {
    expect(parseCheckpointAuthor(short(line))).toBeUndefined();
  });

  it('does not take a line of the text below the header for the author', () => {
    const body = short().replace('Tidy the changelog', '  author   Someone Else <else@example.com>');
    expect(parseCheckpointAuthor(body)).toBeUndefined();
    // Nor a line far down an output that has no rule at all.
    const unruled = [...Array.from({ length: 60 }, (_, n) => `  line     ${n}`), '  author   Too Late'].join('\n');
    expect(parseCheckpointAuthor(unruled)).toBeUndefined();
  });

  it('cuts a name that runs on, since it is drawn beside each prompt', () => {
    expect(parseCheckpointAuthor(short(`  author   ${'A'.repeat(200)} <a@example.com>`))).toBe('A'.repeat(80));
  });

  it('finds nothing in empty output', () => {
    expect(parseCheckpointAuthor('')).toBeUndefined();
  });
});
