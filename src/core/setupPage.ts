import { BASE_STYLES, button, escapeHtml, pageHtml } from './pageKit';
import type { SetupModel, SetupStepState, SetupStepView } from './setup';

/**
 * The commands the Setup view's page may run. The page has no script: its
 * buttons are links to these commands, and the editor runs no other command
 * for it. Every step's button goes through `entire.runSetupStep`, which
 * checks its arguments and runs the step's command in a terminal.
 */
export const SETUP_PAGE_COMMANDS: readonly string[] = ['entire.runSetupStep', 'entire.checkSetup', 'entire.hideSetup'];

/** What the page shows: the steps, or why there are none. */
export type SetupPage = { kind: 'steps'; model: SetupModel } | { kind: 'noRepository' } | { kind: 'loading' };

const STYLES = `${BASE_STYLES}
  ol { list-style: none; margin: 4px 0 0; padding: 0; }
  li { margin: 0 0 10px; }
  .head { display: flex; align-items: baseline; gap: 6px; }
  .mark { flex: none; width: 1.2em; text-align: center; }
  .title { font-weight: 600; }
  .status { margin-left: auto; color: var(--vscode-descriptionForeground); }
  .step p { margin: 2px 0 0 calc(1.2em + 6px); }
  .step .actions { margin-top: 6px; }
  .done .mark { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .needed .mark, .needed .status { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); }
  .blocked .title, .blocked p { color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground)); }
  .summary { margin-bottom: 10px; }
`;

const MARKS: Record<SetupStepState, string> = {
  done: '✓',
  needed: '!',
  optional: '○',
  blocked: '–',
  running: '…',
  checking: '…',
};

const STATUS: Record<SetupStepState, string> = {
  done: 'Done',
  needed: 'Needed',
  optional: 'Optional',
  blocked: 'Waiting',
  running: 'Running',
  checking: 'Checking',
};

function stepHtml(view: SetupStepView, root: string | undefined): string {
  const buttons = view.buttons
    .map((entry) => button(entry.label, 'entire.runSetupStep', [root ?? null, entry.action], entry.primary ? 'primary' : 'secondary'))
    .join('');
  const role = view.state === 'running' || view.state === 'checking' ? ' role="status"' : '';
  return (
    `<li class="step ${view.state}" data-step="${escapeHtml(view.id)}">` +
    `<div class="head"><span class="mark" aria-hidden="true">${MARKS[view.state]}</span>` +
    `<span class="title">${escapeHtml(view.title)}</span><span class="status">${STATUS[view.state]}</span></div>` +
    `<p class="muted"${role}>${escapeHtml(view.text)}</p>` +
    (buttons ? `<p class="actions">${buttons}</p>` : '') +
    '</li>'
  );
}

function stepsHtml(model: SetupModel): string {
  const summary = model.complete
    ? '<p class="summary">Entire is set up. You can hide this section, and open it again with Entire: Set Up Entire.</p>'
    : '<p class="summary muted">Each button runs its command in a terminal, where you can answer its questions. This list updates when the command ends.</p>';
  const machine = `<section><h2>This Machine</h2><ol>${model.machine.map((view) => stepHtml(view, undefined)).join('')}</ol></section>`;
  const repos = model.repos
    .map(
      (repo) =>
        `<section><h2>${escapeHtml(repo.name)}</h2><ol>${repo.steps.map((view) => stepHtml(view, repo.root)).join('')}</ol></section>`,
    )
    .join('');
  const footer = `<p class="actions">${button('Check Again', 'entire.checkSetup')}${button('Hide Setup', 'entire.hideSetup')}</p>`;
  return `${summary}${machine}${repos}${footer}`;
}

/**
 * The page of the Setup view: the steps to set up Entire, each with what is
 * known about it and a button that runs its command.
 *
 * The page runs no script and loads nothing. Its styles carry `nonce`, and
 * every piece of text is escaped, so nothing a repository or the CLI reports
 * can become markup.
 */
export function setupPageHtml(page: SetupPage, nonce: string): string {
  let body: string;
  switch (page.kind) {
    case 'loading':
      body = '<p class="muted" role="status">Loading…</p>';
      break;
    case 'noRepository':
      body =
        '<p>Open a folder that contains a Git repository to set up Entire in it.</p>' +
        `<p class="actions">${button('Hide Setup', 'entire.hideSetup')}</p>`;
      break;
    case 'steps':
      body = stepsHtml(page.model);
      break;
  }
  return pageHtml('Setup', STYLES, body, nonce);
}
