import type { FullBlock, FullTurn, ParsedTranscript } from './model';

/**
 * Reader for the Entire Transcript Format v1 (`transcript.jsonl`).
 *
 * The format is one JSON object per line with `type` of `user` or `assistant`
 * and a `content` list of blocks. It is the same for every agent. Following
 * its evolution rules, this reader ignores unknown fields, skips lines with an
 * unknown `type`, and keeps unknown block types as a short note.
 */

const ASSET_PREFIX = 'entire-asset:';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function imageFromSource(data: unknown, mediaType: unknown): FullBlock {
  const block: FullBlock = { kind: 'image' };
  if (typeof mediaType === 'string' && /^image\/[\w.+-]+$/.test(mediaType)) block.mediaType = mediaType;
  if (typeof data === 'string') {
    if (data.startsWith(ASSET_PREFIX)) block.assetPath = data.slice(ASSET_PREFIX.length);
    else if (data !== '') block.base64 = data;
  }
  return block;
}

/** Splits a `data:image/png;base64,...` URL, or recognizes an asset placeholder. */
function imageFromUrl(url: unknown): FullBlock | undefined {
  if (typeof url !== 'string') return undefined;
  if (url.startsWith(ASSET_PREFIX)) return { kind: 'image', assetPath: url.slice(ASSET_PREFIX.length) };
  const match = /^data:(image\/[\w.+-]+);base64,(.*)$/s.exec(url);
  if (!match) return undefined;
  return imageFromSource(match[2], match[1]);
}

function readBlock(raw: unknown): FullBlock | undefined {
  if (typeof raw === 'string') return raw.trim() === '' ? undefined : { kind: 'text', text: raw };
  if (!isObject(raw)) return undefined;
  const type = raw.type;

  // User text blocks have no `type`, which is a quirk of v1.
  if (type === undefined || type === 'text') {
    return typeof raw.text === 'string' && raw.text.trim() !== '' ? { kind: 'text', text: raw.text } : undefined;
  }

  if (type === 'tool_use') {
    const block: FullBlock = {
      kind: 'tool',
      name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : 'Tool',
      input: raw.input,
    };
    if (isObject(raw.result)) {
      if (typeof raw.result.output === 'string') block.output = raw.result.output;
      if (raw.result.status === 'success' || raw.result.status === 'error') block.status = raw.result.status;
    }
    return block;
  }

  if (type === 'image' && isObject(raw.source)) {
    return imageFromSource(raw.source.data, raw.source.media_type);
  }
  if (type === 'input_image' || type === 'image_url') {
    const url = isObject(raw.image_url) ? raw.image_url.url : raw.image_url;
    return imageFromUrl(url) ?? { kind: 'note', text: 'Image' };
  }

  return typeof type === 'string' ? { kind: 'note', text: `Unsupported block: ${type}` } : undefined;
}

function readBlocks(content: unknown): FullBlock[] {
  if (typeof content === 'string') return content.trim() === '' ? [] : [{ kind: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: FullBlock[] = [];
  for (const raw of content) {
    const block = readBlock(raw);
    if (block) blocks.push(block);
  }
  return blocks;
}

/**
 * Parses a normalized transcript into turns.
 *
 * Consecutive assistant lines become one turn, because an agent writes one
 * line per message fragment while a reader thinks in replies. User lines with
 * no text (tool results that were folded into their tool call) are dropped.
 *
 * `startLine` is the session metadata's `compact_transcript_start`: a 0-based
 * line index. The line at that index can be the tail of the previous
 * checkpoint, so the checkpoint's own portion begins at the first user turn
 * at or after it.
 */
export function parseCompactTranscript(text: string, startLine: number | null | undefined): ParsedTranscript {
  const turns: FullTurn[] = [];
  /** Source lines where each turn begins and ends, parallel to `turns`. */
  const firstLine: number[] = [];
  const lastLine: number[] = [];
  let previousWasAssistant = false;

  const lines = text.split('\n');
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line || line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(parsed) || (parsed.type !== 'user' && parsed.type !== 'assistant')) continue;
    // `v` changes only for a breaking change, so a v1 reader cannot interpret another version.
    if (typeof parsed.v === 'number' && parsed.v !== 1) continue;

    const blocks = readBlocks(parsed.content);
    if (blocks.length === 0) continue;
    const ts = typeof parsed.ts === 'string' && parsed.ts !== '' ? parsed.ts : undefined;

    const last = turns[turns.length - 1];
    if (parsed.type === 'assistant' && previousWasAssistant && last) {
      last.blocks.push(...blocks);
      lastLine[lastLine.length - 1] = lineIndex;
    } else {
      const turn: FullTurn = { role: parsed.type, blocks };
      if (ts) turn.ts = ts;
      turns.push(turn);
      firstLine.push(lineIndex);
      lastLine.push(lineIndex);
    }
    previousWasAssistant = parsed.type === 'assistant';
  }

  return { turns, startTurn: findStartTurn(turns, firstLine, lastLine, startLine) };
}

function findStartTurn(
  turns: FullTurn[],
  firstLine: number[],
  lastLine: number[],
  startLine: number | null | undefined,
): number {
  if (startLine === null || startLine === undefined || startLine <= 0) return 0;
  let firstAtOrAfter = -1;
  for (let i = 0; i < turns.length; i += 1) {
    if ((firstLine[i] ?? 0) < startLine) continue;
    if (firstAtOrAfter < 0) firstAtOrAfter = i;
    if (turns[i]?.role === 'user') return i;
  }
  // No user turn after the offset: show from the first turn past it.
  if (firstAtOrAfter >= 0) return firstAtOrAfter;
  // The offset can land inside a turn. A checkpoint that added only assistant
  // lines, such as a second commit in one reply, extends a turn that began
  // before the offset.
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if ((firstLine[i] ?? 0) <= startLine && startLine <= (lastLine[i] ?? -1)) return i;
  }
  // The offset is beyond the file: show everything.
  return 0;
}
