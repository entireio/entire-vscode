import { describe, expect, it } from 'vitest';
import type { FullBlock, FullTurn } from '../../../src/core/transcript/model';
import { parseCompactTranscript } from '../../../src/core/transcript/normalize';
import { transcriptLine } from '../../helpers/fixtureRepo';

const user = (text: string, extra: Record<string, unknown> = {}): string => transcriptLine('user', [{ text }], extra);
const assistant = (text: string, extra: Record<string, unknown> = {}): string =>
  transcriptLine('assistant', [{ type: 'text', text }], extra);
/** A user line that held only a tool result, which the format folds into the tool call. */
const foldedToolResult = (): string => transcriptLine('user', []);
const file = (...lines: string[]): string => `${lines.join('\n')}\n`;

function texts(turn: FullTurn | undefined): string[] {
  return (turn?.blocks ?? []).flatMap((block) => (block.kind === 'text' ? [block.text] : []));
}

/** Parses one line and returns the blocks of its only turn. */
function blocksOf(type: 'user' | 'assistant', content: unknown): FullBlock[] {
  const { turns } = parseCompactTranscript(file(transcriptLine(type, content)), null);
  expect(turns.length).toBeLessThanOrEqual(1);
  return turns[0]?.blocks ?? [];
}

describe('parseCompactTranscript turns', () => {
  it('reads a user line and an assistant line as two turns', () => {
    const parsed = parseCompactTranscript(file(user('Hello'), assistant('Hi there')), null);
    expect(parsed.turns).toStrictEqual([
      { role: 'user', ts: '2026-01-02T03:04:05Z', blocks: [{ kind: 'text', text: 'Hello' }] },
      { role: 'assistant', ts: '2026-01-02T03:04:05Z', blocks: [{ kind: 'text', text: 'Hi there' }] },
    ]);
    expect(parsed.startTurn).toBe(0);
  });

  it('merges consecutive assistant lines into one turn, keeping block order', () => {
    const parsed = parseCompactTranscript(
      file(
        user('Do the thing'),
        assistant('First'),
        transcriptLine('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }]),
        assistant('Last'),
      ),
      null,
    );
    expect(parsed.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(parsed.turns[1]?.blocks.map((block) => block.kind)).toEqual(['text', 'tool', 'text']);
    expect(texts(parsed.turns[1])).toEqual(['First', 'Last']);
  });

  it('gives a merged turn the timestamp of its first line', () => {
    const parsed = parseCompactTranscript(
      file(assistant('one', { ts: '2026-01-01T00:00:00Z' }), assistant('two', { ts: '2026-01-01T00:05:00Z' })),
      null,
    );
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0]?.ts).toBe('2026-01-01T00:00:00Z');
  });

  it('starts a new assistant turn after a user turn', () => {
    const parsed = parseCompactTranscript(file(assistant('a1'), user('B'), assistant('b1'), assistant('b2')), null);
    expect(parsed.turns.map((turn) => [turn.role, texts(turn)])).toEqual([
      ['assistant', ['a1']],
      ['user', ['B']],
      ['assistant', ['b1', 'b2']],
    ]);
  });

  it('keeps consecutive user lines as separate turns', () => {
    const parsed = parseCompactTranscript(file(user('one'), user('two')), null);
    expect(parsed.turns.map((turn) => [turn.role, texts(turn)])).toEqual([
      ['user', ['one']],
      ['user', ['two']],
    ]);
  });

  it.each([
    ['an empty block list', []],
    ['null content', null],
    ['an empty text block', [{ text: '' }]],
    ['a whitespace-only text block', [{ text: '  \n ' }]],
    ['an empty string', ''],
    ['a whitespace-only string', ' \n\t'],
  ])('drops a user line with no text: %s', (_label, content) => {
    const parsed = parseCompactTranscript(file(user('A'), transcriptLine('user', content), assistant('a')), null);
    expect(parsed.turns.map((turn) => [turn.role, texts(turn)])).toEqual([
      ['user', ['A']],
      ['assistant', ['a']],
    ]);
  });

  it('keeps one assistant turn across a dropped tool-result line', () => {
    const parsed = parseCompactTranscript(
      file(user('A'), assistant('before the tool'), foldedToolResult(), assistant('after the tool')),
      null,
    );
    expect(parsed.turns.map((turn) => [turn.role, texts(turn)])).toEqual([
      ['user', ['A']],
      ['assistant', ['before the tool', 'after the tool']],
    ]);
  });

  it('drops an assistant line with no blocks', () => {
    const parsed = parseCompactTranscript(file(user('A'), transcriptLine('assistant', null), user('B')), null);
    expect(parsed.turns.map((turn) => texts(turn))).toEqual([['A'], ['B']]);
  });

  it('reads string content as one text block', () => {
    expect(blocksOf('assistant', 'Plain string content')).toStrictEqual([{ kind: 'text', text: 'Plain string content' }]);
    expect(blocksOf('user', 'A prompt')).toStrictEqual([{ kind: 'text', text: 'A prompt' }]);
  });

  it.each([42, true, { text: 'not a list' }])('reads the non-list content %j as no blocks', (content) => {
    expect(blocksOf('assistant', content)).toEqual([]);
  });

  it.each([
    ['missing', {}],
    ['empty', { ts: '' }],
    ['a number', { ts: 1_700_000_000 }],
    ['null', { ts: null }],
  ])('leaves the timestamp absent when ts is %s', (_label, extra) => {
    const line = JSON.stringify({ v: 1, type: 'user', content: [{ text: 'Hello' }], ...extra });
    const parsed = parseCompactTranscript(file(line), null);
    expect(parsed.turns).toStrictEqual([{ role: 'user', blocks: [{ kind: 'text', text: 'Hello' }] }]);
  });

  it('ignores unknown fields on a line', () => {
    const parsed = parseCompactTranscript(
      file(user('Hello', { cli_version: '0.13.3', id: 'msg_1', input_tokens: 9, future_field: { nested: true } })),
      null,
    );
    expect(parsed.turns).toStrictEqual([
      { role: 'user', ts: '2026-01-02T03:04:05Z', blocks: [{ kind: 'text', text: 'Hello' }] },
    ]);
  });

  it('tolerates blank lines, Windows line endings, and a missing final newline', () => {
    const parsed = parseCompactTranscript(`${user('A')}\r\n\r\n${assistant('a')}\r\n   \r\n${user('B')}`, null);
    expect(parsed.turns.map((turn) => texts(turn))).toEqual([['A'], ['a'], ['B']]);
  });

  it.each(['', '\n', '\n\n  \n'])('returns no turns for the empty transcript %j', (text) => {
    expect(parseCompactTranscript(text, null)).toStrictEqual({ turns: [], startTurn: 0 });
    expect(parseCompactTranscript(text, 3)).toStrictEqual({ turns: [], startTurn: 0 });
  });
});

describe('parseCompactTranscript skipped lines', () => {
  it.each(['system', 'summary', 'tool', 'USER', ''])('skips a line with the unknown type %j', (type) => {
    const unknown = JSON.stringify({ v: 1, type, content: [{ type: 'text', text: 'should not appear' }] });
    const parsed = parseCompactTranscript(file(user('A'), unknown, user('B')), null);
    expect(parsed.turns.map((turn) => texts(turn))).toEqual([['A'], ['B']]);
  });

  // The format bumps `v` only for a breaking change, and its reference reader
  // (the CLI's `transcript.Decode`) skips a line whose `v` is not 1. This
  // reader does not look at `v`, so it would read a v2 line as if it were v1.
  it('skips a line of a later format version, which a v1 reader cannot interpret', () => {
    const v2 = JSON.stringify({ v: 2, type: 'assistant', content: [{ type: 'text', text: 'shape may differ in v2' }] });
    const parsed = parseCompactTranscript(file(user('A'), v2, user('B')), null);
    expect(parsed.turns.map((turn) => texts(turn))).toEqual([['A'], ['B']]);
  });

  it('skips a line with no type', () => {
    const parsed = parseCompactTranscript(file(JSON.stringify({ v: 1, content: [{ text: 'x' }] }), user('B')), null);
    expect(parsed.turns.map((turn) => texts(turn))).toEqual([['B']]);
  });

  it.each([
    ['truncated JSON', '{"v":1,"type":"user","content":[{"text":"cut off'],
    ['prose', 'this is not JSON'],
    ['a JSON array', '[{"type":"user"}]'],
    ['a JSON string', '"user"'],
    ['a JSON number', '42'],
    ['JSON null', 'null'],
  ])('skips an invalid line: %s', (_label, line) => {
    const parsed = parseCompactTranscript(file(user('A'), line, assistant('a')), null);
    expect(parsed.turns.map((turn) => [turn.role, texts(turn)])).toEqual([
      ['user', ['A']],
      ['assistant', ['a']],
    ]);
  });
});

describe('parseCompactTranscript blocks', () => {
  it('reads a user text block, which has no type', () => {
    expect(blocksOf('user', [{ id: 'p1', text: 'A prompt' }])).toStrictEqual([{ kind: 'text', text: 'A prompt' }]);
  });

  it('reads a typed text block on either kind of line', () => {
    expect(blocksOf('assistant', [{ type: 'text', text: 'A reply' }])).toStrictEqual([{ kind: 'text', text: 'A reply' }]);
    expect(blocksOf('user', [{ type: 'text', text: 'A prompt' }])).toStrictEqual([{ kind: 'text', text: 'A prompt' }]);
    expect(blocksOf('assistant', [{ text: 'Untyped reply' }])).toStrictEqual([{ kind: 'text', text: 'Untyped reply' }]);
  });

  it('keeps text exactly, including Markdown and surrounding whitespace', () => {
    const text = '  # Title\n\n```ts\nconst x = 1;\n```\n';
    expect(blocksOf('assistant', [{ type: 'text', text }])).toStrictEqual([{ kind: 'text', text }]);
  });

  it('drops empty text blocks and keeps the others', () => {
    expect(
      blocksOf('assistant', [{ type: 'text', text: '' }, { type: 'text', text: 'kept' }, { type: 'text', text: '   ' }]),
    ).toStrictEqual([{ kind: 'text', text: 'kept' }]);
  });

  it('reads a tool call with its folded-in result', () => {
    const input = { command: 'git status', description: 'Show the working tree' };
    expect(
      blocksOf('assistant', [
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input, result: { output: 'On branch main', status: 'success' } },
      ]),
    ).toStrictEqual([{ kind: 'tool', name: 'Bash', input, output: 'On branch main', status: 'success' }]);
  });

  it('reads a failed tool call', () => {
    const [block] = blocksOf('assistant', [
      { type: 'tool_use', name: 'Bash', input: { command: 'false' }, result: { output: 'exit 1', status: 'error' } },
    ]);
    expect(block).toMatchObject({ kind: 'tool', status: 'error', output: 'exit 1' });
  });

  it('reads a tool call that has no result yet', () => {
    expect(blocksOf('assistant', [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }])).toStrictEqual([
      { kind: 'tool', name: 'Read', input: { file_path: '/repo/a.ts' } },
    ]);
  });

  it('keeps an empty result output, and ignores a status it does not know', () => {
    const [block] = blocksOf('assistant', [
      { type: 'tool_use', name: 'Bash', input: {}, result: { output: '', status: 'cancelled' } },
    ]);
    expect(block).toStrictEqual({ kind: 'tool', name: 'Bash', input: {}, output: '' });
  });

  it('ignores a result of the wrong type', () => {
    const [block] = blocksOf('assistant', [{ type: 'tool_use', name: 'Bash', input: 'ls', result: 'done' }]);
    expect(block).toStrictEqual({ kind: 'tool', name: 'Bash', input: 'ls' });
  });

  it.each([undefined, '', 7])('names a tool call with the name %j "Tool"', (name) => {
    const [block] = blocksOf('assistant', [{ type: 'tool_use', name, input: {} }]);
    expect(block).toMatchObject({ kind: 'tool', name: 'Tool' });
  });

  it.each(['thinking', 'redacted_thinking', 'tool_result', 'video', 'server_tool_use'])(
    'turns the unknown block type %s into a note that names it',
    (type) => {
      const blocks = blocksOf('assistant', [{ type, payload: 'secret payload that must not be shown' }]);
      expect(blocks).toHaveLength(1);
      const [note] = blocks;
      expect(note?.kind).toBe('note');
      expect(note?.kind === 'note' && note.text).toContain(type);
      expect(JSON.stringify(note)).not.toContain('secret payload');
    },
  );

  it('keeps an unknown block in its place among known ones', () => {
    const blocks = blocksOf('assistant', [{ type: 'text', text: 'before' }, { type: 'mystery' }, { type: 'text', text: 'after' }]);
    expect(blocks.map((block) => block.kind)).toEqual(['text', 'note', 'text']);
  });

  it('ignores list entries that are not blocks', () => {
    expect(blocksOf('assistant', [null, 7, true, ['nested'], { type: 'text', text: 'kept' }])).toStrictEqual([
      { kind: 'text', text: 'kept' },
    ]);
  });

  it('reads a bare string in the block list as text', () => {
    expect(blocksOf('user', ['a bare string'])).toStrictEqual([{ kind: 'text', text: 'a bare string' }]);
  });
});

describe('parseCompactTranscript images', () => {
  it('reads an inline base64 image', () => {
    expect(
      blocksOf('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } }]),
    ).toStrictEqual([{ kind: 'image', mediaType: 'image/png', base64: 'iVBORw0KGgo=' }]);
  });

  it('reads an entire-asset placeholder in place of the base64 data', () => {
    expect(
      blocksOf('user', [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'entire-asset:assets/img-0a1b2c.jpg' } },
      ]),
    ).toStrictEqual([{ kind: 'image', mediaType: 'image/jpeg', assetPath: 'assets/img-0a1b2c.jpg' }]);
  });

  it('reads a data: URL given as a string', () => {
    expect(blocksOf('user', [{ type: 'input_image', image_url: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }])).toStrictEqual([
      { kind: 'image', mediaType: 'image/jpeg', base64: '/9j/4AAQSkZJRg==' },
    ]);
  });

  it('reads a data: URL given as an object', () => {
    expect(
      blocksOf('user', [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,UklGRg==', detail: 'high' } }]),
    ).toStrictEqual([{ kind: 'image', mediaType: 'image/webp', base64: 'UklGRg==' }]);
  });

  it('reads a data: URL whose payload was replaced by an entire-asset placeholder', () => {
    // The CLI swaps only the base64 payload, so the data: prefix stays.
    expect(
      blocksOf('user', [{ type: 'input_image', image_url: 'data:image/png;base64,entire-asset:assets/img-9f8e7d.png' }]),
    ).toStrictEqual([{ kind: 'image', mediaType: 'image/png', assetPath: 'assets/img-9f8e7d.png' }]);
  });

  it('reads a bare entire-asset placeholder as an image URL', () => {
    expect(blocksOf('user', [{ type: 'input_image', image_url: 'entire-asset:assets/img-11aa.png' }])).toStrictEqual([
      { kind: 'image', assetPath: 'assets/img-11aa.png' },
    ]);
  });

  it('keeps a user line that holds only an image', () => {
    const parsed = parseCompactTranscript(
      file(transcriptLine('user', [{ type: 'image', source: { media_type: 'image/png', data: 'AAAA' } }]), assistant('a')),
      null,
    );
    expect(parsed.turns.map((turn) => turn.role)).toEqual(['user', 'assistant']);
    expect(parsed.turns[0]?.blocks[0]?.kind).toBe('image');
  });

  it.each([
    ['a remote https URL', 'https://tracker.example.com/pixel.png'],
    ['a remote http URL', 'http://tracker.example.com/pixel.png'],
    ['a data: URL that is not an image', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a file path', '/etc/passwd'],
  ])('never keeps %s as image data', (_label, url) => {
    for (const block of [
      { type: 'image_url', image_url: { url } },
      { type: 'input_image', image_url: url },
    ]) {
      const blocks = blocksOf('user', [block]);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.kind).toBe('note');
      expect(JSON.stringify(blocks)).not.toContain(url);
    }
  });

  it.each(['text/html', 'image/png" onload="alert(1)', 'image/', 'application/octet-stream', 'IMAGE PNG'])(
    'drops the media type %j, which is not an image type',
    (mediaType) => {
      const [block] = blocksOf('user', [{ type: 'image', source: { media_type: mediaType, data: 'AAAA' } }]);
      expect(block).toStrictEqual({ kind: 'image', base64: 'AAAA' });
    },
  );

  it.each(['image/svg+xml', 'image/vnd.microsoft.icon', 'image/x-png'])('keeps the image media type %s', (mediaType) => {
    const [block] = blocksOf('user', [{ type: 'image', source: { media_type: mediaType, data: 'AAAA' } }]);
    expect(block).toStrictEqual({ kind: 'image', mediaType, base64: 'AAAA' });
  });
});

/**
 * Line 0  user A
 * Line 1  assistant a1
 * Line 2  assistant a2   (same turn as line 1)
 * Line 3  user B
 * Line 4  assistant b1
 * Line 5  user C
 * Line 6  assistant c1
 *
 * Turns: 0 A, 1 a1+a2, 2 B, 3 b1, 4 C, 5 c1.
 */
const SESSION = file(user('A'), assistant('a1'), assistant('a2'), user('B'), assistant('b1'), user('C'), assistant('c1'));

describe('parseCompactTranscript start offset', () => {
  it('parses the same turns whatever the offset', () => {
    const all = parseCompactTranscript(SESSION, null).turns;
    expect(all.map((turn) => texts(turn))).toEqual([['A'], ['a1', 'a2'], ['B'], ['b1'], ['C'], ['c1']]);
    for (const start of [0, 1, 2, 3, 4, 5, 6, 7, 99]) {
      expect(parseCompactTranscript(SESSION, start).turns).toStrictEqual(all);
    }
  });

  it.each([null, undefined, 0])('starts at the first turn for an offset of %j', (start) => {
    expect(parseCompactTranscript(SESSION, start).startTurn).toBe(0);
  });

  it('starts at the user turn on the offset line', () => {
    expect(parseCompactTranscript(SESSION, 3).startTurn).toBe(2);
    expect(parseCompactTranscript(SESSION, 5).startTurn).toBe(4);
  });

  it('skips an assistant line on the offset, which is the tail of the previous checkpoint', () => {
    // Line 2 continues the turn that began on line 1; line 4 begins a turn of its own.
    expect(parseCompactTranscript(SESSION, 2).startTurn).toBe(2);
    expect(parseCompactTranscript(SESSION, 4).startTurn).toBe(4);
  });

  it('starts at the first user turn after the offset, not before it', () => {
    expect(parseCompactTranscript(SESSION, 1).startTurn).toBe(2);
  });

  it.each([7, 8, 100, Number.MAX_SAFE_INTEGER])('starts at the first turn for the offset %i, which is past the end', (start) => {
    expect(parseCompactTranscript(SESSION, start).startTurn).toBe(0);
  });

  it('starts at the first turn for a negative offset', () => {
    expect(parseCompactTranscript(SESSION, -1).startTurn).toBe(0);
  });

  it('counts the lines it skips for their unknown type, because the offset is a line index', () => {
    const text = file(
      user('A'), // line 0
      JSON.stringify({ v: 1, type: 'system', content: 'x' }), // line 1
      assistant('a'), // line 2
      JSON.stringify({ v: 1, type: 'future_line_type', content: [] }), // line 3
      user('B'), // line 4
      assistant('b'), // line 5
    );
    const turns = parseCompactTranscript(text, null).turns.map((turn) => texts(turn));
    expect(turns).toEqual([['A'], ['a'], ['B'], ['b']]);
    expect(parseCompactTranscript(text, 4).startTurn).toBe(2);
    expect(parseCompactTranscript(text, 3).startTurn).toBe(2);
    expect(parseCompactTranscript(text, 1).startTurn).toBe(2);
    expect(parseCompactTranscript(text, 5).startTurn).toBe(3);
  });

  it('handles an offset that points at a dropped tool-result line', () => {
    const text = file(user('A'), assistant('a1'), foldedToolResult(), assistant('a2'), user('B'), assistant('b'));
    expect(parseCompactTranscript(text, 2).startTurn).toBe(2);
    expect(texts(parseCompactTranscript(text, 2).turns[2])).toEqual(['B']);
  });

  it('starts at the offset turn when no user turn follows it', () => {
    // The checkpoint added only an assistant reply, which begins a turn of its own.
    const text = file(user('A'), user('B'), assistant('b'));
    expect(parseCompactTranscript(text, 2).startTurn).toBe(2);
  });

  it('reads Windows line endings with the same line indexes', () => {
    const text = SESSION.replaceAll('\n', '\r\n');
    expect(parseCompactTranscript(text, 3).startTurn).toBe(2);
    expect(parseCompactTranscript(text, 5).startTurn).toBe(4);
  });

  it('always returns a start turn inside the transcript', () => {
    const count = parseCompactTranscript(SESSION, null).turns.length;
    for (let start = -2; start <= 12; start += 1) {
      const { startTurn } = parseCompactTranscript(SESSION, start);
      expect(startTurn).toBeGreaterThanOrEqual(0);
      expect(startTurn).toBeLessThan(count);
    }
  });

  // A checkpoint can add only assistant lines, for example when the agent
  // commits twice in one reply. Those lines merge into the assistant turn that
  // began before the offset, so no turn starts at or after it. The offset is
  // inside the file, so the result should be the turn that holds the offset
  // line, not the whole session.
  it('does not fall back to the whole session when the offset lands inside a merged assistant turn', () => {
    const text = file(user('A'), assistant('a1'), user('B'), assistant('b1'), assistant('b2'));
    const parsed = parseCompactTranscript(text, 4);
    const shown = parsed.turns.slice(parsed.startTurn).flatMap((turn) => texts(turn));
    expect(shown).toContain('b2');
    expect(shown).not.toContain('A');
    expect(shown).not.toContain('a1');
  });

  it('does not fall back to the whole session when only a dropped line separates the offset from its turn', () => {
    const text = file(user('A'), assistant('a1'), user('B'), assistant('b1'), foldedToolResult(), assistant('b2'));
    for (const start of [4, 5]) {
      const parsed = parseCompactTranscript(text, start);
      const shown = parsed.turns.slice(parsed.startTurn).flatMap((turn) => texts(turn));
      expect(shown).toContain('b2');
      expect(shown).not.toContain('A');
    }
  });
});
