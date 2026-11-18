/**
 * Pieces shared by the pages of the sidebar's webview views: the Brain view
 * and the Setup view. Each page is a string built on the host. It runs no
 * script and loads nothing, its buttons are links to commands that the view
 * allows, and every piece of text in it is escaped.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A link that runs a command, with its arguments, for a page that allows command links. */
export function commandHref(command: string, args?: readonly unknown[]): string {
  const query = args && args.length > 0 ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return escapeHtml(`command:${command}${query}`);
}

export function button(
  label: string,
  command: string,
  args?: readonly unknown[],
  kind: 'primary' | 'secondary' = 'secondary',
): string {
  return `<a class="button ${kind}" role="button" href="${commandHref(command, args)}">${escapeHtml(label)}</a>`;
}

/** The look of text, headings, and buttons, which every page shares. */
export const BASE_STYLES = `
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
`;

/**
 * A whole page. The policy allows nothing but the page's own styles, which
 * carry `nonce`: no script, no image, no font, no request of any kind.
 */
export function pageHtml(title: string, styles: string, body: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${escapeHtml(nonce)}'">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${escapeHtml(nonce)}">${styles}</style>
<title>${escapeHtml(title)}</title>
</head>
<body>${body}</body>
</html>`;
}
