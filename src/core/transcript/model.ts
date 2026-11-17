import type { WireBlock, WireTurn } from '../../shared/protocol';
import { truncate } from '../format';

/** A transcript block with everything the source recorded. Kept on the host. */
export type FullBlock =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: unknown; output?: string; status?: 'success' | 'error' }
  | { kind: 'image'; mediaType?: string; base64?: string; assetPath?: string }
  | { kind: 'note'; text: string };

export interface FullTurn {
  role: 'user' | 'assistant';
  ts?: string;
  blocks: FullBlock[];
}

export interface ParsedTranscript {
  turns: FullTurn[];
  /** Index of the first turn that belongs to the checkpoint being viewed. */
  startTurn: number;
}

const SUMMARY_LIMIT = 160;
/** Input keys that usually say what a tool call did, most descriptive first. */
const SUMMARY_KEYS = [
  'description',
  'command',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'prompt',
  'skill',
  'subject',
];

function oneLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return truncate(line.trim(), SUMMARY_LIMIT);
}

/** One line that tells a reader what a tool call did, without the full input. */
export function toolSummary(input: unknown): string {
  if (typeof input === 'string') return oneLine(input);
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  for (const key of SUMMARY_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value);
  }
  return '';
}

/** The tool input as text for display. */
export function toolInputText(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** Strips tool bodies and image data, which make up most of a transcript's size. */
export function toWireTurn(turn: FullTurn, index: number): WireTurn {
  const blocks = turn.blocks.map((block, position): WireBlock => {
    switch (block.kind) {
      case 'text':
        return { kind: 'text', text: block.text };
      case 'note':
        return { kind: 'note', text: block.text };
      case 'image':
        return block.mediaType
          ? { kind: 'image', block: position, mediaType: block.mediaType }
          : { kind: 'image', block: position };
      case 'tool': {
        const wire: WireBlock = {
          kind: 'tool',
          block: position,
          name: block.name,
          summary: toolSummary(block.input),
          hasBody: toolInputText(block.input) !== '' || (block.output ?? '') !== '',
        };
        if (block.status) wire.status = block.status;
        return wire;
      }
    }
  });
  const wire: WireTurn = { index, role: turn.role, blocks };
  if (turn.ts) wire.ts = turn.ts;
  return wire;
}
