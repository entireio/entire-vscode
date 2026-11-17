// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type DetailTarget,
  type PanelHeader,
  type TranscriptInfo,
  type WebviewMessage,
  type WireBlock,
  type WireTurn,
} from '../../src/shared/protocol';
import { createApp, type App, type VsCodeApi } from '../../src/webview/app';

const CHECKPOINT = '01HZXK3M5N7P9R2T4V6W8Y0A1B';
const RESTORE: DetailTarget = { repoRoot: '/repo', mode: 'checkpoint', checkpointId: CHECKPOINT };
const XSS = '<img src=x onerror=alert(1)>';

interface Harness {
  root: HTMLElement;
  app: App;
  posted: WebviewMessage[];
  savedState(): unknown;
}

/** Mounts the app on a fresh root with a fake VS Code API that records what is posted. */
function mount(): Harness {
  const root = document.createElement('div');
  document.body.append(root);
  const posted: WebviewMessage[] = [];
  let saved: unknown;
  const api: VsCodeApi = {
    postMessage: (message) => {
      posted.push(message);
    },
    setState: (state) => {
      saved = state;
    },
    getState: () => saved,
  };
  return { root, app: createApp(root, api), posted, savedState: () => saved };
}

function header(overrides: Partial<PanelHeader> = {}): PanelHeader {
  return {
    mode: 'checkpoint',
    title: 'Tidy the changelog',
    otherCommits: 0,
    sessions: [{ index: 0, sessionId: 'session-one', agent: 'Claude Code' }],
    selected: 0,
    files: [],
    canOpenOnWeb: false,
    canShowCommitDiff: false,
    canOpenRaw: false,
    ...overrides,
  };
}

interface InitOptions {
  header?: Partial<PanelHeader>;
  total?: number;
  start?: number;
  notice?: string;
}

function init(app: App, options: InitOptions = {}): void {
  const transcript: TranscriptInfo = { source: 'compact', total: options.total ?? 0, start: options.start ?? 0 };
  if (options.notice) transcript.notice = options.notice;
  app.handle({ type: 'init', protocol: PROTOCOL_VERSION, header: header(options.header), transcript, restore: RESTORE });
}

const text = (value: string): WireBlock => ({ kind: 'text', text: value });
const tool = (block: number, name: string, extra: Partial<Extract<WireBlock, { kind: 'tool' }>> = {}): WireBlock => ({
  kind: 'tool',
  block,
  name,
  summary: `${name} summary`,
  hasBody: true,
  ...extra,
});
const userTurn = (index: number, ...blocks: WireBlock[]): WireTurn => ({ index, role: 'user', blocks });
const assistantTurn = (index: number, ...blocks: WireBlock[]): WireTurn => ({ index, role: 'assistant', blocks });

/** Sends `init` and then the turns in batches, the way the host does. */
function load(app: App, turns: WireTurn[], options: InitOptions = {}, batch = 100): void {
  init(app, { ...options, total: turns.length });
  if (turns.length === 0) {
    app.handle({ type: 'turns', turns: [], done: true });
    return;
  }
  for (let from = 0; from < turns.length; from += batch) {
    app.handle({ type: 'turns', turns: turns.slice(from, from + batch), done: from + batch >= turns.length });
  }
}

/** A conversation where turn `n` says "turn n". Even turns are the user's. */
function conversation(count: number): WireTurn[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0 ? userTurn(index, text(`turn ${index}`)) : assistantTurn(index, text(`turn ${index}`)),
  );
}

const turnElements = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('article')];
/** The numbers of the rendered turns of a `conversation`, in document order. */
const renderedTurns = (root: HTMLElement): number[] =>
  turnElements(root).map((element) => Number(/turn (\d+)/.exec(element.textContent ?? '')?.[1]));

function buttonWithText(root: ParentNode, pattern: RegExp): HTMLButtonElement | undefined {
  return [...root.querySelectorAll('button')].find((button) => pattern.test(button.textContent ?? ''));
}

function click(element: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true });
  element.dispatchEvent(event);
  return event;
}

const detailsInTurns = (scope: ParentNode): HTMLDetailsElement[] =>
  [...scope.querySelectorAll<HTMLDetailsElement>('details')].filter((details) => details.closest('article') !== null);
/** Tool calls that can be expanded: `details` inside a turn that hold no other `details`. */
const expandableTools = (scope: ParentNode): HTMLDetailsElement[] =>
  detailsInTurns(scope).filter((details) => details.querySelector('details') === null);
/** Groups of tool calls: `details` inside a turn that hold other tool calls. */
const toolGroups = (scope: ParentNode): HTMLDetailsElement[] =>
  detailsInTurns(scope).filter((details) => details.querySelector('details') !== null);
const summaryOf = (details: Element): string => details.querySelector('summary')?.textContent ?? '';

/** Opens a `details` element the way a click on its summary does. */
function expand(details: HTMLDetailsElement, posted: WebviewMessage[]): void {
  const before = posted.length;
  details.open = true;
  // A browser fires `toggle` as a task. Fire it by hand where the DOM did not.
  if (posted.length === before) details.dispatchEvent(new Event('toggle'));
}

const toolBodyRequests = (posted: WebviewMessage[]): Extract<WebviewMessage, { type: 'requestToolBody' }>[] =>
  posted.flatMap((message) => (message.type === 'requestToolBody' ? [message] : []));

/** An IntersectionObserver that reports an element as visible only when the test says so. */
class ManualObserver {
  static latest: ManualObserver | undefined;
  readonly observed = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {
    ManualObserver.latest = this;
  }

  observe(element: Element): void {
    this.observed.add(element);
  }

  unobserve(element: Element): void {
    this.observed.delete(element);
  }

  disconnect(): void {
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Scrolls every observed element into view. */
  revealAll(): void {
    const entries = [...this.observed].map((target) => ({ target, isIntersecting: true }) as IntersectionObserverEntry);
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

beforeEach(() => {
  // With no IntersectionObserver the app renders Markdown at once, which most tests want.
  vi.stubGlobal('IntersectionObserver', undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  ManualObserver.latest = undefined;
  document.body.replaceChildren();
});

describe('start', () => {
  it('posts ready with the protocol version', () => {
    const { app, posted } = mount();
    expect(posted).toEqual([]);
    app.start();
    expect(posted).toEqual([{ type: 'ready', protocol: PROTOCOL_VERSION }]);
  });

  it('shows a loading status until the host answers', () => {
    const { app, root } = mount();
    app.start();
    expect(root.textContent).toContain('Loading');
    expect(buttonWithText(root, /Retry/)).toBeUndefined();
    expect(turnElements(root)).toEqual([]);
  });
});

describe('status messages', () => {
  it('shows a loading message in place of the previous content', () => {
    const { app, root } = mount();
    load(app, conversation(4));
    app.handle({ type: 'loading', title: 'Loading' });
    expect(turnElements(root)).toEqual([]);
    expect(root.textContent).toContain('Loading');
    expect(root.textContent).not.toContain('Tidy the changelog');
  });

  it('shows an error with a Retry button that posts retry', () => {
    const { app, root, posted } = mount();
    app.start();
    app.handle({ type: 'error', message: 'The Entire CLI took too long to read the checkpoint.', canRetry: true });

    expect(root.textContent).toContain('The Entire CLI took too long to read the checkpoint.');
    const retry = buttonWithText(root, /^Retry$/);
    expect(retry).toBeDefined();
    if (retry) click(retry);
    expect(posted.at(-1)).toEqual({ type: 'retry' });
    expect(posted.filter((message) => message.type === 'retry')).toHaveLength(1);
  });

  it('shows no Retry button for an error that cannot be retried', () => {
    const { app, root, posted } = mount();
    app.handle({ type: 'error', message: 'The repository for this tab is not open in this window.', canRetry: false });
    expect(root.textContent).toContain('The repository for this tab is not open in this window.');
    expect(root.querySelector('button')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('shows the error text as text, not as markup', () => {
    const { app, root } = mount();
    app.handle({ type: 'error', message: `Failed: ${XSS}`, canRetry: true });
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain(XSS);
  });

  it('replaces the content that was shown before the error', () => {
    const { app, root } = mount();
    load(app, conversation(4));
    app.handle({ type: 'error', message: 'Something failed.', canRetry: true });
    expect(turnElements(root)).toEqual([]);
    expect(root.querySelector('h1')).toBeNull();
  });

  it('ignores turns that arrive after an error', () => {
    const { app, root } = mount();
    init(app, { total: 2 });
    app.handle({ type: 'error', message: 'Something failed.', canRetry: false });
    expect(() => app.handle({ type: 'turns', turns: conversation(2), done: true })).not.toThrow();
    expect(turnElements(root)).toEqual([]);
    expect(root.textContent).toContain('Something failed.');
  });

  it('ignores turns that arrive before any init', () => {
    const { app, root } = mount();
    expect(() => app.handle({ type: 'turns', turns: conversation(2), done: true })).not.toThrow();
    expect(turnElements(root)).toEqual([]);
  });

  it('shows the panel again when an init follows an error', () => {
    const { app, root } = mount();
    app.handle({ type: 'error', message: 'Something failed.', canRetry: true });
    load(app, conversation(2));
    expect(root.textContent).not.toContain('Something failed.');
    expect(buttonWithText(root, /^Retry$/)).toBeUndefined();
    expect(renderedTurns(root)).toEqual([0, 1]);
  });
});

describe('init', () => {
  it('hands the restore target to the webview state', () => {
    const { app, savedState } = mount();
    init(app);
    expect(savedState()).toEqual(RESTORE);
  });

  it('shows the title as a heading, as text', () => {
    const { app, root } = mount();
    init(app, { header: { title: `Fix ${XSS} in the parser` } });
    expect(root.querySelector('h1')?.textContent).toBe(`Fix ${XSS} in the parser`);
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows the commit, and copies its SHA on request', () => {
    const { app, root, posted } = mount();
    init(app, {
      header: {
        commit: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Drop the entry', author: 'Ada Lovelace', date: '2026-03-04T12:20:14Z' },
        branch: 'feature/changelog',
        otherCommits: 2,
      },
    });
    expect(root.textContent).toContain('Ada Lovelace');
    expect(root.textContent).toContain('feature/changelog');
    expect(root.textContent).toContain('2 other commits');
    const chip = buttonWithText(root, /^aaaaaaa$/);
    expect(chip).toBeDefined();
    if (chip) click(chip);
    expect(posted).toEqual([{ type: 'copy', target: 'commitSha' }]);
  });

  it('uses the singular for one other commit, and says nothing for none', () => {
    const one = mount();
    init(one.app, { header: { otherCommits: 1 } });
    expect(one.root.textContent).toContain('1 other commit');
    expect(one.root.textContent).not.toContain('1 other commits');

    const none = mount();
    init(none.app, { header: { otherCommits: 0 } });
    expect(none.root.textContent).not.toContain('other commit');
  });

  it('copies the checkpoint ID and the session ID on request', () => {
    const { app, root, posted } = mount();
    init(app, { header: { checkpointId: CHECKPOINT } });
    const checkpointChip = buttonWithText(root, new RegExp(`^${CHECKPOINT}$`));
    const sessionChip = buttonWithText(root, /^session-one$/);
    expect(checkpointChip).toBeDefined();
    expect(sessionChip).toBeDefined();
    if (checkpointChip) click(checkpointChip);
    if (sessionChip) click(sessionChip);
    expect(posted).toEqual([
      { type: 'copy', target: 'checkpointId' },
      { type: 'copy', target: 'sessionId' },
    ]);
  });

  it('shows the agent, model, and token count of the selected session', () => {
    const { app, root } = mount();
    init(app, {
      header: {
        sessions: [
          { index: 0, agent: 'Codex', model: 'gpt-x', tokens: 5 },
          { index: 1, agent: 'Claude Code', model: 'claude-fable-5', tokens: 12_400 },
        ],
        selected: 1,
      },
    });
    const headerText = root.querySelector('header')?.textContent ?? '';
    expect(headerText).toContain('Claude Code');
    expect(headerText).toContain('claude-fable-5');
    expect(headerText).toContain('12.4K tokens');
    expect(headerText).not.toContain('gpt-x');
  });

  it('shows only the actions that the host allows, and posts the matching message for each', () => {
    const none = mount();
    init(none.app);
    expect(buttonWithText(none.root, /entire\.com/)).toBeUndefined();
    expect(buttonWithText(none.root, /Commit Diff/)).toBeUndefined();
    expect(buttonWithText(none.root, /Raw Transcript/)).toBeUndefined();

    const all = mount();
    init(all.app, { header: { canOpenOnWeb: true, canShowCommitDiff: true, canOpenRaw: true } });
    for (const pattern of [/entire\.com/, /Commit Diff/, /Raw Transcript/]) {
      const action = buttonWithText(all.root, pattern);
      expect(action).toBeDefined();
      if (action) click(action);
    }
    expect(all.posted).toEqual([{ type: 'openOnWeb' }, { type: 'showCommitDiff' }, { type: 'openRawTranscript' }]);
  });

  it('lists the files and posts openFile with the position of the one clicked', () => {
    const { app, root, posted } = mount();
    init(app, {
      header: {
        files: [{ path: 'CHANGELOG.md', status: 'M' }, { path: 'docs/guide.md' }, { path: `src/${XSS}.ts`, status: 'A' }],
      },
    });
    expect(root.textContent).toContain('Files (3)');
    expect(root.querySelector('img')).toBeNull();
    const second = buttonWithText(root, /^docs\/guide\.md$/);
    const third = buttonWithText(root, /^src\/.*\.ts$/);
    expect(second).toBeDefined();
    expect(third).toBeDefined();
    if (third) click(third);
    if (second) click(second);
    expect(posted).toEqual([
      { type: 'openFile', index: 2 },
      { type: 'openFile', index: 1 },
    ]);
  });

  it('shows the notices from the header and from the transcript', () => {
    const { app, root } = mount();
    init(app, {
      header: { notice: 'The Entire CLI could read only part of this checkpoint.' },
      notice: 'Text view from the Entire CLI.',
    });
    expect(root.textContent).toContain('The Entire CLI could read only part of this checkpoint.');
    expect(root.textContent).toContain('Text view from the Entire CLI.');
  });

  it('shows the summary of the selected session', () => {
    const { app, root } = mount();
    init(app, {
      header: {
        sessions: [
          { index: 0, intent: 'Intent of the first session', outcome: 'Outcome of the first session' },
          { index: 1, intent: 'Drop the stale entry', outcome: `Dropped ${XSS}` },
        ],
        selected: 1,
      },
    });
    expect(root.textContent).toContain('Drop the stale entry');
    expect(root.textContent).toContain(`Dropped ${XSS}`);
    expect(root.textContent).not.toContain('Intent of the first session');
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows the facts of a local session that has no checkpoint yet', () => {
    const { app, root } = mount();
    init(app, {
      header: {
        mode: 'session',
        title: 'Agent session',
        sessions: [],
        localSession: { sessionId: 'local-session', status: 'active', agent: 'Codex', turns: 7, pendingTurns: 3, tokens: 2500 },
      },
      notice: 'This session has no checkpoint yet.',
    });
    app.handle({ type: 'turns', turns: [], done: true });
    const all = root.textContent ?? '';
    for (const fact of ['Codex', 'active', '7 turns', '3 not in a checkpoint yet', '2.5K tokens', 'This session has no checkpoint yet.']) {
      expect(all).toContain(fact);
    }
    expect(buttonWithText(root, /^local-session$/)).toBeDefined();
    expect(all).not.toContain('This transcript is empty.');
  });
});

describe('place in the session', () => {
  const place = (root: HTMLElement): HTMLElement | null => root.querySelector<HTMLElement>('.place');
  const step = (root: HTMLElement, label: RegExp): HTMLButtonElement | undefined =>
    buttonWithText(place(root) ?? root.ownerDocument.createElement('div'), label);
  const position = { ordinal: 12, total: 249, mayHaveEarlier: false, hasPrevious: true, hasNext: true };

  it('says which checkpoint of the session this is', () => {
    const { app, root } = mount();
    init(app, { header: { position } });
    expect(place(root)?.textContent).toContain('Checkpoint 12 of 249 in this session');
  });

  it('shows nothing when the place is not known', () => {
    const { app, root } = mount();
    init(app);
    expect(place(root)).toBeNull();
    expect(root.textContent).not.toMatch(/in this session/);
  });

  it('posts the direction, and nothing else, when a step button is clicked', () => {
    const { app, root, posted } = mount();
    init(app, { header: { position } });
    posted.length = 0;
    click(step(root, /^Previous$/) as HTMLButtonElement);
    click(step(root, /^Next$/) as HTMLButtonElement);
    expect(posted).toEqual([
      { type: 'stepSession', direction: 'previous' },
      { type: 'stepSession', direction: 'next' },
    ]);
  });

  it('disables the step that has nowhere to go', () => {
    const first = mount();
    init(first.app, { header: { position: { ...position, ordinal: 1, hasPrevious: false } } });
    expect(step(first.root, /^Previous$/)?.disabled).toBe(true);
    expect(step(first.root, /^Next$/)?.disabled).toBe(false);
    first.posted.length = 0;
    step(first.root, /^Previous$/)?.click();
    expect(first.posted).toEqual([]);

    const last = mount();
    init(last.app, { header: { position: { ...position, ordinal: 249, hasNext: false } } });
    expect(step(last.root, /^Previous$/)?.disabled).toBe(false);
    expect(step(last.root, /^Next$/)?.disabled).toBe(true);
  });

  it('shows no step buttons for the only checkpoint of a session', () => {
    const { app, root } = mount();
    init(app, { header: { position: { ordinal: 1, total: 1, mayHaveEarlier: false, hasPrevious: false, hasNext: false } } });
    expect(place(root)?.textContent).toContain('Checkpoint 1 of 1 in this session');
    expect(place(root)?.querySelectorAll('button')).toHaveLength(0);
  });

  it('marks a count that may be too low and says why', () => {
    const { app, root } = mount();
    init(app, { header: { position: { ...position, ordinal: 1, mayHaveEarlier: true, hasPrevious: false } } });
    expect(place(root)?.textContent).toContain('Checkpoint 1 of 249+ in this session');
    expect(place(root)?.querySelector('span')?.title).toMatch(/may have earlier ones/);
    // The first listed checkpoint may not be the session's first, and the button says so.
    expect(step(root, /^Previous$/)?.title).toMatch(/not listed/);
  });

  it('names the step buttons for a screen reader', () => {
    const { app, root } = mount();
    init(app, { header: { position } });
    expect(step(root, /^Previous$/)?.getAttribute('aria-label')).toBe('Previous checkpoint in this session');
    expect(step(root, /^Next$/)?.getAttribute('aria-label')).toBe('Next checkpoint in this session');
  });
});

describe('session tabs', () => {
  const sessions = [
    { index: 0, sessionId: 's0', agent: 'Claude Code', model: 'claude-fable-5' },
    { index: 1, sessionId: 's1', agent: 'Codex' },
    { index: 2, sessionId: 's2' },
  ];
  const tabs = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('[role="tab"]')];

  it('shows one tab per session and marks the selected one', () => {
    const { app, root } = mount();
    init(app, { header: { sessions, selected: 1 } });
    expect(root.querySelector('[role="tablist"]')).not.toBeNull();
    expect(tabs(root).map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs(root)[0]?.textContent).toContain('Claude Code');
    expect(tabs(root)[0]?.textContent).toContain('claude-fable-5');
    expect(tabs(root)[1]?.textContent).toContain('Codex');
    expect(tabs(root)[2]?.textContent).toContain('3');
  });

  it('posts selectSession with the position of the tab that was clicked', () => {
    const { app, root, posted } = mount();
    init(app, { header: { sessions, selected: 1 } });
    const [first, , third] = tabs(root);
    if (third) click(third);
    if (first) click(first);
    expect(posted).toEqual([
      { type: 'selectSession', position: 2 },
      { type: 'selectSession', position: 0 },
    ]);
  });

  it('posts nothing when the selected tab is clicked', () => {
    const { app, root, posted } = mount();
    init(app, { header: { sessions, selected: 1 } });
    const selected = tabs(root)[1];
    if (selected) click(selected);
    expect(posted).toEqual([]);
  });

  it('shows no tabs for a checkpoint with one session', () => {
    const { app, root } = mount();
    init(app);
    expect(tabs(root)).toEqual([]);
    expect(root.querySelector('[role="tablist"]')).toBeNull();
  });

  const press = (element: Element, key: string): KeyboardEvent => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event;
  };
  const focusedTab = (root: HTMLElement): number => tabs(root).indexOf(document.activeElement as HTMLElement);

  it('moves the focus to the next tab on the right arrow key, and wraps at the end', () => {
    const { app, root } = mount();
    init(app, { header: { sessions, selected: 0 } });
    tabs(root)[0]?.focus();
    expect(focusedTab(root)).toBe(0);

    const first = press(document.activeElement as Element, 'ArrowRight');
    expect(focusedTab(root)).toBe(1);
    expect(first.defaultPrevented).toBe(true);
    press(document.activeElement as Element, 'ArrowRight');
    expect(focusedTab(root)).toBe(2);
    press(document.activeElement as Element, 'ArrowRight');
    expect(focusedTab(root)).toBe(0);
  });

  it('moves the focus to the previous tab on the left arrow key, and wraps at the start', () => {
    const { app, root } = mount();
    init(app, { header: { sessions, selected: 0 } });
    tabs(root)[1]?.focus();

    press(document.activeElement as Element, 'ArrowLeft');
    expect(focusedTab(root)).toBe(0);
    const wrap = press(document.activeElement as Element, 'ArrowLeft');
    expect(focusedTab(root)).toBe(2);
    expect(wrap.defaultPrevented).toBe(true);
  });

  it('only moves the focus: the session changes when the focused tab is activated', () => {
    const { app, root, posted } = mount();
    init(app, { header: { sessions, selected: 0 } });
    tabs(root)[0]?.focus();
    press(document.activeElement as Element, 'ArrowRight');
    press(document.activeElement as Element, 'ArrowRight');
    expect(posted).toEqual([]);
    expect(tabs(root).map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);

    click(document.activeElement as Element);
    expect(posted).toEqual([{ type: 'selectSession', position: 2 }]);
  });

  it.each(['ArrowDown', 'ArrowUp', 'Tab', 'a', ' ', 'Escape'])('leaves the key %j alone', (key) => {
    const { app, root } = mount();
    init(app, { header: { sessions, selected: 0 } });
    tabs(root)[1]?.focus();
    const event = press(document.activeElement as Element, key);
    expect(focusedTab(root)).toBe(1);
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores arrow keys pressed outside the tab list', () => {
    const { app, root, posted } = mount();
    init(app, { header: { sessions, selected: 0, checkpointId: CHECKPOINT } });
    const chip = buttonWithText(root, new RegExp(`^${CHECKPOINT}$`));
    chip?.focus();
    const event = chip ? press(chip, 'ArrowRight') : undefined;
    expect(document.activeElement).toBe(chip);
    expect(event?.defaultPrevented).toBe(false);
    expect(posted).toEqual([]);
  });
});

describe('turns', () => {
  it('renders the turns in order, labelled by who spoke', () => {
    const { app, root } = mount();
    load(app, [userTurn(0, text('What changed?')), assistantTurn(1, text('The changelog.')), userTurn(2, text('Thanks'))]);

    const turns = turnElements(root);
    expect(turns).toHaveLength(3);
    expect(turns[0]?.textContent).toContain('User');
    expect(turns[0]?.textContent).toContain('What changed?');
    expect(turns[1]?.textContent).toContain('Claude Code');
    expect(turns[1]?.textContent).toContain('The changelog.');
    expect(turns[2]?.textContent).toContain('Thanks');
  });

  it('labels assistant turns "Assistant" when the agent is not known', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text('Hello'))], { header: { sessions: [{ index: 0 }] } });
    expect(turnElements(root)[0]?.textContent).toContain('Assistant');
  });

  describe('who sent a prompt', () => {
    const roles = (root: HTMLElement): string[] =>
      [...root.querySelectorAll('article .turn-head .role')].map((label) => label.textContent ?? '');

    it('names the person the host gives, on every prompt', () => {
      const { app, root } = mount();
      load(app, [userTurn(0, text('What changed?')), assistantTurn(1, text('The changelog.')), userTurn(2, text('Thanks'))], {
        header: { promptAuthor: 'Ada Lovelace' },
      });
      expect(roles(root)).toEqual(['Ada Lovelace', 'Claude Code', 'Ada Lovelace']);
    });

    it('says "User", and never "You", while the host has no name: the reader may not be the sender', () => {
      const { app, root } = mount();
      load(app, [userTurn(0, text('What changed?')), assistantTurn(1, text('The changelog.'))]);
      expect(roles(root)).toEqual(['User', 'Claude Code']);
      expect(root.textContent).not.toMatch(/\bYou\b/);
    });

    it('puts a name that arrives later on the prompts already drawn, and on the ones drawn after it', () => {
      const { app, root } = mount();
      init(app, { total: 4 });
      app.handle({ type: 'turns', turns: [userTurn(0, text('One')), assistantTurn(1, text('Two'))], done: false });
      expect(roles(root)).toEqual(['User', 'Claude Code']);

      app.handle({ type: 'promptAuthor', name: 'Ada Lovelace' });
      expect(roles(root)).toEqual(['Ada Lovelace', 'Claude Code']);

      app.handle({ type: 'turns', turns: [userTurn(2, text('Three')), assistantTurn(3, text('Four'))], done: true });
      expect(roles(root)).toEqual(['Ada Lovelace', 'Claude Code', 'Ada Lovelace', 'Claude Code']);
    });

    it('names the sender on earlier messages when they are shown', () => {
      const { app, root } = mount();
      load(app, conversation(6), { start: 4 });
      app.handle({ type: 'promptAuthor', name: 'Ada Lovelace' });
      buttonWithText(root, /^Show Earlier Messages/)?.click();
      const prompts = turnElements(root).filter((turn) => turn.classList.contains('user'));
      expect(prompts.length).toBeGreaterThan(1);
      for (const prompt of prompts) expect(prompt.querySelector('.role')?.textContent).toBe('Ada Lovelace');
    });

    it('draws the name as text, never as markup', () => {
      const { app, root } = mount();
      load(app, [userTurn(0, text('Hello'))], { header: { promptAuthor: XSS } });
      app.handle({ type: 'promptAuthor', name: `${XSS}!` });
      expect(roles(root)).toEqual([`${XSS}!`]);
      expect(root.querySelector('img')).toBeNull();
    });

    it('does not carry a name over to the next checkpoint the tab shows', () => {
      const { app, root } = mount();
      load(app, [userTurn(0, text('Hello'))]);
      app.handle({ type: 'promptAuthor', name: 'Ada Lovelace' });
      load(app, [userTurn(0, text('Hello again'))]);
      expect(roles(root)).toEqual(['User']);
    });

    it('ignores a name that arrives when no transcript is shown', () => {
      const { app, root } = mount();
      app.handle({ type: 'promptAuthor', name: 'Ada Lovelace' });
      app.handle({ type: 'error', message: 'The Entire CLI could not read the checkpoint.', canRetry: true });
      app.handle({ type: 'promptAuthor', name: 'Ada Lovelace' });
      expect(root.textContent).not.toContain('Ada Lovelace');
      load(app, [userTurn(0, text('Hello'))]);
      expect(roles(root)).toEqual(['User']);
    });
  });

  it('labels assistant turns with the agent of the selected session', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text('Hello'))], {
      header: { sessions: [{ index: 0, agent: 'Claude Code' }, { index: 1, agent: 'Codex' }], selected: 1 },
    });
    expect(turnElements(root)[0]?.textContent).toContain('Codex');
    expect(turnElements(root)[0]?.textContent).not.toContain('Claude Code');
  });

  it('shows user text exactly as written, with no Markdown or HTML applied', () => {
    const { app, root } = mount();
    const prompt = `Make **this** bold and load ${XSS} and [a link](https://example.com)`;
    load(app, [userTurn(0, text(prompt))]);
    const turn = turnElements(root)[0];
    expect(turn?.textContent).toContain(prompt);
    expect(turn?.querySelector('strong, img, a')).toBeNull();
  });

  it('renders assistant text as Markdown, with raw HTML shown as text', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text(`The **fix** is in \`parser.ts\`.\n\n${XSS}`))]);
    const turn = turnElements(root)[0];
    expect(turn?.querySelector('strong')?.textContent).toBe('fix');
    expect(turn?.querySelector('code')?.textContent).toBe('parser.ts');
    expect(turn?.querySelector('img')).toBeNull();
    expect(turn?.textContent).toContain(XSS);
  });

  it('adds turns that arrive in several messages, keeping their order', () => {
    const { app, root } = mount();
    const turns = conversation(7);
    init(app, { total: 7 });
    app.handle({ type: 'turns', turns: turns.slice(0, 3), done: false });
    expect(renderedTurns(root)).toEqual([0, 1, 2]);
    app.handle({ type: 'turns', turns: turns.slice(3, 5), done: false });
    app.handle({ type: 'turns', turns: turns.slice(5), done: true });
    expect(renderedTurns(root)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('shows a note block as text', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text('Before'), { kind: 'note', text: `Unsupported block: ${XSS}` }, text('After'))]);
    expect(turnElements(root)[0]?.textContent).toContain(`Unsupported block: ${XSS}`);
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows the time of a turn that has one', () => {
    const { app, root } = mount();
    load(app, [{ index: 0, role: 'user', ts: '2026-01-02T03:04:05Z', blocks: [text('Hello')] }, userTurn(1, text('No time'))]);
    const times = [...root.querySelectorAll('time')];
    expect(times).toHaveLength(1);
    expect(times[0]?.getAttribute('datetime')).toBe('2026-01-02T03:04:05Z');
    expect(times[0]?.textContent).not.toBe('');
  });

  it('says so when the transcript is empty', () => {
    const { app, root } = mount();
    load(app, []);
    expect(root.textContent).toContain('This transcript is empty.');
  });

  it('shows the notice instead when there is a reason for the missing transcript', () => {
    const { app, root } = mount();
    load(app, [], { notice: 'No transcript preview is available for this session.' });
    expect(root.textContent).toContain('No transcript preview is available for this session.');
    expect(root.textContent).not.toContain('This transcript is empty.');
  });

  it('starts over when a new init arrives', () => {
    const { app, root } = mount();
    load(app, conversation(4));
    load(app, [userTurn(0, text('turn 100'))], { header: { title: 'Another checkpoint' } });
    expect(renderedTurns(root)).toEqual([100]);
    expect(root.querySelector('h1')?.textContent).toBe('Another checkpoint');
    expect(root.querySelectorAll('h1')).toHaveLength(1);
  });

  it('lets a long prompt be expanded and collapsed again', () => {
    const { app, root } = mount();
    const longPrompt = Array.from({ length: 60 }, (_, n) => `line ${n} of a long pasted prompt`).join('\n');
    load(app, [userTurn(0, text(longPrompt)), userTurn(1, text('short'))]);

    const [long, short] = turnElements(root);
    expect(long?.textContent).toContain('line 59 of a long pasted prompt');
    expect(short && buttonWithText(short, /Show (More|Less)/)).toBeUndefined();
    const more = long && buttonWithText(long, /^Show More$/);
    expect(more).toBeDefined();
    if (more) click(more);
    expect(more?.textContent).toBe('Show Less');
    if (more) click(more);
    expect(more?.textContent).toBe('Show More');
  });
});

describe('earlier messages', () => {
  const earlierButton = (root: HTMLElement): HTMLButtonElement | undefined => buttonWithText(root, /Show Earlier Messages/);
  const isOffered = (root: HTMLElement): boolean => {
    const button = earlierButton(root);
    return button !== undefined && !button.hidden;
  };

  it('does not render the turns before transcript.start', () => {
    const { app, root } = mount();
    load(app, conversation(6), { start: 4 });
    expect(renderedTurns(root)).toEqual([4, 5]);
    expect(root.textContent).not.toContain('turn 3');
    expect(isOffered(root)).toBe(true);
    expect(earlierButton(root)?.textContent).toContain('4');
  });

  it('renders them, in order, when Show Earlier Messages is clicked', () => {
    const { app, root } = mount();
    load(app, conversation(6), { start: 4 });
    const button = earlierButton(root);
    expect(button).toBeDefined();
    if (button) click(button);
    expect(renderedTurns(root)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(isOffered(root)).toBe(false);
  });

  it('holds back earlier turns that arrive in a later message than the first', () => {
    const { app, root } = mount();
    const turns = conversation(250);
    load(app, turns, { start: 180 });
    expect(renderedTurns(root)).toEqual(turns.slice(180).map((turn) => turn.index));
  });

  it('reveals a long history a page at a time, always in order, until none is left', () => {
    const { app, root } = mount();
    load(app, conversation(200), { start: 150 });

    let first = 150;
    for (let clicks = 0; clicks < 200 && isOffered(root); clicks += 1) {
      const button = earlierButton(root);
      // The button says how many earlier messages are still hidden.
      expect(button?.textContent).toContain(String(first));
      if (button) click(button);
      const rendered = renderedTurns(root);
      expect(rendered[0]).toBeLessThan(first);
      first = rendered[0] ?? -1;
      expect(rendered).toEqual(Array.from({ length: 200 - first }, (_, n) => first + n));
    }
    expect(first).toBe(0);
    expect(isOffered(root)).toBe(false);
    expect(turnElements(root)).toHaveLength(200);
  });

  it('does not offer earlier messages when the checkpoint starts at the first turn', () => {
    const { app, root } = mount();
    load(app, conversation(4), { start: 0 });
    expect(renderedTurns(root)).toEqual([0, 1, 2, 3]);
    expect(isOffered(root)).toBe(false);
  });

  it('offers every turn as earlier when the start is at or past the end', () => {
    const { app, root } = mount();
    load(app, conversation(3), { start: 99 });
    expect(renderedTurns(root)).toEqual([]);
    expect(isOffered(root)).toBe(true);
    const button = earlierButton(root);
    expect(button?.textContent).toContain('3');
    if (button) click(button);
    expect(renderedTurns(root)).toEqual([0, 1, 2]);
  });

  it('keeps earlier tool calls working after they are revealed', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('turn 0'), tool(1, 'Bash')), userTurn(1, text('turn 1'))], { start: 1 });
    expect(expandableTools(root)).toEqual([]);
    const button = earlierButton(root);
    if (button) click(button);
    const [bash] = expandableTools(root);
    expect(bash).toBeDefined();
    if (bash) expand(bash, posted);
    expect(toolBodyRequests(posted)).toMatchObject([{ turn: 0, block: 1 }]);
  });

  it('applies the start of the new transcript after a second init', () => {
    const { app, root } = mount();
    load(app, conversation(6), { start: 4 });
    load(app, conversation(6), { start: 2 });
    expect(renderedTurns(root)).toEqual([2, 3, 4, 5]);
    expect(root.querySelectorAll('button').length).toBeGreaterThan(0);
    expect([...root.querySelectorAll('button')].filter((button) => /Show Earlier Messages/.test(button.textContent ?? ''))).toHaveLength(1);
  });
});

describe('tool calls', () => {
  it('shows a single tool call by name and summary, without a group', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text('Checking.'), tool(1, 'Bash', { summary: 'List the changelog entries' }), text('Done.'))]);
    expect(toolGroups(root)).toEqual([]);
    const [bash] = expandableTools(root);
    expect(summaryOf(bash as Element)).toContain('Bash');
    expect(summaryOf(bash as Element)).toContain('List the changelog entries');
  });

  it('collapses consecutive tool calls into one group whose summary names the tools', () => {
    const { app, root } = mount();
    load(app, [
      assistantTurn(0, text('Looking around.'), tool(1, 'Bash'), tool(2, 'Read'), tool(3, 'Bash'), text('Found it.')),
    ]);

    const groups = toolGroups(root);
    expect(groups).toHaveLength(1);
    const summary = summaryOf(groups[0] as Element);
    expect(summary).toContain('3 tool calls');
    expect(summary).toContain('Bash');
    expect(summary).toContain('Read');
    // Each tool is named once, however often it was called.
    expect(summary.match(/Bash/g)).toHaveLength(1);
    expect(expandableTools(groups[0] as Element)).toHaveLength(3);
    expect(groups[0]?.open).toBe(false);
  });

  it('keeps tool calls that are separated by text in separate places', () => {
    const { app, root } = mount();
    load(app, [
      assistantTurn(0, tool(0, 'Bash'), tool(1, 'Read'), text('Now editing.'), tool(3, 'Edit'), text('Then two more.'), tool(5, 'Grep'), tool(6, 'Glob')),
    ]);
    const groups = toolGroups(root);
    expect(groups.map((group) => summaryOf(group))).toEqual([
      expect.stringContaining('2 tool calls'),
      expect.stringContaining('2 tool calls'),
    ]);
    expect(summaryOf(groups[0] as Element)).toMatch(/Bash.*Read/);
    expect(summaryOf(groups[1] as Element)).toMatch(/Grep.*Glob/);
    // Edit stands alone between the two groups.
    const standalone = expandableTools(root).filter((details) => !groups.some((group) => group.contains(details)));
    expect(standalone.map((details) => summaryOf(details))).toEqual([expect.stringContaining('Edit')]);
    const order = turnElements(root)[0]?.textContent ?? '';
    expect(order.indexOf('Now editing.')).toBeLessThan(order.indexOf('Edit summary'));
    expect(order.indexOf('Edit summary')).toBeLessThan(order.indexOf('Then two more.'));
  });

  it('does not group tool calls across turns', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash')), userTurn(1, text('go on')), assistantTurn(2, tool(0, 'Read'))]);
    expect(toolGroups(root)).toEqual([]);
    expect(expandableTools(root)).toHaveLength(2);
  });

  it('names the first few tools of a large group and counts the rest', () => {
    const { app, root } = mount();
    const names = ['Bash', 'Read', 'Edit', 'Grep', 'Glob', 'WebFetch'];
    load(app, [assistantTurn(0, ...names.map((name, position) => tool(position, name)))]);
    const summary = summaryOf(toolGroups(root)[0] as Element);
    expect(summary).toContain('6 tool calls');
    expect(summary).toContain('Bash');
    expect(summary).toMatch(/\+\s*\d+ more/);
    expect(summary).not.toContain('WebFetch');
  });

  it('says how many calls of a group failed', () => {
    const { app, root } = mount();
    load(app, [
      assistantTurn(0, tool(0, 'Bash', { status: 'error' }), tool(1, 'Read', { status: 'success' }), tool(2, 'Bash', { status: 'error' })),
    ]);
    expect(summaryOf(toolGroups(root)[0] as Element)).toContain('2 failed');
  });

  it('marks a single failed call', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash', { status: 'error' })), assistantTurn(1, tool(0, 'Read', { status: 'success' }))]);
    const [failed, succeeded] = expandableTools(root);
    expect(summaryOf(failed as Element)).toContain('Failed');
    expect(summaryOf(succeeded as Element)).not.toContain('Failed');
  });

  it('shows the tool name and summary as text, not as markup', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, tool(0, XSS, { summary: `cat ${XSS}` }), tool(1, `Second ${XSS}`))]);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain(`cat ${XSS}`);
  });

  it('shows a tool call with no body as a plain line that cannot be expanded', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'TodoWrite', { hasBody: false, summary: 'Update the task list' }))]);
    expect(turnElements(root)[0]?.textContent).toContain('TodoWrite');
    expect(turnElements(root)[0]?.textContent).toContain('Update the task list');
    expect(root.querySelector('article details')).toBeNull();
    expect(posted).toEqual([]);
  });
});

describe('tool bodies', () => {
  it('posts requestToolBody with the turn and block when a tool is expanded', () => {
    const { app, root, posted } = mount();
    load(app, [userTurn(0, text('go')), assistantTurn(1, text('Checking.'), tool(1, 'Bash'))]);
    expect(posted).toEqual([]);

    const [bash] = expandableTools(root);
    if (bash) expand(bash, posted);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ type: 'requestToolBody', turn: 1, block: 1 });
    expect(Number.isInteger(toolBodyRequests(posted)[0]?.requestId)).toBe(true);
    expect(bash?.textContent).toContain('Loading');
  });

  it('inserts the reply as text, not as markup', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const [bash] = expandableTools(root);
    if (bash) expand(bash, posted);
    const requestId = toolBodyRequests(posted)[0]?.requestId ?? -1;

    app.handle({
      type: 'toolBody',
      requestId,
      input: '{\n  "command": "cat page.html <script>alert(1)</script>"\n}',
      output: `${XSS}\n<iframe src="https://evil.example"></iframe>\n**not bold**`,
      truncated: false,
    });

    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('script')).toBeNull();
    expect(bash?.querySelector('strong')).toBeNull();
    const blocks = [...(bash?.querySelectorAll('pre') ?? [])].map((pre) => pre.textContent);
    expect(blocks).toEqual([
      '{\n  "command": "cat page.html <script>alert(1)</script>"\n}',
      `${XSS}\n<iframe src="https://evil.example"></iframe>\n**not bold**`,
    ]);
    expect(bash?.textContent).not.toContain('Loading');
    expect(bash?.textContent).toContain('Input');
    expect(bash?.textContent).toContain('Result');
  });

  it('asks only once, however often the tool is closed and opened again', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const [bash] = expandableTools(root);
    if (!bash) throw new Error('no tool');
    expand(bash, posted);
    const requestId = toolBodyRequests(posted)[0]?.requestId ?? -1;
    app.handle({ type: 'toolBody', requestId, input: 'ls', output: 'a.ts', truncated: false });

    bash.open = false;
    bash.dispatchEvent(new Event('toggle'));
    bash.open = true;
    bash.dispatchEvent(new Event('toggle'));
    expect(toolBodyRequests(posted)).toHaveLength(1);
    expect(bash.querySelector('pre')?.textContent).toBe('ls');
  });

  it('gives each request its own ID and puts each reply in the right tool', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'), text('and'), tool(2, 'Read')), assistantTurn(1, tool(0, 'Grep'))]);
    const [bash, read, grep] = expandableTools(root);
    if (!bash || !read || !grep) throw new Error('missing tools');
    expand(read, posted);
    expand(grep, posted);
    expand(bash, posted);

    const requests = toolBodyRequests(posted);
    expect(requests.map((request) => [request.turn, request.block])).toEqual([
      [0, 2],
      [1, 0],
      [0, 0],
    ]);
    expect(new Set(requests.map((request) => request.requestId)).size).toBe(3);

    // Answer out of order.
    app.handle({ type: 'toolBody', requestId: requests[2]?.requestId ?? -1, input: '', output: 'bash output', truncated: false });
    app.handle({ type: 'toolBody', requestId: requests[0]?.requestId ?? -1, input: '', output: 'read output', truncated: false });
    expect(bash.querySelector('pre')?.textContent).toBe('bash output');
    expect(read.querySelector('pre')?.textContent).toBe('read output');
    expect(grep.querySelector('pre')).toBeNull();
    expect(grep.textContent).toContain('Loading');
  });

  it('requests the right block for a tool inside a group', () => {
    const { app, root, posted } = mount();
    load(app, [userTurn(0, text('go')), assistantTurn(1, text('Looking.'), tool(1, 'Bash'), tool(2, 'Read'), tool(3, 'Grep'))]);
    const [group] = toolGroups(root);
    if (!group) throw new Error('no group');
    group.open = true;
    const read = expandableTools(group).find((details) => summaryOf(details).includes('Read'));
    if (read) expand(read, posted);
    expect(toolBodyRequests(posted)).toMatchObject([{ turn: 1, block: 2 }]);
  });

  it('does not ask for a body when a group is opened', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'), tool(1, 'Read'))]);
    const [group] = toolGroups(root);
    if (!group) throw new Error('no group');
    group.open = true;
    group.dispatchEvent(new Event('toggle'));
    expect(posted).toEqual([]);
  });

  it('offers to open a truncated body in an editor', () => {
    const { app, root, posted } = mount();
    load(app, [userTurn(0, text('go')), assistantTurn(1, text('x'), text('y'), tool(2, 'Bash'))]);
    const [bash] = expandableTools(root);
    if (bash) expand(bash, posted);
    const requestId = toolBodyRequests(posted)[0]?.requestId ?? -1;
    app.handle({ type: 'toolBody', requestId, input: 'cat big.log', output: 'first part', truncated: true });

    const open = bash && buttonWithText(bash, /Open in Editor/);
    expect(open).toBeDefined();
    if (open) click(open);
    expect(posted.at(-1)).toEqual({ type: 'openToolBody', turn: 1, block: 2 });
  });

  it('does not offer the editor for a complete body', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const [bash] = expandableTools(root);
    if (bash) expand(bash, posted);
    app.handle({ type: 'toolBody', requestId: toolBodyRequests(posted)[0]?.requestId ?? -1, input: 'ls', output: 'a.ts', truncated: false });
    expect(bash && buttonWithText(bash, /Open in Editor/)).toBeUndefined();
  });

  it('shows only the part that has content', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash')), assistantTurn(1, tool(0, 'Read')), assistantTurn(2, tool(0, 'Stop'))]);
    const [bash, read, stop] = expandableTools(root);
    if (!bash || !read || !stop) throw new Error('missing tools');
    for (const details of [bash, read, stop]) expand(details, posted);
    const [first, second, third] = toolBodyRequests(posted);

    app.handle({ type: 'toolBody', requestId: first?.requestId ?? -1, input: 'only input', output: '', truncated: false });
    app.handle({ type: 'toolBody', requestId: second?.requestId ?? -1, input: '', output: 'only output', truncated: false });
    app.handle({ type: 'toolBody', requestId: third?.requestId ?? -1, input: '', output: '', truncated: false });

    expect([...bash.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual(['only input']);
    expect(bash.textContent).not.toContain('Result');
    expect([...read.querySelectorAll('pre')].map((pre) => pre.textContent)).toEqual(['only output']);
    expect(read.textContent).not.toContain('Input');
    expect(stop.querySelector('pre')).toBeNull();
    expect(stop.textContent).toContain('Nothing was recorded');
  });

  it('ignores a reply that nobody asked for', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const before = root.innerHTML;
    expect(() => app.handle({ type: 'toolBody', requestId: 999, input: 'x', output: XSS, truncated: true })).not.toThrow();
    expect(root.innerHTML).toBe(before);
    expect(posted).toEqual([]);
  });

  it('ignores a second reply to the same request', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const [bash] = expandableTools(root);
    if (bash) expand(bash, posted);
    const requestId = toolBodyRequests(posted)[0]?.requestId ?? -1;
    app.handle({ type: 'toolBody', requestId, input: 'first', output: '', truncated: false });
    app.handle({ type: 'toolBody', requestId, input: 'second', output: '', truncated: false });
    expect(bash?.querySelector('pre')?.textContent).toBe('first');
  });

  it('ignores a reply to a request made before the panel was pointed at something else', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, tool(0, 'Bash'))]);
    const [oldTool] = expandableTools(root);
    if (oldTool) expand(oldTool, posted);
    const staleId = toolBodyRequests(posted)[0]?.requestId ?? -1;

    load(app, [assistantTurn(0, tool(0, 'Read'))]);
    const [newTool] = expandableTools(root);
    expect(() => app.handle({ type: 'toolBody', requestId: staleId, input: 'stale', output: 'stale', truncated: false })).not.toThrow();
    expect(root.textContent).not.toContain('stale');

    if (newTool) expand(newTool, posted);
    const freshId = toolBodyRequests(posted)[1]?.requestId ?? -1;
    expect(freshId).not.toBe(staleId);
    app.handle({ type: 'toolBody', requestId: freshId, input: 'fresh', output: '', truncated: false });
    expect(newTool?.querySelector('pre')?.textContent).toBe('fresh');
  });
});

describe('links', () => {
  it('posts openLink for a click on a link in rendered Markdown, and does not navigate', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('Read the [documentation](https://example.com/docs?page=2#install) first.'))]);
    const anchor = root.querySelector('a');
    expect(anchor?.textContent).toBe('documentation');
    const before = window.location.href;

    const event = anchor ? click(anchor) : undefined;

    expect(posted).toEqual([{ type: 'openLink', href: 'https://example.com/docs?page=2#install' }]);
    expect(event?.defaultPrevented).toBe(true);
    expect(window.location.href).toBe(before);
  });

  it('handles a click on an element inside the link', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('See [the **bold** guide](https://example.com/guide).'))]);
    const inner = root.querySelector('a strong');
    expect(inner).not.toBeNull();
    const event = inner ? click(inner) : undefined;
    expect(posted).toEqual([{ type: 'openLink', href: 'https://example.com/guide' }]);
    // A cancelled click is what stops a browser from following the link.
    // `location` is not checked here: happy-dom follows a link while the
    // click is still bubbling, before a handler further up can cancel it,
    // where a browser waits until dispatch has finished.
    expect(event?.defaultPrevented).toBe(true);
  });

  it('posts openLink for a bare URL that Markdown turned into a link', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('Details at https://example.com/changelog today.'))]);
    const anchor = root.querySelector('a');
    if (anchor) click(anchor);
    expect(posted).toEqual([{ type: 'openLink', href: 'https://example.com/changelog' }]);
  });

  it('turns a Markdown image into a link that is opened only on a click', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('![build status](https://tracker.example.com/badge.png)'))]);
    expect(root.querySelector('img')).toBeNull();
    expect(posted).toEqual([]);
    const anchor = root.querySelector('a');
    const before = window.location.href;
    if (anchor) click(anchor);
    expect(posted).toEqual([{ type: 'openLink', href: 'https://tracker.example.com/badge.png' }]);
    expect(window.location.href).toBe(before);
  });

  it('posts the href as written and leaves the decision to the host', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('See [the notes](docs/notes.md) and [the top](#top).'))]);
    const before = window.location.href;
    for (const anchor of root.querySelectorAll('a')) click(anchor);
    expect(posted).toEqual([
      { type: 'openLink', href: 'docs/notes.md' },
      { type: 'openLink', href: '#top' },
    ]);
    expect(window.location.href).toBe(before);
  });

  it('posts nothing for clicks that are not on a link', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('Plain **text** with no link.'))]);
    const strong = root.querySelector('strong');
    const event = strong ? click(strong) : undefined;
    expect(posted).toEqual([]);
    expect(event?.defaultPrevented).toBe(false);
  });

  it('does not turn URLs in user text into links', () => {
    const { app, root } = mount();
    load(app, [userTurn(0, text('Fetch https://example.com/page and [this](https://example.com/other)'))]);
    expect(root.querySelector('a')).toBeNull();
  });
});

describe('lazy Markdown rendering', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', ManualObserver);
  });

  it('shows assistant text as plain text until it nears the viewport, then renders it', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text(`The **fix** is [here](https://example.com/fix). ${XSS}`))]);

    const turn = turnElements(root)[0];
    expect(turn?.textContent).toContain(`The **fix** is [here](https://example.com/fix). ${XSS}`);
    expect(turn?.querySelector('strong, a, img')).toBeNull();

    ManualObserver.latest?.revealAll();

    expect(turn?.querySelector('strong')?.textContent).toBe('fix');
    expect(turn?.querySelector('a')?.getAttribute('href')).toBe('https://example.com/fix');
    expect(turn?.querySelector('img')).toBeNull();
    expect(turn?.textContent).toContain(XSS);
  });

  it('renders each piece of text once, and stops watching it afterwards', () => {
    const { app, root } = mount();
    load(app, [assistantTurn(0, text('**one**')), assistantTurn(1, text('**two**'))]);
    const observer = ManualObserver.latest;
    expect(observer?.observed.size).toBe(2);
    observer?.revealAll();
    expect(observer?.observed.size).toBe(0);
    const html = root.innerHTML;
    observer?.revealAll();
    expect(root.innerHTML).toBe(html);
    expect([...root.querySelectorAll('strong')].map((strong) => strong.textContent)).toEqual(['one', 'two']);
  });

  it('does not watch user text, which is never rendered as Markdown', () => {
    const { app } = mount();
    load(app, [userTurn(0, text('**not bold**'))]);
    expect(ManualObserver.latest?.observed.size ?? 0).toBe(0);
  });

  it('opens links in text that was rendered late', () => {
    const { app, root, posted } = mount();
    load(app, [assistantTurn(0, text('[late link](https://example.com/late)'))]);
    ManualObserver.latest?.revealAll();
    const anchor = root.querySelector('a');
    if (anchor) click(anchor);
    expect(posted).toEqual([{ type: 'openLink', href: 'https://example.com/late' }]);
  });
});

describe('images', () => {
  const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const imageTurn = (): WireTurn => userTurn(3, text('Look at this'), { kind: 'image', block: 1, mediaType: 'image/png' });
  const requestImage = (harness: Harness): number => {
    const show = buttonWithText(harness.root, /Show Image/);
    if (!show) throw new Error('no image button');
    click(show);
    const request = harness.posted.find((message) => message.type === 'requestImage');
    return request?.type === 'requestImage' ? request.requestId : -1;
  };

  it('loads no image until the reader asks for it', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    expect(harness.root.querySelector('img')).toBeNull();
    expect(harness.posted).toEqual([]);
    expect(buttonWithText(harness.root, /Show Image/)).toBeDefined();
  });

  it('posts requestImage with the turn and block', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    requestImage(harness);
    expect(harness.posted).toHaveLength(1);
    expect(harness.posted[0]).toMatchObject({ type: 'requestImage', turn: 3, block: 1 });
  });

  it('shows the image from the bytes the host sent, not from a remote URL', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    const requestId = requestImage(harness);
    harness.app.handle({ type: 'image', requestId, mediaType: 'image/png', base64: PNG_BASE64 });

    const image = harness.root.querySelector('img');
    expect(image).not.toBeNull();
    expect(image?.getAttribute('src')).toMatch(/^blob:/);
    expect(image?.getAttribute('alt')).not.toBe('');
    expect(buttonWithText(harness.root, /Show Image|Loading/)).toBeUndefined();
  });

  it('says so when the image is not available', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    const requestId = requestImage(harness);
    harness.app.handle({ type: 'imageUnavailable', requestId });
    expect(harness.root.querySelector('img')).toBeNull();
    expect(harness.root.textContent).toContain('Image Not Available');
  });

  it('ignores an image reply that nobody asked for', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    expect(() => harness.app.handle({ type: 'image', requestId: 42, mediaType: 'image/png', base64: PNG_BASE64 })).not.toThrow();
    expect(() => harness.app.handle({ type: 'imageUnavailable', requestId: 43 })).not.toThrow();
    expect(harness.root.querySelector('img')).toBeNull();
    expect(buttonWithText(harness.root, /Show Image/)).toBeDefined();
  });

  // The host passes the transcript's base64 through unchecked, and `atob`
  // throws on input that is not base64. The exception escapes the message
  // handler and the button stays on "Loading…".
  it('reports an image whose data is not valid base64 as not available, without throwing', () => {
    const harness = mount();
    load(harness.app, [imageTurn()]);
    const requestId = requestImage(harness);
    expect(() =>
      harness.app.handle({ type: 'image', requestId, mediaType: 'image/png', base64: '***this is not base64***' }),
    ).not.toThrow();
    expect(harness.root.querySelector('img')).toBeNull();
    expect(harness.root.textContent).not.toContain('Loading');
    expect(harness.root.textContent).toContain('Image Not Available');
  });
});

describe('a large transcript', () => {
  /** 2,000 turns that mix prompts, Markdown replies, tool groups, single tools, notes, and images. */
  const largeTranscript = (): WireTurn[] =>
    Array.from({ length: 2000 }, (_, index): WireTurn => {
      if (index % 2 === 0) {
        const blocks: WireBlock[] = [text(`turn ${index}\nPlease look at **file ${index}** and ${XSS}`)];
        if (index % 100 === 0) blocks.push({ kind: 'image', block: 1, mediaType: 'image/png' });
        return { index, role: 'user', ts: '2026-01-02T03:04:05Z', blocks };
      }
      return assistantTurn(
        index,
        text(`turn ${index}\n\n## Step ${index}\n\n- checked \`file${index}.ts\`\n- see [the docs](https://example.com/${index})\n\n${XSS}`),
        tool(1, 'Bash', { status: index % 7 === 0 ? 'error' : 'success' }),
        tool(2, 'Read'),
        tool(3, 'Edit', { hasBody: false }),
        text('Done with that step.'),
        tool(5, 'Grep'),
        { kind: 'note', text: 'Unsupported block: video' },
      );
    });

  it('renders 2,000 turns without throwing, in order', () => {
    vi.stubGlobal('IntersectionObserver', ManualObserver);
    const { app, root, posted } = mount();
    const turns = largeTranscript();

    expect(() => load(app, turns)).not.toThrow();

    expect(renderedTurns(root)).toEqual(turns.map((turn) => turn.index));
    expect(toolGroups(root)).toHaveLength(1000);
    expect(root.querySelector('img, script, iframe')).toBeNull();
    expect(posted).toEqual([]);

    // Scrolling through the whole transcript renders every reply as Markdown.
    expect(() => ManualObserver.latest?.revealAll()).not.toThrow();
    expect(root.querySelectorAll('article h2')).toHaveLength(1000);
    expect(root.querySelector('img, script, iframe')).toBeNull();
    expect(renderedTurns(root)).toEqual(turns.map((turn) => turn.index));
  });

  it('renders 2,000 turns when Markdown is rendered at once', () => {
    const { app, root } = mount();
    const turns = largeTranscript();
    expect(() => load(app, turns)).not.toThrow();
    expect(turnElements(root)).toHaveLength(2000);
    expect(root.querySelectorAll('article a')).toHaveLength(1000);
    expect(root.querySelector('img, script, iframe')).toBeNull();
  });

  it('holds back the earlier part of a 2,000-turn transcript and reveals it on request', () => {
    const { app, root } = mount();
    const turns = largeTranscript();
    expect(() => load(app, turns, { start: 1990 })).not.toThrow();
    expect(renderedTurns(root)).toEqual(turns.slice(1990).map((turn) => turn.index));

    const button = buttonWithText(root, /Show Earlier Messages/);
    expect(button?.textContent).toContain('1990');
    if (button) click(button);
    const rendered = renderedTurns(root);
    expect(rendered.length).toBeGreaterThan(10);
    expect(rendered).toEqual(Array.from({ length: rendered.length }, (_, n) => 2000 - rendered.length + n));
  });
});
