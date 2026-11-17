import { describe, expect, it } from 'vitest';
import type { FullTurn } from '../../../src/core/transcript/model';
import { isInjectedPrompt, openingPrompt } from '../../../src/core/transcript/prompts';

const user = (...texts: string[]): FullTurn => ({ role: 'user', blocks: texts.map((text) => ({ kind: 'text', text })) });
const assistant = (text: string): FullTurn => ({ role: 'assistant', blocks: [{ kind: 'text', text }] });

describe('isInjectedPrompt', () => {
  it.each([
    ['an instruction-file dump', '# AGENTS.md instructions for /repo\n\nBe brief.'],
    ['a bare instruction-file heading', '# AGENTS.md'],
    ['a runtime preamble', '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'],
    ['permission instructions', '<permissions instructions>\nApprovals are off.'],
    ['a collaboration mode notice', '<collaboration_mode>plan</collaboration_mode>'],
    ['skill instructions', '<skills_instructions>...</skills_instructions>'],
    ['app instructions', '<apps_instructions>...</apps_instructions>'],
    ['plugin instructions', '<plugins_instructions>...</plugins_instructions>'],
    ['a plugin catalog', '<recommended_plugins>...</recommended_plugins>'],
    ['a replayed tool result', '<user_action>\nreview finished\n</user_action>'],
    ['a subagent notice', '<subagent_notification>done</subagent_notification>'],
    ['an interruption notice', '<turn_aborted>The user interrupted.</turn_aborted>'],
    ['a marker after leading blank lines', '\n\n  <environment_context>\n</environment_context>'],
    ['an instruction dump inside its wrapper tag', '<INSTRUCTIONS>\n# AGENTS.md instructions for /repo\n</INSTRUCTIONS>'],
  ])('recognizes %s', (_label, text) => {
    expect(isInjectedPrompt(text)).toBe(true);
  });

  it.each([
    ['a plain prompt', 'run the server and show me the UI'],
    ['a prompt that mentions a marker', 'why does codex send <environment_context> first?'],
    ['a prompt that quotes the instruction file later on', 'Please read this:\n# AGENTS.md\nand summarize it'],
    ['a question about the wrapper tag', '<INSTRUCTIONS> is a tag in my template. What does it do?'],
    ['a heading that only resembles the marker', '# AGENTS'],
    ['another tag', '<task-notification>build finished</task-notification>'],
    ['nothing', ''],
  ])('takes %s for something the user typed', (_label, text) => {
    expect(isInjectedPrompt(text)).toBe(false);
  });
});

describe('openingPrompt', () => {
  it('is the first thing the user typed', () => {
    expect(openingPrompt([user('run the server and show me the UI'), assistant('Starting it.'), user('now stop it')])).toBe(
      'run the server and show me the UI',
    );
  });

  it('looks past turns that are not the user\'s, and user turns with no text', () => {
    const toolResult: FullTurn = { role: 'user', blocks: [{ kind: 'tool', name: 'Bash', input: {} }] };
    const blank = user('   ', '\n');
    const image: FullTurn = { role: 'user', blocks: [{ kind: 'image', mediaType: 'image/png' }] };
    expect(openingPrompt([assistant('Hello'), toolResult, blank, image, user('fix the parser')])).toBe('fix the parser');
  });

  it('looks past what the agent injected before the first prompt', () => {
    const turns = [
      user('# AGENTS.md instructions for /repo\n\nBe brief.'),
      user('<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>'),
      user('add a retry to the upload'),
      user('and a test'),
    ];
    expect(openingPrompt(turns)).toBe('add a retry to the upload');
  });

  it('settles for the first injected prompt when the user typed nothing, because a noisy name says more than none', () => {
    const turns = [user('<environment_context>\n</environment_context>'), assistant('Ready.'), user('<turn_aborted>stopped</turn_aborted>')];
    expect(openingPrompt(turns)).toBe('<environment_context>\n</environment_context>');
  });

  it('joins the text blocks of the turn, and trims the ends', () => {
    expect(openingPrompt([user('  first part  ', '', 'second part\n')])).toBe('first part  \nsecond part');
  });

  it('keeps a long prompt whole: the view cuts it to fit', () => {
    const long = 'word '.repeat(2000).trim();
    expect(openingPrompt([user(long)])).toBe(long);
  });

  it('is undefined for a transcript in which the user says nothing', () => {
    expect(openingPrompt([])).toBeUndefined();
    expect(openingPrompt([assistant('Hello'), assistant('Anyone?')])).toBeUndefined();
  });
});
