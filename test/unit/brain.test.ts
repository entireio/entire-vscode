import { describe, expect, it } from 'vitest';
import {
  BRAIN_VIZ_ARGS,
  brainDetails,
  hasBrain,
  isPluginMissing,
  parseVizUrl,
  readBrainStatus,
  type BrainStatus,
} from '../../src/core/brain';

describe('parseVizUrl', () => {
  it('reads the address from the line the plugin prints once it is listening', () => {
    // The line as entire-brain 0.5.1 prints it, with its em dash.
    expect(parseVizUrl('entire brain viz \u2014 http://127.0.0.1:49316')).toBe('http://127.0.0.1:49316');
  });

  it.each([
    ['at the start of the line', 'http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['followed by a slash and a path', 'Listening on http://127.0.0.1:8080/graph?x=1', 'http://127.0.0.1:8080'],
    ['followed by a full stop', 'Open http://127.0.0.1:8080.', 'http://127.0.0.1:8080'],
    ['with the lowest port', 'http://127.0.0.1:1', 'http://127.0.0.1:1'],
    ['with the highest port', 'http://127.0.0.1:65535', 'http://127.0.0.1:65535'],
    ['with leading zeros in the port', 'http://127.0.0.1:08080', 'http://127.0.0.1:8080'],
  ])('reads an address %s', (_label, line, expected) => {
    expect(parseVizUrl(line)).toBe(expected);
  });

  it.each([
    ['the second line the plugin prints', 'Read-only, loopback-only, no network. Press Ctrl-C to stop.'],
    ['an empty line', ''],
    ['an address with no port', 'http://127.0.0.1/'],
    ['port zero', 'http://127.0.0.1:0'],
    ['a port past the highest', 'http://127.0.0.1:65536'],
    ['a port of six digits', 'http://127.0.0.1:123456'],
    ['another host', 'http://192.168.1.10:8080'],
    ['a host that only starts like the loopback address', 'http://127.0.0.1.example.com:8080'],
    ['a host that only ends like it', 'http://evil.example/127.0.0.1:x'],
    ['the name localhost, which the plugin does not print', 'http://localhost:8080'],
    ['https, which the plugin does not serve', 'https://127.0.0.1:8080'],
  ])('finds no address in %s', (_label, line) => {
    expect(parseVizUrl(line)).toBeUndefined();
  });

  it('returns an address built from the port alone, whatever follows it in the line', () => {
    const url = parseVizUrl('entire brain viz \u2014 http://127.0.0.1:8080@evil.example/steal');
    expect(url).toBe('http://127.0.0.1:8080');
    expect(new URL(url ?? '').hostname).toBe('127.0.0.1');
  });
});

describe('readBrainStatus', () => {
  /** The parts of `entire brain status --json` from entire-brain 0.5.1 that matter here. */
  const built = {
    generated_at: '2026-03-02T10:00:00.000000Z',
    integrity: 'not_checked',
    repo: { root: '/repo', key: 'gh/acme/widget' },
    brain: {
      path: '/data/repos/gh/acme/widget',
      schema_version: 5,
      supported_schema_version: 5,
      manifest_state: 'current',
      generated_at: '2026-03-02T10:00:00Z',
    },
    sources: { seed: true, sessions: true, semantic: true, history: true, facts: true, docs: true },
    facts: { facts: 80, distilled: 80, authored: 0, superseded: 0 },
    hosted: { state: 'connected', repo_state: 'connected', no_egress: false, synced: true },
    semantic: {
      provider: { name: 'graph', version: 'v1.0.0' },
      coverage: { files: 60, symbols: 900, relations: 3200, warnings: 0, partial_failures: 0 },
      freshness: { severity: 'ok', axes: { graph: { state: 'ok', detail: 'Graph owns the committed-tree store' } } },
    },
    retrieval: {
      docs_records: 12,
      docs_files: 4,
      conversation: { exchanges: 300, incomplete_exchanges: 20 },
      freshness: {
        severity: 'ok',
        axes: { docs: { state: 'ok', detail: 'docs index is current' }, seed: { state: 'ok', detail: 'matches HEAD' } },
      },
    },
    onboarding: { daemon: { manager: 'launchd', installed: true, current: true, running: true } },
    live: { branch: 'main', dirty: false },
  };

  it('reads what a built brain holds and how it stands', () => {
    expect(readBrainStatus(built)).toEqual({
      manifestState: 'current',
      generatedAt: '2026-03-02T10:00:00Z',
      files: 60,
      symbols: 900,
      relations: 3200,
      memories: 80,
      exchanges: 300,
      docsRecords: 12,
      docsFiles: 4,
      freshness: 'ok',
      staleParts: [],
      updater: 'running',
      hosted: 'connected',
      hostedSynced: true,
      warnings: [],
    });
  });

  it('reads a repository with no brain, which has nothing to count', () => {
    const none = {
      repo: built.repo,
      brain: { path: built.brain.path, schema_version: 0, supported_schema_version: 5, manifest_state: 'absent' },
      hosted: { state: 'disconnected', repo_state: 'disconnected', no_egress: false },
      onboarding: { daemon: { installed: true, running: true } },
      warnings: ['agents not wired: run entire brain setup so your agent uses this brain'],
    };
    expect(readBrainStatus(none)).toEqual({
      manifestState: 'absent',
      staleParts: [],
      updater: 'running',
      hosted: 'disconnected',
      warnings: ['agents not wired: run entire brain setup so your agent uses this brain'],
    });
  });

  it('reports the worst freshness of the code graph and the indexes, with the reason for each part that is behind', () => {
    const stale = {
      brain: { manifest_state: 'current' },
      semantic: {
        freshness: { severity: 'degraded', axes: { graph: { state: 'stale', detail: 'index is 4 commits behind HEAD' } } },
      },
      retrieval: {
        freshness: {
          severity: 'unsafe',
          axes: { docs: { state: 'ok', detail: 'current' }, seed: { state: 'stale' } },
        },
      },
    };
    const status = readBrainStatus(stale);
    expect(status?.freshness).toBe('unsafe');
    expect(status?.staleParts).toEqual(['graph: index is 4 commits behind HEAD', 'seed: stale']);
    // The order of the two reports does not decide which is worse.
    const swapped = readBrainStatus({ ...stale, semantic: stale.retrieval, retrieval: stale.semantic });
    expect(swapped?.freshness).toBe('unsafe');
  });

  it('takes a freshness word it does not know for worse than ok, and no worse than unsafe', () => {
    const report = (first: string, second: string) =>
      readBrainStatus({
        brain: { manifest_state: 'current' },
        semantic: { freshness: { severity: first } },
        retrieval: { freshness: { severity: second } },
      })?.freshness;
    expect(report('ok', 'rebuilding')).toBe('rebuilding');
    expect(report('rebuilding', 'ok')).toBe('rebuilding');
    expect(report('rebuilding', 'unsafe')).toBe('unsafe');
  });

  it.each([
    ['running', { installed: true, running: true }, 'running'],
    ['installed and stopped', { installed: true, running: false }, 'stopped'],
    ['not installed', { installed: false, running: false }, 'notInstalled'],
    ['described with no fields', {}, 'notInstalled'],
  ])('reads a background updater that is %s', (_label, daemon, expected) => {
    expect(readBrainStatus({ brain: { manifest_state: 'current' }, onboarding: { daemon } })?.updater).toBe(expected);
  });

  it('leaves out what the report does not say', () => {
    expect(readBrainStatus({ brain: { manifest_state: 'current' } })).toEqual({
      manifestState: 'current',
      staleParts: [],
      warnings: [],
    });
  });

  it('keeps a state it does not know, and drops fields of the wrong type', () => {
    const odd = {
      brain: { manifest_state: 'unsupported', generated_at: 12 },
      semantic: { coverage: { files: '60', symbols: -1, relations: null }, freshness: { severity: 3, axes: [] } },
      facts: { facts: 'many' },
      retrieval: { docs_records: Number.NaN, conversation: 'none' },
      onboarding: { daemon: 'launchd' },
      hosted: { state: '', synced: 'yes' },
      warnings: 'none',
    };
    expect(readBrainStatus(odd)).toEqual({ manifestState: 'unsupported', staleParts: [], warnings: [] });
  });

  it('keeps at most ten warnings, trimmed, and none that are empty or not text', () => {
    const warnings = ['  first  ', '', 7, null, ...Array.from({ length: 20 }, (_, n) => `warning ${n}`), 'x'.repeat(900)];
    const status = readBrainStatus({ brain: { manifest_state: 'current' }, warnings });
    expect(status?.warnings).toHaveLength(10);
    expect(status?.warnings[0]).toBe('first');
    expect(status?.warnings[1]).toBe('warning 0');
    expect(readBrainStatus({ brain: { manifest_state: 'current' }, warnings: ['y'.repeat(900)] })?.warnings[0]).toHaveLength(400);
  });

  it.each([
    ['not an object', 'ok'],
    ['null', null],
    ['a list', [built]],
    ['no brain entry', { repo: built.repo }],
    ['a brain entry that is not an object', { brain: 'current' }],
    ['no state', { brain: { path: '/data' } }],
    ['an empty state', { brain: { manifest_state: '' } }],
    ['a state that is not text', { brain: { manifest_state: 1 } }],
  ])('rejects a report with %s', (_label, value) => {
    expect(readBrainStatus(value)).toBeUndefined();
  });
});

/** A status with only what a test sets. */
function status(overrides: Partial<BrainStatus> = {}): BrainStatus {
  return { manifestState: 'current', staleParts: [], warnings: [], ...overrides };
}

describe('hasBrain', () => {
  it('is false only for a repository with no brain at all', () => {
    expect(hasBrain(status({ manifestState: 'absent' }))).toBe(false);
    // A brain in any other state is on disk, and the graph page says what it can read of it.
    for (const state of ['current', 'corrupt', 'unsafe', 'unsupported', 'something-new']) {
      expect(hasBrain(status({ manifestState: state }))).toBe(true);
    }
  });
});

describe('brainDetails', () => {
  const lines = (overrides: Partial<BrainStatus>, updated?: string) =>
    brainDetails(status(overrides), updated).map((detail) => `${detail.label}: ${detail.value}`);

  it('lists what a built brain holds, in a fixed order', () => {
    const full = status({
      generatedAt: '2026-03-02T10:00:00Z',
      files: 60,
      symbols: 900,
      relations: 3200,
      memories: 80,
      exchanges: 300,
      docsRecords: 12,
      docsFiles: 4,
      freshness: 'ok',
      updater: 'running',
      hosted: 'connected',
      hostedSynced: true,
    });
    expect(brainDetails(full, '2h ago')).toEqual([
      { key: 'state', label: 'Brain', value: 'Built · updated 2h ago' },
      { key: 'graph', label: 'Code graph', value: '60 files · 900 symbols · 3,200 relations' },
      { key: 'memories', label: 'Memories', value: '80' },
      { key: 'conversations', label: 'Conversations', value: '300 exchanges' },
      { key: 'docs', label: 'Docs', value: '12 records from 4 files' },
      { key: 'freshness', label: 'Freshness', value: 'Up to date' },
      { key: 'updates', label: 'Updates', value: 'Running in the background' },
      { key: 'hosted', label: 'Hosted brain', value: 'Connected · synced' },
    ]);
  });

  it('says only that the brain is built when the report says no more', () => {
    expect(brainDetails(status())).toEqual([{ key: 'state', label: 'Brain', value: 'Built' }]);
  });

  it('uses the singular for one of a thing, and groups thousands', () => {
    expect(lines({ files: 1, symbols: 1, relations: 1, exchanges: 1, docsRecords: 1, docsFiles: 1, memories: 12345 })).toEqual([
      'Brain: Built',
      'Code graph: 1 file · 1 symbol · 1 relation',
      'Memories: 12,345',
      'Conversations: 1 exchange',
      'Docs: 1 record from 1 file',
    ]);
  });

  it('lists the parts of the code graph that the report counts, and zero when it counts none', () => {
    expect(lines({ symbols: 0 })).toEqual(['Brain: Built', 'Code graph: 0 symbols']);
    expect(lines({ docsRecords: 4 })).toEqual(['Brain: Built', 'Docs: 4 records']);
  });

  it('marks a brain that is not in a usable state, in the plugin\'s word, and says where to look', () => {
    const [state] = brainDetails(status({ manifestState: 'unsupported' }), '3d ago');
    expect(state).toEqual({
      key: 'state',
      label: 'Brain',
      value: 'Unsupported · updated 3d ago',
      attention: true,
      tooltip: 'Run "entire brain status" in a terminal for the details.',
    });
  });

  it('marks a brain that is behind, and gives the reasons on hover', () => {
    const [, freshness] = brainDetails(status({ freshness: 'degraded', staleParts: ['graph: 4 commits behind HEAD', 'seed: stale'] }));
    expect(freshness).toEqual({
      key: 'freshness',
      label: 'Freshness',
      value: 'Degraded',
      attention: true,
      tooltip: 'graph: 4 commits behind HEAD\nseed: stale',
    });
    expect(lines({ freshness: 'needs_rebuild' })[1]).toBe('Freshness: Needs rebuild');
  });

  it.each([
    ['stopped', 'Updates: Not running', true],
    ['notInstalled', 'Updates: Not installed', undefined],
    ['running', 'Updates: Running in the background', undefined],
  ] as const)('says whether the background updater is %s', (updater, line, attention) => {
    const [, detail] = brainDetails(status({ updater }));
    expect(`${detail?.label}: ${detail?.value}`).toBe(line);
    expect(detail?.attention).toBe(attention);
  });

  it.each([
    [{ hosted: 'connected', hostedSynced: false }, 'Hosted brain: Connected · not synced'],
    [{ hosted: 'connected' }, 'Hosted brain: Connected'],
    [{ hosted: 'disconnected', hostedSynced: false }, 'Hosted brain: Not connected'],
    [{ hosted: 'pending_approval' }, 'Hosted brain: Pending approval'],
  ])('describes the hosted brain of %j', (overrides, line) => {
    expect(lines(overrides)[1]).toBe(line);
  });

  it('lists each warning last, in full on hover', () => {
    const details = brainDetails(status({ memories: 3, warnings: ['agents not wired: run entire brain setup', 'second'] }));
    expect(details.slice(-2)).toEqual([
      { key: 'warning', label: 'Warning', value: 'agents not wired: run entire brain setup', tooltip: 'agents not wired: run entire brain setup', attention: true },
      { key: 'warning', label: 'Warning', value: 'second', tooltip: 'second', attention: true },
    ]);
  });
});

describe('isPluginMissing', () => {
  it.each([
    ['the usage error of CLI 0.13.3', 'Use "entire [command] --help" for more information.\n\nError: Invalid usage: unknown command "brain status --json" for "entire"\n'],
    ['the usage error for the bare command', 'Error: Invalid usage: unknown command "brain" for "entire"'],
    ['the hint of a newer CLI', "the entire-brain plugin is not installed; run 'entire plugin install brain' and retry"],
  ])('recognizes %s', (_label, output) => {
    expect(isPluginMissing(output)).toBe(true);
  });

  it.each([
    ['another unknown command', 'Error: Invalid usage: unknown command "brainstorm" for "entire"'],
    ['a failure of the plugin itself', 'resolve git root: exit status 128'],
    ['a port that is taken', 'bind viz server: listen tcp 127.0.0.1:8080: bind: address already in use'],
    ['no output', ''],
  ])('does not take %s for a missing plugin', (_label, output) => {
    expect(isPluginMissing(output)).toBe(false);
  });
});

describe('BRAIN_VIZ_ARGS', () => {
  it('keeps the plugin from opening a browser itself and lets it pick a free port', () => {
    expect(BRAIN_VIZ_ARGS).toEqual(['brain', 'viz', '--no-open', '--port', '0']);
  });
});
