import type { HostMessage, TrailHostMessage } from '../shared/protocol';
import { createApp, type VsCodeApi } from './app';
import './styles.css';
import { createTrailApp, type TrailVsCodeApi } from './trail';

declare function acquireVsCodeApi(): VsCodeApi & TrailVsCodeApi;

const root = document.getElementById('app');
if (root) {
  // The host says which page this is when it writes the document.
  if (root.dataset.view === 'trail') {
    const app = createTrailApp(root, acquireVsCodeApi());
    window.addEventListener('message', (event: MessageEvent<TrailHostMessage>) => app.handle(event.data));
    app.start();
  } else {
    const app = createApp(root, acquireVsCodeApi());
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => app.handle(event.data));
    app.start();
  }
}
