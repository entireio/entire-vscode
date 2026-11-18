/**
 * The repository brain, which the entire-brain plugin builds and serves.
 *
 * The extension reads two things from the plugin, both through the Entire
 * CLI as `entire brain …`: whether a repository has a brain, and where the
 * plugin's local graph page is once `entire brain viz` has started. The
 * plugin is run through the CLI and never by its own name, because the CLI
 * finds the copy it manages, which can be newer than one on `PATH`.
 */

/** `entire brain viz`, told not to open a browser itself and to pick a free port. */
export const BRAIN_VIZ_ARGS: readonly string[] = ['brain', 'viz', '--no-open', '--port', '0'];

/** `entire brain status --json`, as far as the extension uses it. */
export interface BrainStatus {
  /**
   * `current` for a brain that is built, and `absent` for a repository that
   * has none. The plugin also reports `corrupt`, `unsafe`, and `unsupported`.
   */
  manifestState: string;
  /** When the brain was last written, as an ISO time. */
  generatedAt?: string;
  /** The size of the code graph, which is what `entire brain viz` draws. */
  files?: number;
  symbols?: number;
  relations?: number;
  /** Durable memories in the brain. The plugin's report calls them facts. */
  memories?: number;
  /** Exchanges from retained sessions that the brain has indexed. */
  exchanges?: number;
  docsRecords?: number;
  docsFiles?: number;
  /** The worst the plugin says of any part of the brain: `ok`, `degraded`, or `unsafe`. */
  freshness?: string;
  /** The parts that are not fresh, each with the plugin's reason. */
  staleParts: string[];
  /** The plugin's background updater for this machine. */
  updater?: 'running' | 'stopped' | 'notInstalled';
  /** `connected` when the repository is bound to a hosted brain. */
  hosted?: string;
  hostedSynced?: boolean;
  warnings: string[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function part(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** How bad a freshness word is. A word the plugin adds later counts as worse than `ok`. */
function badness(severity: string): number {
  return severity === 'ok' ? 0 : severity === 'unsafe' ? 2 : 1;
}

const MAX_NOTES = 10;
const NOTE_CHARS = 400;

/** Reads the plugin's status report. Undefined when it does not say what state the brain is in. */
export function readBrainStatus(value: unknown): BrainStatus | undefined {
  if (!isObject(value) || !isObject(value.brain)) return undefined;
  const state = value.brain.manifest_state;
  if (typeof state !== 'string' || state === '') return undefined;
  const status: BrainStatus = { manifestState: state, staleParts: [], warnings: [] };
  const generatedAt = text(value.brain.generated_at);
  if (generatedAt) status.generatedAt = generatedAt;

  const semantic = part(value.semantic);
  const coverage = part(semantic.coverage);
  for (const key of ['files', 'symbols', 'relations'] as const) {
    const found = count(coverage[key]);
    if (found !== undefined) status[key] = found;
  }
  const memories = count(part(value.facts).facts);
  if (memories !== undefined) status.memories = memories;
  const retrieval = part(value.retrieval);
  const exchanges = count(part(retrieval.conversation).exchanges);
  if (exchanges !== undefined) status.exchanges = exchanges;
  const docsRecords = count(retrieval.docs_records);
  if (docsRecords !== undefined) status.docsRecords = docsRecords;
  const docsFiles = count(retrieval.docs_files);
  if (docsFiles !== undefined) status.docsFiles = docsFiles;

  // The code graph and the indexes each report their own freshness. The view shows the worst.
  for (const source of [semantic, retrieval]) {
    const freshness = part(source.freshness);
    const severity = text(freshness.severity);
    if (severity && (status.freshness === undefined || badness(severity) > badness(status.freshness))) {
      status.freshness = severity;
    }
    for (const [name, axis] of Object.entries(part(freshness.axes))) {
      const axisState = text(part(axis).state);
      if (!axisState || axisState === 'ok' || status.staleParts.length >= MAX_NOTES) continue;
      const detail = text(part(axis).detail);
      status.staleParts.push(`${name}: ${detail ?? axisState}`.slice(0, NOTE_CHARS));
    }
  }

  const onboarding = part(value.onboarding);
  if (isObject(onboarding.daemon)) {
    const daemon = onboarding.daemon;
    status.updater = daemon.running === true ? 'running' : daemon.installed === true ? 'stopped' : 'notInstalled';
  }
  const hosted = part(value.hosted);
  const hostedState = text(hosted.state);
  if (hostedState) status.hosted = hostedState;
  if (typeof hosted.synced === 'boolean') status.hostedSynced = hosted.synced;

  if (Array.isArray(value.warnings)) {
    for (const warning of value.warnings) {
      const note = text(warning);
      if (note && status.warnings.length < MAX_NOTES) status.warnings.push(note.slice(0, NOTE_CHARS));
    }
  }
  return status;
}

/** One line of the Brain view: a fact about the brain of a repository. */
export interface BrainDetail {
  key: 'state' | 'graph' | 'memories' | 'conversations' | 'docs' | 'freshness' | 'updates' | 'hosted' | 'warning';
  label: string;
  value: string;
  /** More than fits on the line. */
  tooltip?: string;
  /** The line reports something that needs a look. */
  attention?: boolean;
}

const number = (value: number): string => value.toLocaleString('en-US');
const plural = (value: number, one: string, many: string): string => `${number(value)} ${value === 1 ? one : many}`;
const sentence = (value: string): string => {
  const words = value.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * What the Brain view lists for a repository that has a brain, in the order
 * it lists it. `updated` is the age of the brain in words, such as "2h ago",
 * which the caller works out.
 */
export function brainDetails(status: BrainStatus, updated = ''): BrainDetail[] {
  const details: BrainDetail[] = [];
  const built = status.manifestState === 'current';
  details.push({
    key: 'state',
    label: 'Brain',
    value: [built ? 'Built' : sentence(status.manifestState), updated ? `updated ${updated}` : ''].filter(Boolean).join(' · '),
    ...(built ? {} : { attention: true, tooltip: 'Run "entire brain status" in a terminal for the details.' }),
  });

  const graph = [
    status.files === undefined ? '' : plural(status.files, 'file', 'files'),
    status.symbols === undefined ? '' : plural(status.symbols, 'symbol', 'symbols'),
    status.relations === undefined ? '' : plural(status.relations, 'relation', 'relations'),
  ].filter(Boolean);
  if (graph.length > 0) details.push({ key: 'graph', label: 'Code graph', value: graph.join(' · ') });
  if (status.memories !== undefined) details.push({ key: 'memories', label: 'Memories', value: number(status.memories) });
  if (status.exchanges !== undefined) {
    details.push({ key: 'conversations', label: 'Conversations', value: plural(status.exchanges, 'exchange', 'exchanges') });
  }
  if (status.docsRecords !== undefined) {
    const from = status.docsFiles === undefined ? '' : ` from ${plural(status.docsFiles, 'file', 'files')}`;
    details.push({ key: 'docs', label: 'Docs', value: `${plural(status.docsRecords, 'record', 'records')}${from}` });
  }

  if (status.freshness !== undefined) {
    const fresh = status.freshness === 'ok';
    details.push({
      key: 'freshness',
      label: 'Freshness',
      value: fresh ? 'Up to date' : sentence(status.freshness),
      ...(fresh ? {} : { attention: true }),
      ...(status.staleParts.length > 0 ? { tooltip: status.staleParts.join('\n') } : {}),
    });
  }
  if (status.updater !== undefined) {
    details.push({
      key: 'updates',
      label: 'Updates',
      value:
        status.updater === 'running'
          ? 'Running in the background'
          : status.updater === 'stopped'
            ? 'Not running'
            : 'Not installed',
      ...(status.updater === 'stopped' ? { attention: true } : {}),
    });
  }
  if (status.hosted !== undefined) {
    const connected = status.hosted === 'connected';
    const synced = !connected || status.hostedSynced === undefined ? '' : status.hostedSynced ? ' · synced' : ' · not synced';
    details.push({
      key: 'hosted',
      label: 'Hosted brain',
      value: `${connected ? 'Connected' : status.hosted === 'disconnected' ? 'Not connected' : sentence(status.hosted)}${synced}`,
    });
  }
  for (const warning of status.warnings) {
    details.push({ key: 'warning', label: 'Warning', value: warning, tooltip: warning, attention: true });
  }
  return details;
}

/** Whether the repository has a brain to show. Any state but `absent` has something on disk. */
export function hasBrain(status: BrainStatus): boolean {
  return status.manifestState !== 'absent';
}

const VIZ_ADDRESS = /http:\/\/127\.0\.0\.1:(\d{1,5})(?!\d)/;

/**
 * The address of the plugin's graph page, from the line it prints once it is
 * listening: `entire brain viz — http://127.0.0.1:49316`.
 *
 * The plugin binds to the loopback address only. The address returned here is
 * rebuilt from the port number, so whatever else the line holds, the
 * extension opens a page on this machine and nothing else.
 */
export function parseVizUrl(line: string): string | undefined {
  const port = Number(VIZ_ADDRESS.exec(line)?.[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? `http://127.0.0.1:${port}` : undefined;
}

/**
 * Whether the CLI's complaint means a plugin, entire-brain by default, is not
 * installed. Without the plugin, its name is not a command the CLI knows: it
 * prints `unknown command "brain …"`, and newer versions name the plugin and
 * how to install it.
 */
export function isPluginMissing(output: string, plugin: 'brain' | 'graph' = 'brain'): boolean {
  return new RegExp(
    `unknown command "${plugin}\\b|entire-${plugin} plugin is not installed|entire plugin install ${plugin}\\b`,
    'i',
  ).test(output);
}
