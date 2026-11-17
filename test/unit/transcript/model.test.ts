import { describe, expect, it } from 'vitest';
import { toolInputText, toolSummary, toWireTurn, type FullTurn } from '../../../src/core/transcript/model';
import { isWellFormed } from '../support';

/** The documented order: most descriptive first. */
const PRIORITY = ['description', 'command', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'skill', 'subject'];

describe('toolSummary', () => {
  it.each(PRIORITY.map((key, position) => [key, position] as const))(
    'prefers %s over every key that ranks below it',
    (key, position) => {
      // Lower-ranked keys come first in the object, so insertion order cannot explain the result.
      const lower = PRIORITY.slice(position + 1).reverse();
      const input = Object.fromEntries([...lower, key].map((name) => [name, `${name} value`]));
      expect(toolSummary(input)).toBe(`${key} value`);
    },
  );

  it('prefers a known key over an unknown key that comes first', () => {
    expect(toolSummary({ timeout: '30s', note: 'first string', command: 'git status' })).toBe('git status');
  });

  it('skips a preferred key whose value is empty, blank, or not a string', () => {
    expect(toolSummary({ description: '', command: 'git status' })).toBe('git status');
    expect(toolSummary({ description: '  \n ', command: 'git status' })).toBe('git status');
    expect(toolSummary({ description: 42, command: 'git status' })).toBe('git status');
    expect(toolSummary({ description: null, command: { nested: true }, file_path: '/repo/a.ts' })).toBe('/repo/a.ts');
  });

  it('falls back to the first non-empty string value of any key', () => {
    expect(toolSummary({ count: 3, empty: '', label: 'hello', other: 'world' })).toBe('hello');
  });

  it.each([
    ['an empty object', {}],
    ['an object with no string values', { count: 3, nested: { command: 'hidden' }, flag: true }],
    ['null', null],
    ['undefined', undefined],
    ['a number', 7],
    ['a boolean', true],
  ])('is empty for %s', (_label, input) => {
    expect(toolSummary(input)).toBe('');
  });

  it('uses a string input directly', () => {
    expect(toolSummary('List the changelog entries')).toBe('List the changelog entries');
    expect(toolSummary('   ')).toBe('');
    expect(toolSummary('')).toBe('');
  });

  it('uses the first non-empty line, trimmed', () => {
    expect(toolSummary({ command: '\n\n   git status  \ngit diff\n' })).toBe('git status');
    expect(toolSummary('\n  first line\nsecond line')).toBe('first line');
  });

  it('leaves a line of exactly 160 characters alone', () => {
    const line = 'x'.repeat(160);
    expect(toolSummary({ command: line })).toBe(line);
  });

  it('truncates a longer line to 160 characters, ending with an ellipsis', () => {
    const summary = toolSummary({ command: 'x'.repeat(161) });
    expect(summary).toHaveLength(160);
    expect(summary).toBe(`${'x'.repeat(159)}…`);
    expect(toolSummary('y'.repeat(5000))).toHaveLength(160);
  });

  it('truncates after trimming, so leading whitespace does not count', () => {
    expect(toolSummary({ command: `     ${'x'.repeat(160)}     ` })).toBe('x'.repeat(160));
  });

  // Cutting between the two halves of a surrogate pair leaves a lone
  // surrogate, which renders as a replacement character.
  it('does not cut an emoji in half when truncating', () => {
    const summary = toolSummary({ description: `${'x'.repeat(158)}😀 and then more text follows` });
    expect(isWellFormed(summary)).toBe(true);
  });
});

describe('toolInputText', () => {
  it.each([undefined, null])('is empty for %j', (input) => {
    expect(toolInputText(input)).toBe('');
  });

  it('returns a string input unchanged', () => {
    expect(toolInputText('ls -la\n')).toBe('ls -la\n');
    expect(toolInputText('')).toBe('');
  });

  it('pretty-prints structured input as JSON that parses back', () => {
    const input = { command: 'git status', options: ['-s', '-b'], timeout: 30 };
    const text = toolInputText(input);
    expect(JSON.parse(text)).toEqual(input);
    expect(text.split('\n').length).toBeGreaterThan(1);
  });

  it('does not throw on input that JSON cannot represent', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    expect(typeof toolInputText(circular)).toBe('string');
    expect(toolInputText(10n)).toBe('10');
  });
});

describe('toWireTurn', () => {
  it('carries the index, the role, and the timestamp', () => {
    const turn: FullTurn = { role: 'user', ts: '2026-01-02T03:04:05Z', blocks: [{ kind: 'text', text: 'Hello' }] };
    expect(toWireTurn(turn, 7)).toStrictEqual({
      index: 7,
      role: 'user',
      ts: '2026-01-02T03:04:05Z',
      blocks: [{ kind: 'text', text: 'Hello' }],
    });
  });

  it('leaves the timestamp absent when the turn has none', () => {
    const wire = toWireTurn({ role: 'assistant', blocks: [{ kind: 'note', text: 'Unsupported block: video' }] }, 0);
    expect(wire).toStrictEqual({ index: 0, role: 'assistant', blocks: [{ kind: 'note', text: 'Unsupported block: video' }] });
  });

  it('strips the input and output of a tool call, keeping a one-line summary', () => {
    const turn: FullTurn = {
      role: 'assistant',
      blocks: [
        {
          kind: 'tool',
          name: 'Bash',
          input: { command: 'cat secrets.env', description: 'Print the environment file' },
          output: 'API_KEY=very-secret-value',
          status: 'success',
        },
      ],
    };
    const wire = toWireTurn(turn, 3);
    expect(wire.blocks).toStrictEqual([
      { kind: 'tool', block: 0, name: 'Bash', summary: 'Print the environment file', hasBody: true, status: 'success' },
    ]);
    expect(JSON.stringify(wire)).not.toContain('very-secret-value');
    expect(JSON.stringify(wire)).not.toContain('cat secrets.env');
  });

  it('strips image data and asset paths, keeping only the media type', () => {
    const turn: FullTurn = {
      role: 'user',
      blocks: [
        { kind: 'image', mediaType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==' },
        { kind: 'image', mediaType: 'image/jpeg', assetPath: 'assets/img-0a1b.jpg' },
        { kind: 'image', base64: 'AAAA' },
      ],
    };
    const wire = toWireTurn(turn, 0);
    expect(wire.blocks).toStrictEqual([
      { kind: 'image', block: 0, mediaType: 'image/png' },
      { kind: 'image', block: 1, mediaType: 'image/jpeg' },
      { kind: 'image', block: 2 },
    ]);
    expect(JSON.stringify(wire)).not.toContain('iVBOR');
    expect(JSON.stringify(wire)).not.toContain('assets/');
  });

  it('numbers tool and image blocks by their position among all blocks of the turn', () => {
    const turn: FullTurn = {
      role: 'assistant',
      blocks: [
        { kind: 'text', text: 'Looking.' },
        { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' } },
        { kind: 'note', text: 'Unsupported block: video' },
        { kind: 'image', mediaType: 'image/png', base64: 'AAAA' },
        { kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'a.ts' },
      ],
    };
    const wire = toWireTurn(turn, 1);
    expect(wire.blocks.map((block) => block.kind)).toEqual(['text', 'tool', 'note', 'image', 'tool']);
    expect(wire.blocks.map((block) => ('block' in block ? block.block : undefined))).toEqual([undefined, 1, undefined, 3, 4]);
    // The position must lead back to the same block on the host.
    wire.blocks.forEach((block, position) => {
      if ('block' in block) expect(turn.blocks[block.block]?.kind).toBe(turn.blocks[position]?.kind);
    });
  });

  it.each<[string, unknown, string | undefined, boolean]>([
    ['structured input and a result', { command: 'ls' }, 'a.ts', true],
    ['structured input only', { command: 'ls' }, undefined, true],
    ['a result only', undefined, 'a.ts', true],
    ['a one-line text input, as the CLI text view gives', 'List the files', undefined, true],
    ['no input and no result', undefined, undefined, false],
    ['a null input and no result', null, undefined, false],
    ['an empty text input and no result', '', undefined, false],
    ['an empty text input and an empty result', '', '', false],
    ['no input and an empty result', undefined, '', false],
  ])('sets hasBody for %s', (_label, input, output, expected) => {
    const turn: FullTurn = {
      role: 'assistant',
      blocks: [output === undefined ? { kind: 'tool', name: 'Tool', input } : { kind: 'tool', name: 'Tool', input, output }],
    };
    const [block] = toWireTurn(turn, 0).blocks;
    expect(block?.kind === 'tool' && block.hasBody).toBe(expected);
  });

  it('includes the status only when the source recorded one', () => {
    const turn: FullTurn = {
      role: 'assistant',
      blocks: [
        { kind: 'tool', name: 'Bash', input: 'false', output: 'exit 1', status: 'error' },
        { kind: 'tool', name: 'Bash', input: 'true' },
      ],
    };
    const [failed, unknown] = toWireTurn(turn, 0).blocks;
    expect(failed).toMatchObject({ status: 'error' });
    expect(unknown).not.toHaveProperty('status');
  });

  it('gives a tool call with nothing to summarize an empty summary', () => {
    const [block] = toWireTurn({ role: 'assistant', blocks: [{ kind: 'tool', name: 'Stop', input: undefined }] }, 0).blocks;
    expect(block).toStrictEqual({ kind: 'tool', block: 0, name: 'Stop', summary: '', hasBody: false });
  });

  it('does not change the turn it reads', () => {
    const turn: FullTurn = {
      role: 'assistant',
      ts: '2026-01-02T03:04:05Z',
      blocks: [
        { kind: 'text', text: 'x' },
        { kind: 'tool', name: 'Bash', input: { command: 'ls' }, output: 'out', status: 'success' },
        { kind: 'image', mediaType: 'image/png', base64: 'AAAA' },
      ],
    };
    const before = structuredClone(turn);
    toWireTurn(turn, 0);
    expect(turn).toStrictEqual(before);
  });

  it('works as a map callback over a list of turns', () => {
    const turns: FullTurn[] = [
      { role: 'user', blocks: [{ kind: 'text', text: 'one' }] },
      { role: 'assistant', blocks: [{ kind: 'text', text: 'two' }] },
    ];
    expect(turns.map(toWireTurn).map((turn) => turn.index)).toEqual([0, 1]);
  });
});
