import type { FullTurn } from './model';

/**
 * The leading markers of content an agent puts on the user side of a
 * transcript: runtime preambles, instruction-file dumps, and tool or
 * notification results replayed as user turns. None of it is typed by the
 * user.
 *
 * The Entire CLI keeps this list (`transcript/injected_prompt.go`) and uses
 * it to pick a session's title, so the same list is used here. It is matched
 * at the start of a prompt only: a prompt that mentions one of these tags is
 * still a prompt.
 */
const INJECTED_PREFIXES = [
  '# AGENTS.md',
  '<environment_context>',
  '<permissions',
  '<collaboration_mode>',
  '<skills_instructions>',
  '<apps_instructions>',
  '<plugins_instructions>',
  '<recommended_plugins>',
  '<user_action>',
  '<subagent_notification>',
  '<turn_aborted>',
];

/** Whether a prompt was put there by the agent and not typed by the user. */
export function isInjectedPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (INJECTED_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) return true;
  // Some instruction dumps lead with a wrapper tag. The marker keeps a real question about the tag a prompt.
  return trimmed.startsWith('<INSTRUCTIONS>') && trimmed.includes('AGENTS.md instructions');
}

/** What a turn says in words: its text blocks, one after another. */
function turnText(turn: FullTurn): string {
  return turn.blocks
    .map((block) => (block.kind === 'text' ? block.text : ''))
    .filter((text) => text.trim() !== '')
    .join('\n')
    .trim();
}

/**
 * The prompt that opens a session, which is what Entire names the session
 * by: the first thing the user typed. A prompt the agent injected does not
 * count. When every prompt is one of those, the first of them is returned,
 * because a noisy name says more than none.
 */
export function openingPrompt(turns: readonly FullTurn[]): string | undefined {
  let injected: string | undefined;
  for (const turn of turns) {
    if (turn.role !== 'user') continue;
    const text = turnText(turn);
    if (text === '') continue;
    if (!isInjectedPrompt(text)) return text;
    injected ??= text;
  }
  return injected;
}
