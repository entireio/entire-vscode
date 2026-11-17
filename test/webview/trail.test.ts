// @vitest-environment jsdom
// The trail's description is Markdown, and DOMPurify, which cleans it, needs a
// standards-compliant DOM. See markdown.test.ts.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  type TrailChangeView,
  type TrailCommitView,
  type TrailEventView,
  type TrailMergeView,
  type TrailTarget,
  type TrailTimelineView,
  type TrailView,
  type TrailWebviewMessage,
} from '../../src/shared/protocol';
import { createTrailApp, type TrailApp, type TrailVsCodeApi } from '../../src/webview/trail';

const RESTORE: TrailTarget = { repoRoot: '/repo', mode: 'trail', trail: 42 };
const XSS = '<img src=x onerror=alert(1)>';

interface Harness {
  root: HTMLElement;
  app: TrailApp;
  posted: TrailWebviewMessage[];
  savedState(): unknown;
}

/** Mounts the page on a fresh root with a fake VS Code API that records what is posted. */
function mount(): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const posted: TrailWebviewMessage[] = [];
  let saved: unknown;
  const api: TrailVsCodeApi = {
    postMessage: (message) => {
      posted.push(message);
    },
    setState: (state) => {
      saved = state;
    },
    getState: () => saved,
  };
  return { root, app: createTrailApp(root, api), posted, savedState: () => saved };
}

function merge(overrides: Partial<TrailMergeView> = {}): TrailMergeView {
  return { mergeable: true, gates: [], checks: [], checkSummary: '', ...overrides };
}

function change(overrides: Partial<TrailChangeView> = {}): TrailChangeView {
  return {
    repository: 'widget',
    number: 7,
    branch: 'feature/parser',
    base: 'main',
    checkedOut: false,
    hasCodeChanges: true,
    canOpenOnWeb: true,
    ...overrides,
  };
}

function commit(overrides: Partial<TrailCommitView> = {}): TrailCommitView {
  return { shortSha: 'abc1234', local: true, checkpoints: 1, remoteCheckpoints: 1, agents: [], ...overrides };
}

function commitEvent(text: string, overrides: Partial<TrailCommitView> = {}): TrailEventView {
  return { kind: 'commit', text, actor: 'Fixture Author', at: '2026-03-02T09:00:00Z', commit: commit(overrides) };
}

function timeline(events: TrailEventView[] = [], overrides: Partial<TrailTimelineView> = {}): TrailTimelineView {
  return { events, hasMore: false, ...overrides };
}

function view(overrides: Partial<TrailView> = {}): TrailView {
  return {
    number: 42,
    title: 'Rework the parser',
    status: 'open',
    phase: 'building',
    assignees: [],
    body: '',
    canOpenOnWeb: true,
    changes: [change()],
    selected: 0,
    timeline: timeline(),
    ...overrides,
  };
}

function show(app: TrailApp, overrides: Partial<TrailView> = {}): void {
  app.handle({ type: 'trail', protocol: PROTOCOL_VERSION, view: view(overrides), restore: RESTORE });
}

function buttonNamed(root: HTMLElement, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === name);
  if (!found) throw new Error(`No button named "${name}". Buttons: ${[...root.querySelectorAll('button')].map((b) => b.textContent).join(' | ')}`);
  return found;
}

const hasButton = (root: HTMLElement, name: string): boolean =>
  [...root.querySelectorAll('button')].some((candidate) => candidate.textContent === name);

const texts = (root: HTMLElement, selector: string): string[] =>
  [...root.querySelectorAll(selector)].map((element) => element.textContent ?? '');

afterEach(() => {
  document.body.replaceChildren();
});

describe('the trail page before it has a trail', () => {
  it('says it is loading and tells the host it is ready', () => {
    const { root, app, posted } = mount();
    app.start();
    expect(root.textContent).toBe('Loading…');
    expect(posted).toEqual([{ type: 'ready', protocol: PROTOCOL_VERSION }]);
  });

  it('shows a failure with a way to retry', () => {
    const { root, app, posted } = mount();
    app.handle({ type: 'error', message: 'You are not logged in to Entire.', canRetry: true });
    expect(root.querySelector('[role="status"]')?.textContent).toContain('You are not logged in to Entire.');
    buttonNamed(root, 'Retry').click();
    expect(posted).toEqual([{ type: 'retry' }]);
  });

  it('offers no retry when one cannot help', () => {
    const { root, app } = mount();
    app.handle({ type: 'error', message: 'The repository for this tab is not open in this window.', canRetry: false });
    expect(hasButton(root, 'Retry')).toBe(false);
  });

  it('replaces a trail with the loading text when the host starts another load', () => {
    const { root, app } = mount();
    show(app);
    app.handle({ type: 'loading', title: 'Loading' });
    expect(root.textContent).toBe('Loading…');
  });
});

describe('the trail header', () => {
  it('shows the title, the number, and what the trail is', () => {
    const { root, app } = mount();
    show(app, { type: 'feature', priority: 'high', project: 'acme', assignees: ['ada', 'grace'] });
    expect(root.querySelector('h1')?.textContent).toBe('Rework the parser');
    const header = root.querySelector('header')?.textContent ?? '';
    expect(header).toContain('Trail #42');
    expect(header).toContain('Building');
    expect(header).toContain('Feature');
    expect(header).toContain('High priority');
    expect(header).toContain('acme');
    expect(header).toContain('Assigned to ada, grace');
  });

  it('remembers what it is open on, for a window reload', () => {
    const { app, savedState } = mount();
    show(app);
    expect(savedState()).toEqual(RESTORE);
  });

  it('falls back to the status when the trail has no phase', () => {
    const { root, app } = mount();
    const trail = view({ status: 'closed' });
    delete trail.phase;
    app.handle({ type: 'trail', protocol: PROTOCOL_VERSION, view: trail, restore: RESTORE });
    expect(root.querySelector('.badge')?.textContent).toBe('Closed');
    expect(root.querySelector('.badge')?.classList.contains('closed')).toBe(true);
  });

  it('says when the trail closed in place of its last activity', () => {
    const { root, app } = mount();
    show(app, { lastActivityAt: '2026-03-02T00:00:00Z', closedAt: '2026-03-05T00:00:00Z' });
    const header = root.querySelector('header')?.textContent ?? '';
    expect(header).toContain('Closed ');
    expect(header).not.toContain('Last activity');
  });

  it('opens the trail on the web, copies its link, and refreshes', () => {
    const { root, app, posted } = mount();
    show(app);
    buttonNamed(root, 'Open on entire.com').click();
    buttonNamed(root, 'Copy Link').click();
    buttonNamed(root, 'Refresh').click();
    expect(posted).toEqual([{ type: 'openOnWeb' }, { type: 'copyLink' }, { type: 'retry' }]);
  });

  it('offers no link when the CLI reported no address', () => {
    const { root, app } = mount();
    show(app, { canOpenOnWeb: false });
    expect(hasButton(root, 'Open on entire.com')).toBe(false);
    expect(hasButton(root, 'Copy Link')).toBe(false);
    expect(hasButton(root, 'Refresh')).toBe(true);
  });

  it('shows text from the trail as text, never as markup', () => {
    const { root, app } = mount();
    show(app, { title: XSS, project: XSS, assignees: [XSS], type: XSS });
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('h1')?.textContent).toBe(XSS);
  });
});

describe('the trail description', () => {
  it('renders Markdown', () => {
    const { root, app } = mount();
    show(app, { body: 'Rework the **parser**.\n\n- Sketch it\n- Write it\n' });
    const description = root.querySelector('.description');
    expect(description?.querySelector('strong')?.textContent).toBe('parser');
    expect(texts(root, '.description li')).toEqual(['Sketch it', 'Write it']);
  });

  it('is left out when the trail has none', () => {
    const { root, app } = mount();
    show(app, { body: '  \n' });
    expect(root.querySelector('.description')).toBeNull();
  });

  it('does not run or load anything a description contains', () => {
    const { root, app } = mount();
    show(app, {
      body: `${XSS}\n\n<script>window.pwned = true</script>\n\n![tracker](https://tracker.example.test/pixel.png)\n\n[click](javascript:alert(1))`,
    });
    const description = root.querySelector('.description');
    expect(description?.querySelector('img')).toBeNull();
    expect(description?.querySelector('script')).toBeNull();
    expect(description?.querySelector('[onerror]')).toBeNull();
    expect((window as unknown as { pwned?: boolean }).pwned).toBeUndefined();
    // A remote image becomes a link, so opening the trail tells no server about it.
    expect(description?.querySelector('a[href="https://tracker.example.test/pixel.png"]')).not.toBeNull();
    expect([...(description?.querySelectorAll('a') ?? [])].some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:'))).toBe(false);
  });

  it('hands a clicked link to the host instead of following it', () => {
    const { root, app, posted } = mount();
    show(app, { body: 'See [the docs](https://docs.example.test/trails).' });
    const link = root.querySelector('.description a');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(posted).toEqual([{ type: 'openLink', href: 'https://docs.example.test/trails' }]);
  });
});

describe('the changes of a trail', () => {
  it('shows the branch, its base, and where the change stands', () => {
    const { root, app, posted } = mount();
    show(app, { changes: [change({ title: 'Parser rework', status: 'open', checkedOut: true })] });
    const section = root.querySelector('.change');
    expect(section?.querySelector('h2')?.textContent).toBe('Change widget #7');
    expect(section?.querySelector('.change-title')?.textContent).toBe('Parser rework');
    expect(section?.textContent).toContain('into main');
    expect(section?.textContent).toContain('Open');
    expect(section?.textContent).toContain('Checked out here');
    buttonNamed(root, 'feature/parser').click();
    buttonNamed(root, 'Open Change on entire.com').click();
    expect(posted).toEqual([{ type: 'copyBranch' }, { type: 'openChangeOnWeb' }]);
  });

  it('says when a change has no code yet', () => {
    const { root, app } = mount();
    show(app, { changes: [change({ hasCodeChanges: false })] });
    expect(root.querySelector('.change')?.textContent).toContain('No code changes yet');
  });

  it('has no tabs for a single change', () => {
    const { root, app } = mount();
    show(app);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
  });

  it('has a tab for each change and asks the host for the one clicked', () => {
    const { root, app, posted } = mount();
    show(app, { changes: [change(), change({ repository: 'docs', number: 9, branch: 'feature/docs' })], selected: 0 });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((tab) => tab.textContent)).toEqual(['widget #7', 'docs #9']);
    expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    tabs[0]?.click();
    expect(posted).toEqual([]);
    tabs[1]?.click();
    expect(posted).toEqual([{ type: 'selectChange', position: 1 }]);
  });

  it('shows the selected change, not the first', () => {
    const { root, app } = mount();
    show(app, { changes: [change(), change({ repository: 'docs', number: 9 })], selected: 1 });
    expect(root.querySelector('.change h2')?.textContent).toBe('Change docs #9');
  });

  it('moves between tabs with the arrow keys', () => {
    const { root, app } = mount();
    show(app, { changes: [change(), change({ repository: 'docs', number: 9 })] });
    const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs[0]?.focus();
    tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[1]);
    tabs[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(tabs[0]);
  });

  it('says so when the trail has no branch yet', () => {
    const { root, app } = mount();
    const trail = view({ changes: [] });
    delete trail.timeline;
    app.handle({ type: 'trail', protocol: PROTOCOL_VERSION, view: trail, restore: RESTORE });
    expect(root.textContent).toContain('This trail has no branch in a repository yet.');
    expect(root.querySelector('.timeline-section')).toBeNull();
  });
});

describe('the merge state of a change', () => {
  const verdict = (root: HTMLElement): string => root.querySelector('.verdict')?.textContent ?? '';

  it('says when the change is ready to merge', () => {
    const { root, app } = mount();
    show(app, { changes: [change({ merge: merge({ mergeable: true }) })] });
    expect(verdict(root)).toBe('Ready to merge.');
  });

  it('names the gates that block a merge', () => {
    const { root, app } = mount();
    show(app, {
      changes: [
        change({
          merge: merge({
            mergeable: false,
            gates: [
              { label: 'Approvals', outcome: 'failed', blocking: true, rationale: '0 of 1 required approvals.' },
              { label: 'Checks', outcome: 'pending', blocking: true },
              { label: 'Findings', outcome: 'passed', blocking: true, findings: 0 },
              { label: 'Up to date with base', outcome: 'failed', blocking: false },
            ],
          }),
        }),
      ],
    });
    // A gate that does not block is reported and is not a reason.
    expect(verdict(root)).toBe('Not ready to merge: approvals, checks.');
    expect(texts(root, '.gate .outcome')).toEqual(['Failed', 'Pending', 'Passed', 'Failed']);
    const gates = texts(root, '.gate');
    expect(gates[0]).toContain('Approvals');
    expect(gates[0]).toContain('0 of 1 required approvals.');
    expect(gates[3]).toContain('does not block a merge');
    expect(gates[2]).not.toContain('finding');
  });

  it('puts conflicts first among the reasons', () => {
    const { root, app } = mount();
    show(app, {
      changes: [
        change({
          merge: merge({
            mergeable: false,
            conflict: 'conflicting',
            gates: [{ label: 'Approvals', outcome: 'failed', blocking: true }],
          }),
        }),
      ],
    });
    expect(verdict(root)).toBe('Not ready to merge: the branch has conflicts with its base (conflicting).');
  });

  it('gives no reason when it knows none', () => {
    const { root, app } = mount();
    show(app, { changes: [change({ merge: merge({ mergeable: false }) })] });
    expect(verdict(root)).toBe('Not ready to merge.');
  });

  it('counts the findings behind a gate', () => {
    const { root, app } = mount();
    show(app, {
      changes: [
        change({
          merge: merge({
            mergeable: false,
            gates: [
              { label: 'Findings', outcome: 'failed', blocking: true, findings: 3 },
              { label: 'Other', outcome: 'failed', blocking: true, findings: 1 },
            ],
          }),
        }),
      ],
    });
    expect(texts(root, '.gate')[0]).toContain('3 findings');
    expect(texts(root, '.gate')[1]).toContain('1 finding');
    expect(texts(root, '.gate')[1]).not.toContain('1 findings');
  });

  it('shows no merge state for a change that has none', () => {
    const { root, app } = mount();
    show(app);
    expect(root.querySelector('.verdict')).toBeNull();
    expect(root.querySelector('.gates')).toBeNull();
  });

  it('lists CI runs with the ones that need attention first, and opens a run by its own position', () => {
    const { root, app, posted } = mount();
    show(app, {
      changes: [
        change({
          merge: merge({
            mergeable: false,
            checkSummary: '1 failed, 1 pending, 1 passed',
            checks: [
              { name: 'build', outcome: 'passed', detail: 'success', app: 'CI', hasLink: true },
              { name: 'deploy', outcome: 'pending', detail: 'in progress', hasLink: false },
              { name: 'lint', outcome: 'failed', detail: 'failure', hasLink: true },
            ],
          }),
        }),
      ],
    });
    const group = root.querySelector<HTMLDetailsElement>('.checks-group');
    expect(group?.querySelector('summary')?.textContent).toBe('CI runs 1 failed, 1 pending, 1 passed');
    // Something failed, so the list starts open.
    expect(group?.open).toBe(true);
    const checks = texts(root, '.check');
    expect(checks.map((text) => text.replace(/^(Failed|Pending|Passed|Skipped)/, '$1 '))).toEqual([
      'Failed lintfailure',
      'Pending deployin progress',
      'Passed buildsuccess · CI',
    ]);
    // "lint" is drawn first and is the third run the host knows.
    buttonNamed(root, 'lint').click();
    buttonNamed(root, 'build').click();
    expect(posted).toEqual([
      { type: 'openCheck', run: 2 },
      { type: 'openCheck', run: 0 },
    ]);
    // A run with no page of its own is text, not a button.
    expect(hasButton(root, 'deploy')).toBe(false);
  });

  it('keeps the list of CI runs closed when every run passed', () => {
    const { root, app } = mount();
    show(app, {
      changes: [
        change({
          merge: merge({
            checkSummary: '2 passed',
            checks: [
              { name: 'build', outcome: 'passed', detail: 'success', hasLink: false },
              { name: 'docs', outcome: 'skipped', detail: 'skipped', hasLink: false },
            ],
          }),
        }),
      ],
    });
    expect(root.querySelector<HTMLDetailsElement>('.checks-group')?.open).toBe(false);
  });

  it('says why no CI runs are listed', () => {
    const { root, app } = mount();
    show(app, {
      changes: [change({ merge: merge({ checksNote: 'Entire could not read the CI runs of this branch (unavailable).' }) })],
    });
    expect(root.querySelector('.change .notice')?.textContent).toBe('Entire could not read the CI runs of this branch (unavailable).');
    expect(root.querySelector('.checks-group')).toBeNull();
  });

  it('shows gate and run text as text, never as markup', () => {
    const { root, app } = mount();
    show(app, {
      changes: [
        change({
          title: XSS,
          branch: XSS,
          merge: merge({
            mergeable: false,
            gates: [{ label: XSS, outcome: 'failed', blocking: true, rationale: XSS }],
            checks: [{ name: XSS, outcome: 'failed', detail: XSS, app: XSS, hasLink: true }],
            checkSummary: XSS,
          }),
        }),
      ],
    });
    expect(root.querySelector('img')).toBeNull();
  });
});

describe('the timeline of a change', () => {
  it('shows what happened, who did it, and when', () => {
    const { root, app } = mount();
    show(app, {
      timeline: timeline([
        { kind: 'review_posted', text: 'Posted a review with 2 findings', actor: 'Review Agent', at: '2026-03-02T10:00:00Z' },
        commitEvent('Add the parser', { additions: 1200, deletions: 3, files: 2, agents: ['Claude Code'] }),
      ]),
    });
    const events = [...root.querySelectorAll('.event')];
    expect(events).toHaveLength(2);
    expect(events[0]?.classList.contains('note')).toBe(true);
    expect(events[0]?.textContent).toContain('Review Agent');
    expect(events[0]?.textContent).toContain('Posted a review with 2 findings');
    expect(events[0]?.querySelector('time')?.getAttribute('datetime')).toBe('2026-03-02T10:00:00Z');
    expect(events[1]?.classList.contains('commit')).toBe(true);
    expect(events[1]?.querySelector('.event-text')?.textContent).toBe('Add the parser');
    expect(events[1]?.querySelector('.stat-add')?.textContent).toBe('+1,200');
    expect(events[1]?.querySelector('.stat-del')?.textContent).toBe('-3');
    expect(events[1]?.textContent).toContain('2 files');
    expect(events[1]?.textContent).toContain('Claude Code');
  });

  it('opens the checkpoint and the diff of a commit by the commit\'s position', () => {
    const { root, app, posted } = mount();
    show(app, {
      timeline: timeline([
        { kind: 'trail_created', text: 'Created the trail' },
        commitEvent('Add the parser'),
      ]),
    });
    buttonNamed(root, 'Open Checkpoint').click();
    buttonNamed(root, 'Show Commit Diff').click();
    buttonNamed(root, 'abc1234').click();
    expect(posted).toEqual([
      { type: 'openCheckpoint', event: 1, checkpoint: 0 },
      { type: 'showCommitDiff', event: 1 },
      { type: 'copyCommitSha', event: 1 },
    ]);
  });

  it('offers each checkpoint of a commit that carries several', () => {
    const { root, app, posted } = mount();
    show(app, { timeline: timeline([commitEvent('Squash the review fixes', { checkpoints: 2 })]) });
    expect(hasButton(root, 'Open Checkpoint')).toBe(false);
    buttonNamed(root, 'Open Checkpoint 2').click();
    buttonNamed(root, 'Open Checkpoint 1').click();
    expect(posted).toEqual([
      { type: 'openCheckpoint', event: 0, checkpoint: 1 },
      { type: 'openCheckpoint', event: 0, checkpoint: 0 },
    ]);
  });

  it('offers the diff alone for a commit with no checkpoint', () => {
    const { root, app } = mount();
    show(app, { timeline: timeline([commitEvent('Tidy the README', { checkpoints: 0, remoteCheckpoints: 0 })]) });
    expect([...root.querySelectorAll('.event-actions button')].map((button) => button.textContent)).toEqual(['Show Commit Diff']);
  });

  it('says when a commit is not in this clone, and offers nothing that needs it', () => {
    const { root, app } = mount();
    show(app, {
      timeline: timeline([
        commitEvent('Tune the lexer', { local: false, checkpoints: 0, remoteCheckpoints: 2 }),
        commitEvent('Tidy the README', { local: false, checkpoints: 0, remoteCheckpoints: 0 }),
      ]),
    });
    const events = texts(root, '.event');
    expect(events[0]).toContain('Not in this clone · 2 checkpoints on entire.com');
    expect(events[1]).toContain('Not in this clone');
    expect(events[1]).not.toContain('on entire.com');
    expect(root.querySelector('.event-actions')).toBeNull();
  });

  it('leaves out the line counts of a commit that has none', () => {
    const { root, app } = mount();
    show(app, { timeline: timeline([commitEvent('Add the parser')]) });
    expect(root.querySelector('.stat-add')).toBeNull();
  });

  it('says when nothing has happened yet', () => {
    const { root, app } = mount();
    show(app, { timeline: timeline([]) });
    expect(root.querySelector('.timeline-section')?.textContent).toContain('Nothing has happened on this change yet.');
  });

  it('shows a caveat in place of the empty text', () => {
    const { root, app } = mount();
    show(app, { timeline: timeline([], { notice: 'The Entire CLI could not read the trail timeline. Refresh to try again.' }) });
    const section = root.querySelector('.timeline-section');
    expect(section?.querySelector('.notice')?.textContent).toContain('could not read the trail timeline');
    expect(section?.textContent).not.toContain('Nothing has happened');
  });

  it('loads more on request and numbers the new entries after the old ones', () => {
    const { root, app, posted } = mount();
    show(app, { timeline: timeline([commitEvent('Second commit')], { hasMore: true }) });
    const more = buttonNamed(root, 'Load More');
    more.click();
    expect(posted).toEqual([{ type: 'loadMoreTimeline' }]);
    // The button waits for the page, so a second click cannot ask twice.
    expect(more.disabled).toBe(true);

    app.handle({ type: 'timelinePage', events: [commitEvent('First commit', { shortSha: 'def5678' })], hasMore: false });
    expect(texts(root, '.event-text')).toEqual(['Second commit', 'First commit']);
    expect(hasButton(root, 'Load More')).toBe(false);
    [...root.querySelectorAll<HTMLButtonElement>('.event-actions button')]
      .filter((button) => button.textContent === 'Open Checkpoint')
      .at(-1)
      ?.click();
    expect(posted.at(-1)).toEqual({ type: 'openCheckpoint', event: 1, checkpoint: 0 });
  });

  it('offers to load more again after a page fails, and says what went wrong', () => {
    const { root, app, posted } = mount();
    show(app, { timeline: timeline([commitEvent('Second commit')], { hasMore: true }) });
    buttonNamed(root, 'Load More').click();
    app.handle({ type: 'timelinePage', events: [], hasMore: true, notice: 'The Entire CLI took too long to read the trail timeline.' });
    expect(root.querySelector('.timeline-more .notice')?.textContent).toBe('The Entire CLI took too long to read the trail timeline.');
    const again = buttonNamed(root, 'Load More');
    expect(again.disabled).toBe(false);
    again.click();
    expect(posted).toEqual([{ type: 'loadMoreTimeline' }, { type: 'loadMoreTimeline' }]);
  });

  it('starts numbering again when the page is drawn for another trail', () => {
    const { root, app, posted } = mount();
    show(app, { timeline: timeline([commitEvent('One'), commitEvent('Two')]) });
    show(app, { number: 43, timeline: timeline([commitEvent('Only')]) });
    expect(texts(root, '.event-text')).toEqual(['Only']);
    buttonNamed(root, 'Open Checkpoint').click();
    expect(posted).toEqual([{ type: 'openCheckpoint', event: 0, checkpoint: 0 }]);
  });

  it('ignores a page of the timeline that arrives when no trail is shown', () => {
    const { root, app } = mount();
    app.handle({ type: 'error', message: 'Entire could not find this trail.', canRetry: true });
    app.handle({ type: 'timelinePage', events: [commitEvent('Late')], hasMore: true });
    expect(root.querySelector('.event')).toBeNull();
    expect(hasButton(root, 'Load More')).toBe(false);
  });

  it('shows timeline text as text, never as markup', () => {
    const { root, app } = mount();
    show(app, { timeline: timeline([commitEvent(XSS, { shortSha: XSS, agents: [XSS] }), { kind: XSS, text: XSS, actor: XSS }], { notice: XSS }) });
    expect(root.querySelector('img')).toBeNull();
    expect(texts(root, '.event-text')).toEqual([XSS, XSS]);
  });
});

describe('a trail that arrives in stages', () => {
  /** A view of a trail whose timeline the host has not sent. */
  function withoutTimeline(overrides: Partial<TrailView> = {}): TrailView {
    const { timeline: _timeline, ...rest } = view();
    return { ...rest, ...overrides };
  }

  const send = (app: TrailApp, trail: TrailView): void =>
    app.handle({ type: 'trail', protocol: PROTOCOL_VERSION, view: trail, restore: RESTORE });

  /** What the Trails view lists about a trail: the top of the page, and none of its changes. */
  const listedOnly = (): TrailView =>
    withoutTimeline({ partial: true, changes: [], canOpenOnWeb: false, body: 'Why and **how**.' });

  it('draws the top of the page from what the Trails view listed, and says the rest is loading', () => {
    const { root, app } = mount();
    send(app, listedOnly());
    expect(root.querySelector('h1')?.textContent).toBe('Rework the parser');
    expect(root.querySelector('.header .meta')?.textContent).toContain('Trail #42');
    expect(root.querySelector('.description strong')?.textContent).toBe('how');
    expect(root.querySelector('.pending')?.textContent).toBe('Loading…');
    expect(root.querySelector('.pending')?.getAttribute('role')).toBe('status');
    // Nothing about the changes is known yet, so nothing claims the trail has none.
    expect(root.querySelector('.change')).toBeNull();
    expect(root.querySelector('.timeline-section')).toBeNull();
    expect(root.textContent).not.toContain('no branch in a repository');
    // The trail's address comes with the trail itself.
    expect(hasButton(root, 'Open on entire.com')).toBe(false);
    expect(hasButton(root, 'Refresh')).toBe(true);
  });

  it('draws the changes when the trail arrives, with the timeline still loading', () => {
    const { root, app } = mount();
    send(app, listedOnly());
    send(app, withoutTimeline({ timelinePending: true, changes: [change({ merge: merge() })] }));
    expect(root.querySelector('.change h2')?.textContent).toBe('Change widget #7');
    expect(root.querySelector('.verdict')?.textContent).toBe('Ready to merge.');
    expect(hasButton(root, 'Open on entire.com')).toBe(true);
    const section = root.querySelector('.timeline-section');
    expect(section?.querySelector('h2')?.textContent).toBe('Timeline');
    expect(section?.querySelector('.pending')?.textContent).toBe('Loading…');
    expect(section?.textContent).not.toContain('Nothing has happened');
    expect(root.querySelectorAll('.pending')).toHaveLength(1);
    expect(hasButton(root, 'Load More')).toBe(false);
  });

  it('puts the timeline in place when it arrives, and leaves the rest of the page alone', () => {
    const { root, app, posted } = mount();
    const runs = merge({
      checks: [{ name: 'build', outcome: 'passed', detail: 'success', hasLink: false }],
      checkSummary: '1 passed',
    });
    send(app, withoutTimeline({ timelinePending: true, changes: [change({ merge: runs })] }));
    const section = root.querySelector('.change');
    const group = root.querySelector<HTMLDetailsElement>('.checks-group');
    expect(group?.open).toBe(false);
    if (group) group.open = true;

    app.handle({ type: 'timeline', timeline: timeline([commitEvent('Add the parser')], { hasMore: true }) });
    expect(texts(root, '.event-text')).toEqual(['Add the parser']);
    expect(root.querySelector('.timeline-section .pending')).toBeNull();
    expect(root.querySelectorAll('.timeline-section')).toHaveLength(1);
    // The change's section is the same element, with the list of CI runs as the reader left it.
    expect(root.querySelector('.change')).toBe(section);
    expect(root.querySelector<HTMLDetailsElement>('.checks-group')?.open).toBe(true);

    buttonNamed(root, 'Load More').click();
    app.handle({ type: 'timelinePage', events: [commitEvent('Start the parser')], hasMore: false });
    expect(texts(root, '.event-text')).toEqual(['Add the parser', 'Start the parser']);
    [...root.querySelectorAll<HTMLButtonElement>('.event-actions button')]
      .filter((button) => button.textContent === 'Show Commit Diff')
      .at(-1)
      ?.click();
    expect(posted.at(-1)).toEqual({ type: 'showCommitDiff', event: 1 });
  });

  it('puts a fresh timeline in place of an earlier one and numbers its entries from the start', () => {
    const { root, app, posted } = mount();
    show(app, { timeline: timeline([commitEvent('Old one'), commitEvent('Old two')], { hasMore: true }) });
    app.handle({ type: 'timeline', timeline: timeline([commitEvent('New one')]) });
    expect(texts(root, '.event-text')).toEqual(['New one']);
    expect(hasButton(root, 'Load More')).toBe(false);
    buttonNamed(root, 'Open Checkpoint').click();
    expect(posted).toEqual([{ type: 'openCheckpoint', event: 0, checkpoint: 0 }]);
  });

  it('shows a timeline that could not be read as a caveat where the timeline would be', () => {
    const { root, app } = mount();
    send(app, withoutTimeline({ timelinePending: true }));
    app.handle({
      type: 'timeline',
      timeline: timeline([], { notice: 'The Entire CLI could not read the trail timeline. Refresh to try again.' }),
    });
    expect(root.querySelector('.timeline-section .notice')?.textContent).toContain('Refresh to try again.');
    expect(root.querySelector('.pending')).toBeNull();
  });

  it('ignores a timeline that arrives when there is nowhere to put it', () => {
    const { root, app } = mount();
    app.handle({ type: 'timeline', timeline: timeline([commitEvent('Early')]) });
    app.handle({ type: 'error', message: 'Entire could not find this trail.', canRetry: true });
    app.handle({ type: 'timeline', timeline: timeline([commitEvent('Late')]) });
    send(app, listedOnly());
    app.handle({ type: 'timeline', timeline: timeline([commitEvent('Too soon')]) });
    // A trail with no changes has no timeline.
    send(app, withoutTimeline({ changes: [] }));
    app.handle({ type: 'timeline', timeline: timeline([commitEvent('For no change')]) });
    expect(root.querySelector('.event')).toBeNull();
    expect(root.querySelector('.timeline-section')).toBeNull();
  });

  it('says so while a trail drawn from an earlier read is checked, and stops when the check ends', () => {
    const { root, app } = mount();
    show(app, { refreshing: true });
    const status = root.querySelector<HTMLElement>('.refresh-status');
    expect(status?.textContent).toBe('Checking Entire for updates…');
    expect(status?.getAttribute('role')).toBe('status');
    expect(status?.hidden).toBe(false);

    app.handle({ type: 'refreshed' });
    expect(root.querySelector('.refresh-status')).toBe(status);
    expect(status?.hidden).toBe(true);
    expect(status?.textContent).toBe('');
  });

  it('says why when the check failed, and keeps the trail on the page', () => {
    const { root, app } = mount();
    show(app, { refreshing: true, timeline: timeline([commitEvent('Add the parser')]) });
    app.handle({ type: 'refreshed', notice: 'You are not logged in to Entire. This is the trail as it was read earlier.' });
    const status = root.querySelector<HTMLElement>('.refresh-status');
    expect(status?.hidden).toBe(false);
    expect(status?.textContent).toBe('You are not logged in to Entire. This is the trail as it was read earlier.');
    expect(texts(root, '.event-text')).toEqual(['Add the parser']);
  });

  it('shows a caveat that comes with the trail, and nothing when there is none', () => {
    const { root, app } = mount();
    show(app, { notice: XSS });
    expect(root.querySelector('.refresh-status')?.textContent).toBe(XSS);
    expect(root.querySelector('img')).toBeNull();
    show(app);
    expect(root.querySelector<HTMLElement>('.refresh-status')?.hidden).toBe(true);
  });

  it('ignores the end of a check when no trail is shown', () => {
    const { root, app } = mount();
    app.handle({ type: 'refreshed', notice: 'Late' });
    expect(root.textContent).not.toContain('Late');
    show(app, { refreshing: true });
    app.handle({ type: 'loading', title: 'Loading' });
    app.handle({ type: 'refreshed', notice: 'Late' });
    expect(root.textContent).toBe('Loading…');
  });

  describe('the reader\'s place', () => {
    let scrolled: [number, number][];
    /** What `window.scrollY` reports, one value per read. The last one repeats. */
    let tops: number[];
    const scrollTo = window.scrollTo;

    beforeEach(() => {
      scrolled = [];
      tops = [0];
      Object.defineProperty(window, 'scrollY', {
        configurable: true,
        get: () => (tops.length > 1 ? tops.shift() : tops[0]),
      });
      window.scrollTo = ((x: number, y: number) => {
        scrolled.push([x, y]);
      }) as typeof window.scrollTo;
    });

    afterEach(() => {
      window.scrollTo = scrollTo;
      Object.defineProperty(window, 'scrollY', { configurable: true, value: 0 });
    });

    it('is put back when drawing the same trail again moved it', () => {
      const { app } = mount();
      send(app, withoutTimeline({ timelinePending: true }));
      // The reader is 480 pixels down, and the redraw leaves the page at its top.
      tops = [480, 0];
      show(app);
      expect(scrolled).toEqual([[0, 480]]);
    });

    it('is left alone when drawing the same trail again did not move it', () => {
      const { app } = mount();
      send(app, withoutTimeline({ timelinePending: true }));
      tops = [480];
      show(app);
      expect(scrolled).toEqual([]);
    });

    it('goes to the top for another trail, and for a trail drawn after the loading text', () => {
      const { app } = mount();
      show(app);
      tops = [480];
      show(app, { number: 43 });
      expect(scrolled).toEqual([[0, 0]]);
      app.handle({ type: 'loading', title: 'Loading' });
      show(app, { number: 43 });
      expect(scrolled).toEqual([
        [0, 0],
        [0, 0],
      ]);
    });
  });
});
