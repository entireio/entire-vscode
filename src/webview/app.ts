import { formatPosition, formatTokens } from '../core/format';
import {
  PROTOCOL_VERSION,
  type CopyTarget,
  type HostMessage,
  type PanelHeader,
  type TranscriptInfo,
  type WebviewMessage,
  type WireBlock,
  type WireTurn,
} from '../shared/protocol';
import { button, formatDate, h } from './dom';
import { renderMarkdown } from './markdown';

export interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
}

export interface App {
  /** Announces that the page can receive messages. */
  start(): void;
  handle(message: HostMessage): void;
}

type ToolBlock = Extract<WireBlock, { kind: 'tool' }>;

/** Earlier turns are added this many at a time. */
const EARLIER_PAGE = 30;
/** User text longer than this starts collapsed. */
const CLAMP_CHARS = 1500;
const CLAMP_LINES = 24;

export function createApp(root: HTMLElement, api: VsCodeApi): App {
  let header: PanelHeader | undefined;
  let info: TranscriptInfo | undefined;
  let turns: WireTurn[] = [];
  /** Index of the first turn that is in the DOM. */
  let firstRendered = 0;
  let received = 0;
  let turnsElement: HTMLElement | undefined;
  let earlierButton: HTMLButtonElement | undefined;
  let nextRequest = 1;
  const pendingBodies = new Map<number, { body: HTMLElement; turn: number; block: number }>();
  const pendingImages = new Map<number, HTMLButtonElement>();

  const post = (message: WebviewMessage): void => api.postMessage(message);

  // Assistant text is shown as plain text first and rendered to Markdown when
  // it nears the viewport, so opening a long transcript stays quick.
  const upgrade = (element: HTMLElement): void => {
    if (!element.classList.contains('pending')) return;
    element.innerHTML = renderMarkdown(element.textContent ?? '');
    element.classList.remove('pending');
  };
  const observer =
    typeof IntersectionObserver === 'undefined'
      ? undefined
      : new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              observer?.unobserve(entry.target);
              upgrade(entry.target as HTMLElement);
            }
          },
          { rootMargin: '800px 0px' },
        );

  // Links never navigate the page. The host decides whether to open them.
  root.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) post({ type: 'openLink', href });
  });

  const showStatus = (text: string, retry: boolean): void => {
    header = undefined;
    info = undefined;
    turnsElement = undefined;
    root.replaceChildren(
      h(
        'div',
        { class: 'status-view', attrs: { role: 'status' } },
        h('p', { text }),
        retry && button('Retry', 'primary', () => post({ type: 'retry' })),
      ),
    );
  };

  const copyChip = (label: string, value: string, target: CopyTarget): HTMLElement =>
    h(
      'span',
      { class: 'id-row' },
      h('span', { class: 'id-label', text: label }),
      button(value, 'chip', () => post({ type: 'copy', target }), `Copy ${label.toLowerCase()}`),
    );

  const renderHeader = (data: PanelHeader): HTMLElement => {
    const selected = data.sessions[data.selected];
    const meta = h('div', { class: 'meta' });
    if (data.commit) {
      meta.append(
        button(data.commit.shortSha, 'chip', () => post({ type: 'copy', target: 'commitSha' }), 'Copy commit SHA'),
        h('span', { text: data.commit.author }),
        h('span', { text: formatDate(data.commit.date) }),
      );
    }
    if (data.branch) meta.append(h('span', { text: data.branch }));
    if (data.otherCommits > 0) {
      meta.append(
        h('span', {
          text: data.otherCommits === 1 ? '1 other commit' : `${data.otherCommits} other commits`,
          title: 'Other commits on this branch that carry the same checkpoint',
        }),
      );
    }

    const agent = h('div', { class: 'meta' });
    const agentName = selected?.agent ?? data.localSession?.agent;
    const model = selected?.model ?? data.localSession?.model;
    if (agentName) agent.append(h('span', { class: 'strong', text: agentName }));
    if (model) agent.append(h('span', { text: model }));
    if (selected?.tokens !== undefined) {
      agent.append(
        h('span', {
          text: `${formatTokens(selected.tokens)} tokens`,
          title: `${selected.tokens.toLocaleString()} tokens since the previous checkpoint of this session`,
        }),
      );
    }
    const local = data.localSession;
    if (local) {
      if (local.status) agent.append(h('span', { text: local.status }));
      if (local.turns !== undefined) agent.append(h('span', { text: `${local.turns} turns` }));
      if (local.pendingTurns) {
        agent.append(h('span', { text: `${local.pendingTurns} not in a checkpoint yet` }));
      }
      if (local.tokens !== undefined && selected?.tokens === undefined) {
        agent.append(h('span', { text: `${formatTokens(local.tokens)} tokens` }));
      }
      if (local.lastActive) agent.append(h('span', { text: `Last active ${formatDate(local.lastActive)}` }));
    }

    // Several checkpoints can belong to one session. This line says which one
    // this is and steps to the ones around it.
    let place: HTMLElement | undefined;
    if (data.position) {
      const { position } = data;
      place = h(
        'div',
        { class: 'place' },
        h('span', {
          text: `Checkpoint ${formatPosition(position)} in this session`,
          ...(position.mayHaveEarlier
            ? {
                title:
                  'The Entire CLI lists the checkpoints of the newest 500 commits on this branch, so this session may have earlier ones.',
              }
            : {}),
        }),
      );
      if (position.hasPrevious || position.hasNext) {
        const previous = button('Previous', 'secondary step', () => post({ type: 'stepSession', direction: 'previous' }));
        previous.disabled = !position.hasPrevious;
        previous.setAttribute('aria-label', 'Previous checkpoint in this session');
        previous.title = position.hasPrevious
          ? 'Previous checkpoint in this session'
          : position.mayHaveEarlier
            ? 'Earlier checkpoints of this session are not listed'
            : 'This is the first checkpoint in this session';
        const next = button('Next', 'secondary step', () => post({ type: 'stepSession', direction: 'next' }));
        next.disabled = !position.hasNext;
        next.setAttribute('aria-label', 'Next checkpoint in this session');
        next.title = position.hasNext ? 'Next checkpoint in this session' : 'This is the latest checkpoint in this session';
        place.append(previous, next);
      }
    }

    const ids = h('div', { class: 'ids' });
    if (data.checkpointId) ids.append(copyChip('Checkpoint', data.checkpointId, 'checkpointId'));
    const sessionId = selected?.sessionId ?? local?.sessionId;
    if (sessionId) ids.append(copyChip('Session', sessionId, 'sessionId'));

    const actions = h('div', { class: 'actions' });
    if (data.canOpenOnWeb) actions.append(button('Open on entire.com', 'primary', () => post({ type: 'openOnWeb' })));
    if (data.canShowCommitDiff) {
      actions.append(button('Show Commit Diff', 'secondary', () => post({ type: 'showCommitDiff' })));
    }
    if (data.canOpenRaw) {
      actions.append(button('Open Raw Transcript', 'secondary', () => post({ type: 'openRawTranscript' })));
    }

    return h(
      'header',
      { class: 'header' },
      h('h1', { class: 'title', text: data.title }),
      meta.childNodes.length > 0 && meta,
      agent.childNodes.length > 0 && agent,
      place,
      ids.childNodes.length > 0 && ids,
      actions.childNodes.length > 0 && actions,
      data.notice ? h('p', { class: 'notice', text: data.notice }) : undefined,
    );
  };

  const renderTabs = (data: PanelHeader): HTMLElement | undefined => {
    if (data.sessions.length < 2) return undefined;
    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Sessions in this checkpoint' } });
    data.sessions.forEach((session, position) => {
      const label = [session.agent ?? `Session ${position + 1}`, session.model].filter(Boolean).join(' · ');
      const tab = button(label, 'tab', () => {
        if (position !== data.selected) post({ type: 'selectSession', position });
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(position === data.selected));
      tabs.append(tab);
    });
    // Arrow keys move between tabs, as they do in a native tab list.
    tabs.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      const all = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const current = all.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const step = event.key === 'ArrowRight' ? 1 : -1;
      all[(current + step + all.length) % all.length]?.focus();
    });
    return tabs;
  };

  const renderSummary = (data: PanelHeader): HTMLElement | undefined => {
    const selected = data.sessions[data.selected];
    if (!selected?.intent && !selected?.outcome) return undefined;
    return h(
      'section',
      { class: 'summary' },
      h('h2', { text: 'Summary' }),
      selected.intent ? h('p', {}, h('span', { class: 'strong', text: 'Intent ' }), selected.intent) : undefined,
      selected.outcome ? h('p', {}, h('span', { class: 'strong', text: 'Outcome ' }), selected.outcome) : undefined,
    );
  };

  const renderFiles = (data: PanelHeader): HTMLElement | undefined => {
    if (data.files.length === 0) return undefined;
    const list = h('ul');
    data.files.forEach((file, index) => {
      list.append(
        h(
          'li',
          { class: 'file' },
          h('span', { class: 'status-letter', text: file.status ?? '', attrs: { 'aria-hidden': 'true' } }),
          button(
            file.path,
            'link',
            () => post({ type: 'openFile', index }),
            file.status ? 'Show what the commit changed in this file' : 'Open this file',
          ),
        ),
      );
    });
    const details = h(
      'details',
      { class: 'files' },
      h('summary', {}, h('h2', { text: `Files (${data.files.length})` })),
      list,
    );
    details.open = data.files.length <= 12;
    return details;
  };

  /** Shown on a prompt while the host does not know who sent it. The reader may not be that person. */
  const UNNAMED_USER = 'User';

  const roleLabel = (role: WireTurn['role']): string => {
    if (role === 'user') return header?.promptAuthor ?? UNNAMED_USER;
    return header?.sessions[header.selected]?.agent ?? header?.localSession?.agent ?? 'Assistant';
  };

  /** Names the sender on the prompts already drawn. Prompts drawn later read the header. */
  const nameUser = (name: string): void => {
    if (!header) return;
    header.promptAuthor = name;
    for (const label of root.querySelectorAll('.turn.user > .turn-head > .role')) label.textContent = name;
  };

  const renderText = (role: WireTurn['role'], text: string): HTMLElement[] => {
    if (role === 'assistant') {
      const element = h('div', { class: 'text markdown pending', text });
      if (observer) observer.observe(element);
      else upgrade(element);
      return [element];
    }
    const element = h('div', { class: 'text plain', text });
    if (text.length <= CLAMP_CHARS && text.split('\n').length <= CLAMP_LINES) return [element];
    element.classList.add('clamped');
    const toggle = button('Show More', 'link', () => {
      const clamped = element.classList.toggle('clamped');
      toggle.textContent = clamped ? 'Show More' : 'Show Less';
    });
    return [element, toggle];
  };

  const renderTool = (turn: number, tool: ToolBlock): HTMLElement => {
    const summaryParts = [
      h('span', { class: 'tool-name', text: tool.name }),
      tool.summary ? h('span', { class: 'tool-summary', text: tool.summary }) : undefined,
      tool.status === 'error' ? h('span', { class: 'tool-failed', text: 'Failed' }) : undefined,
    ];
    if (!tool.hasBody) return h('div', { class: 'tool static' }, ...summaryParts);

    const body = h('div', { class: 'tool-body' });
    const details = h('details', { class: 'tool' }, h('summary', {}, ...summaryParts), body);
    let requested = false;
    details.addEventListener('toggle', () => {
      if (!details.open || requested) return;
      requested = true;
      body.replaceChildren(h('p', { class: 'muted', text: 'Loading…' }));
      const requestId = nextRequest++;
      pendingBodies.set(requestId, { body, turn, block: tool.block });
      post({ type: 'requestToolBody', requestId, turn, block: tool.block });
    });
    return details;
  };

  const renderTools = (turn: number, tools: ToolBlock[]): HTMLElement => {
    const [first] = tools;
    if (tools.length === 1 && first) return renderTool(turn, first);
    const names = [...new Set(tools.map((tool) => tool.name))];
    const shown = names.slice(0, 4).join(', ');
    const more = names.length > 4 ? `, +${names.length - 4} more` : '';
    const failed = tools.filter((tool) => tool.status === 'error').length;
    return h(
      'details',
      { class: 'tool-group' },
      h(
        'summary',
        {},
        h('span', { text: `${tools.length} tool calls (${shown}${more})` }),
        failed > 0 ? h('span', { class: 'tool-failed', text: `${failed} failed` }) : undefined,
      ),
      h('div', { class: 'tool-group-body' }, ...tools.map((tool) => renderTool(turn, tool))),
    );
  };

  const renderImage = (turn: number, block: number): HTMLElement => {
    const chip = button('Show Image', 'secondary', () => {
      chip.disabled = true;
      chip.textContent = 'Loading…';
      const requestId = nextRequest++;
      pendingImages.set(requestId, chip);
      post({ type: 'requestImage', requestId, turn, block });
    });
    return h('div', { class: 'image-row' }, chip);
  };

  const renderTurn = (turn: WireTurn): HTMLElement => {
    const body = h('div', { class: 'turn-body' });
    let tools: ToolBlock[] = [];
    const flushTools = (): void => {
      if (tools.length === 0) return;
      body.append(renderTools(turn.index, tools));
      tools = [];
    };
    for (const block of turn.blocks) {
      if (block.kind === 'tool') {
        tools.push(block);
        continue;
      }
      flushTools();
      if (block.kind === 'text') body.append(...renderText(turn.role, block.text));
      else if (block.kind === 'image') body.append(renderImage(turn.index, block.block));
      else body.append(h('p', { class: 'muted', text: block.text }));
    }
    flushTools();

    const time = formatDate(turn.ts);
    return h(
      'article',
      { class: `turn ${turn.role}`, attrs: { 'data-turn': String(turn.index) } },
      h(
        'div',
        { class: 'turn-head' },
        h('span', { class: 'role', text: roleLabel(turn.role) }),
        time ? h('time', { text: time, attrs: { datetime: turn.ts ?? '' } }) : undefined,
      ),
      body,
    );
  };

  const updateEarlier = (): void => {
    if (!earlierButton) return;
    earlierButton.hidden = firstRendered <= 0;
    earlierButton.textContent = `Show Earlier Messages (${firstRendered})`;
  };

  const showEarlier = (): void => {
    if (!turnsElement) return;
    const from = Math.max(0, firstRendered - EARLIER_PAGE);
    const fragment = document.createDocumentFragment();
    for (const turn of turns.slice(from, firstRendered)) fragment.append(renderTurn(turn));
    turnsElement.prepend(fragment);
    firstRendered = from;
    updateEarlier();
  };

  const renderShell = (data: PanelHeader, transcript: TranscriptInfo): void => {
    firstRendered = Math.min(Math.max(0, transcript.start), transcript.total);
    turnsElement = h('div', { class: 'turns' });
    earlierButton = button('', 'secondary earlier', showEarlier, 'Messages from before this checkpoint');
    updateEarlier();
    root.replaceChildren(
      renderHeader(data),
      ...[renderTabs(data), renderSummary(data), renderFiles(data)].filter((element) => element !== undefined),
      h(
        'section',
        { class: 'transcript' },
        h('h2', { text: 'Transcript' }),
        transcript.notice ? h('p', { class: 'notice', text: transcript.notice }) : undefined,
        earlierButton,
        turnsElement,
      ),
    );
  };

  const fillToolBody = (requestId: number, input: string, output: string, truncated: boolean): void => {
    const pending = pendingBodies.get(requestId);
    pendingBodies.delete(requestId);
    if (!pending) return;
    const { body, turn, block } = pending;
    body.replaceChildren();
    if (input) body.append(h('div', { class: 'label', text: 'Input' }), h('pre', { text: input }));
    if (output) body.append(h('div', { class: 'label', text: 'Result' }), h('pre', { text: output }));
    if (!input && !output) body.append(h('p', { class: 'muted', text: 'Nothing was recorded for this call.' }));
    if (truncated) {
      body.append(
        h('p', { class: 'muted', text: 'This is the first part. The full text is longer.' }),
        button('Open in Editor', 'secondary', () => post({ type: 'openToolBody', turn, block })),
      );
    }
  };

  const fillImage = (requestId: number, mediaType: string | undefined, base64: string | undefined): void => {
    const chip = pendingImages.get(requestId);
    pendingImages.delete(requestId);
    if (!chip) return;
    if (!mediaType || !base64) {
      chip.textContent = 'Image Not Available';
      return;
    }
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    } catch {
      // The data came from a transcript and is not valid base64.
      chip.textContent = 'Image Not Available';
      return;
    }
    const image = h('img', {
      class: 'image',
      attrs: { src: URL.createObjectURL(new Blob([bytes], { type: mediaType })), alt: 'Image from the transcript' },
    });
    chip.replaceWith(image);
  };

  return {
    start(): void {
      showStatus('Loading…', false);
      post({ type: 'ready', protocol: PROTOCOL_VERSION });
    },

    handle(message: HostMessage): void {
      switch (message.type) {
        case 'loading':
          showStatus('Loading…', false);
          return;
        case 'error':
          showStatus(message.message, message.canRetry);
          return;
        case 'init':
          header = message.header;
          info = message.transcript;
          turns = [];
          received = 0;
          pendingBodies.clear();
          pendingImages.clear();
          api.setState(message.restore);
          renderShell(message.header, message.transcript);
          return;
        case 'promptAuthor':
          nameUser(message.name);
          return;
        case 'turns': {
          if (!turnsElement || !info) return;
          turns.push(...message.turns);
          const fragment = document.createDocumentFragment();
          for (const turn of message.turns) {
            if (turn.index >= firstRendered) fragment.append(renderTurn(turn));
          }
          turnsElement.append(fragment);
          received += message.turns.length;
          if (message.done && received === 0 && !info.notice) {
            turnsElement.append(h('p', { class: 'muted', text: 'This transcript is empty.' }));
          }
          return;
        }
        case 'toolBody':
          fillToolBody(message.requestId, message.input, message.output, message.truncated);
          return;
        case 'image':
          fillImage(message.requestId, message.mediaType, message.base64);
          return;
        case 'imageUnavailable':
          fillImage(message.requestId, undefined, undefined);
          return;
      }
    },
  };
}
