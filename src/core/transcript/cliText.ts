import type { FullTurn, ParsedTranscript } from './model';

/**
 * Reader for the transcript section of `entire checkpoint explain --full`.
 *
 * This is the fallback for sessions with no normalized transcript. The CLI
 * prints a header, then a `Transcript` rule, then entries that each start
 * with `[User]`, `[Assistant]`, or `[Tool]`. The text carries tool names and
 * one-line descriptions but no tool inputs or results.
 *
 * It is a text format meant for people, so parsing is best effort: when no
 * entry marker is found, the whole section becomes one text turn.
 */

const MARKER = /^\[(User|Assistant|Tool)\] ?(.*)$/;
const TRANSCRIPT_RULE = /^─+ Transcript\b.*─+\s*$/;
/** The plain rule that ends the header of the CLI's text views. */
const HEADER_RULE = /^─{3,}\s*$/;
const AUTHOR_LINE = /^\s*author\s+(\S.*)$/;
/** The header is a handful of lines. Past this, a line that reads like one belongs to the text below. */
const HEADER_LINES = 40;
/** A name is drawn beside each prompt, so one that runs on is cut. */
const AUTHOR_MAX = 80;

/**
 * Who the CLI names as the author of a checkpoint, from the header of
 * `entire checkpoint explain --short`. The line reads
 * `  author   Ada Lovelace <ada@example.com>`.
 *
 * The CLI takes the author from the commit that carries the checkpoint, and
 * failing that from the commit that stored the checkpoint's data. Its JSON
 * output leaves the author out, which is why the text view is read.
 *
 * Returns the name, or the address when the line has no name.
 */
export function parseCheckpointAuthor(output: string): string | undefined {
  const lines = output.replace(/\r\n?/g, '\n').split('\n').slice(0, HEADER_LINES);
  for (const line of lines) {
    if (HEADER_RULE.test(line)) return undefined;
    const match = AUTHOR_LINE.exec(line);
    if (!match) continue;
    const value = (match[1] ?? '').trim();
    const withAddress = /^(.*?)\s*<([^<>]*)>$/.exec(value);
    const name = (withAddress ? (withAddress[1] ?? '') : value).trim();
    const author = name !== '' ? name : (withAddress?.[2] ?? '').trim();
    return author === '' ? undefined : author.slice(0, AUTHOR_MAX);
  }
  return undefined;
}

export function parseCliText(output: string): ParsedTranscript {
  const lines = output.replace(/\r\n?/g, '\n').split('\n');
  const ruleIndex = lines.findIndex((line) => TRANSCRIPT_RULE.test(line));
  const body = ruleIndex >= 0 ? lines.slice(ruleIndex + 1) : lines;

  const turns: FullTurn[] = [];
  let role: 'user' | 'assistant' | undefined;
  let text: string[] = [];

  const flushText = (): void => {
    const joined = text.join('\n').trim();
    text = [];
    if (joined === '' || !role) return;
    const last = turns[turns.length - 1];
    if (role === 'assistant' && last?.role === 'assistant') last.blocks.push({ kind: 'text', text: joined });
    else turns.push({ role, blocks: [{ kind: 'text', text: joined }] });
  };

  for (const line of body) {
    const match = MARKER.exec(line);
    if (!match) {
      text.push(line);
      continue;
    }
    flushText();
    const [, kind, rest = ''] = match;
    if (kind === 'Tool') {
      role = 'assistant';
      const separator = rest.indexOf(': ');
      const name = separator > 0 ? rest.slice(0, separator) : rest || 'Tool';
      const description = separator > 0 ? rest.slice(separator + 2) : '';
      const last = turns[turns.length - 1];
      const block = { kind: 'tool' as const, name, input: description };
      if (last?.role === 'assistant') last.blocks.push(block);
      else turns.push({ role: 'assistant', blocks: [block] });
    } else {
      role = kind === 'User' ? 'user' : 'assistant';
      text.push(rest);
    }
  }
  flushText();

  if (turns.length === 0) {
    const whole = body.join('\n').trim();
    if (whole !== '') turns.push({ role: 'assistant', blocks: [{ kind: 'text', text: whole }] });
  }
  return { turns, startTurn: 0 };
}
