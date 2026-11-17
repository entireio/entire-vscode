import type { BrainDetail } from './brain';

/** What the Brain view shows for one repository. */
export interface BrainPageSection {
  root: string;
  /** The repository's name, shown as a heading when the view holds several. */
  name: string;
  /** `ready` lists the brain. The others say why there is nothing to list. */
  state: 'loading' | 'pluginMissing' | 'noBrain' | 'failed' | 'ready';
  details: readonly BrainDetail[];
  /** Where the graph's server listens, such as `127.0.0.1:50828`, while it runs. */
  running?: string;
}

/**
 * The commands the Brain view's page may run. The page has no script: its
 * buttons are links to these commands, and the editor runs no other command
 * for it.
 */
export const BRAIN_PAGE_COMMANDS: readonly string[] = [
  'entire.openBrainGraph',
  'entire.stopBrainGraph',
  'entire.copyBrainInstallCommand',
  'entire.copyBrainSetupCommand',
  'entire.refresh',
  'entire.showLog',
];

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link that runs a command, with its arguments, for a page that allows command links. */
function commandHref(command: string, args?: readonly unknown[]): string {
  const query = args && args.length > 0 ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return escapeHtml(`command:${command}${query}`);
}

function button(label: string, command: string, args?: readonly unknown[], kind: 'primary' | 'secondary' = 'secondary'): string {
  return `<a class="button ${kind}" role="button" href="${commandHref(command, args)}">${escapeHtml(label)}</a>`;
}

const STYLES = `
  body { margin: 0; padding: 4px 20px 14px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); line-height: 1.5; }
  h2 { margin: 14px 0 6px; font-size: 1em; font-weight: 600; }
  section:first-child h2 { margin-top: 4px; }
  p { margin: 6px 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
  .button { flex: 1 1 auto; box-sizing: border-box; padding: 4px 12px; border-radius: 2px; text-align: center; text-decoration: none; cursor: pointer; }
  .button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); column-gap: 12px; row-gap: 3px; margin: 8px 0 0; cursor: default; }
  .row { display: contents; }
  dt { color: var(--vscode-descriptionForeground); }
  dd { margin: 0; overflow-wrap: break-word; }
  .attention dd { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); }
  @media (max-width: 250px) {
    dl { grid-template-columns: minmax(0, 1fr); row-gap: 0; }
    dd { margin-bottom: 5px; }
  }
`;

/** What the page says in place of a brain it cannot list, with the buttons that help. */
function notice(section: BrainPageSection): string {
  switch (section.state) {
    case 'loading':
      return '<p class="muted" role="status">Loading…</p>';
    case 'pluginMissing':
      return (
        '<p>The brain of a repository comes from the entire-brain plugin, which is not installed. ' +
        'Run "entire plugin install brain" in a terminal, then retry.</p>' +
        `<p class="actions">${button('Copy Command', 'entire.copyBrainInstallCommand', undefined, 'primary')}${button('Retry', 'entire.refresh')}</p>`
      );
    case 'noBrain':
      return (
        '<p>This repository has no brain yet. Run "entire brain setup" in a terminal to build one, then retry.</p>' +
        `<p class="actions">${button('Copy Command', 'entire.copyBrainSetupCommand', undefined, 'primary')}${button('Retry', 'entire.refresh')}</p>`
      );
    case 'failed':
      return (
        '<p>Entire could not read the brain of this repository. The log has the details.</p>' +
        `<p class="actions">${button('Retry', 'entire.refresh', undefined, 'primary')}${button('Show Log', 'entire.showLog')}</p>`
      );
    case 'ready':
      return '';
  }
}

function sectionHtml(section: BrainPageSection, headed: boolean): string {
  const heading = headed ? `<h2>${escapeHtml(section.name)}</h2>` : '';
  if (section.state !== 'ready') return `<section>${heading}${notice(section)}</section>`;

  const actions =
    button('View Brain', 'entire.openBrainGraph', [section.root], 'primary') +
    (section.running ? button('Stop', 'entire.stopBrainGraph', [section.root]) : '');
  const running = section.running
    ? `<p class="muted">The graph is running on ${escapeHtml(section.running)}.</p>`
    : '';
  // The details are text, not rows of a list: nothing about them can be clicked, so nothing looks as if it could.
  const rows = section.details
    .map((detail) => {
      // The row itself has no box to hover: its two cells lie in the grid of the list.
      const title = detail.tooltip ? ` title="${escapeHtml(detail.tooltip)}"` : '';
      return `<div class="row${detail.attention ? ' attention' : ''}"><dt${title}>${escapeHtml(detail.label)}</dt><dd${title}>${escapeHtml(detail.value)}</dd></div>`;
    })
    .join('');
  return `<section>${heading}<p class="actions">${actions}</p>${running}<dl>${rows}</dl></section>`;
}

/**
 * The page of the Brain view: for each repository, a button that opens the
 * graph of its brain, and what the brain holds as plain text.
 *
 * The page runs no script and loads nothing. Its styles carry `nonce`, and
 * every piece of text is escaped, so nothing the plugin reports can become
 * markup.
 */
export function brainPageHtml(sections: readonly BrainPageSection[], nonce: string): string {
  const body =
    sections.length === 0
      ? '<p class="muted">Entire is not enabled in an open repository.</p>'
      : sections.map((section) => sectionHtml(section, sections.length > 1)).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${escapeHtml(nonce)}">${STYLES}</style>
<title>Brain</title>
</head>
<body>${body}</body>
</html>`;
}
