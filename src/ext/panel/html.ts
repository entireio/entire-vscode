import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/** Which page the panel's script draws: a checkpoint or session, or a trail. */
export type PanelView = 'detail' | 'trail';

/**
 * The panel's document. Scripts run only with the nonce, nothing loads from
 * the network, and images come from the extension or from data and blob URLs
 * that the page builds itself.
 */
export function panelHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: PanelView = 'detail'): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (name: string): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name)).toString();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: blob:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset('panel.css')}">
<title>Entire</title>
</head>
<body>
<div id="app" data-view="${view}"></div>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
}
