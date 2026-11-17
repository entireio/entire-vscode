import type { Outcome } from '../core/trails';
import {
  PROTOCOL_VERSION,
  type TrailChangeView,
  type TrailEventView,
  type TrailHostMessage,
  type TrailMergeView,
  type TrailTimelineView,
  type TrailView,
  type TrailWebviewMessage,
} from '../shared/protocol';
import { button, formatDate, h } from './dom';
import { renderMarkdown } from './markdown';

export interface TrailVsCodeApi {
  postMessage(message: TrailWebviewMessage): void;
  setState(state: unknown): void;
  getState(): unknown;
}

export interface TrailApp {
  /** Announces that the page can receive messages. */
  start(): void;
  handle(message: TrailHostMessage): void;
}

const OUTCOME_LABELS: Record<Outcome, string> = {
  passed: 'Passed',
  failed: 'Failed',
  pending: 'Pending',
  skipped: 'Skipped',
};

/** Shown while the host reads again a trail that it drew from an earlier read. */
const REFRESHING = 'Checking Entire for updates…';

/** The outcome as a word. Color alone would not say it. */
function outcomeBadge(outcome: Outcome): HTMLElement {
  return h('span', { class: `outcome ${outcome}`, text: OUTCOME_LABELS[outcome] });
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function count(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString('en-US')} ${value === 1 ? singular : plural}`;
}

/** The page of the trail panel: a trail, its changes, and the activity on one of them. */
export function createTrailApp(root: HTMLElement, api: TrailVsCodeApi): TrailApp {
  let eventsElement: HTMLElement | undefined;
  let moreElement: HTMLElement | undefined;
  /** Timeline entries drawn so far, which is also the position of the next one on the host. */
  let eventCount = 0;
  /** The timeline's section, or its placeholder while the timeline is read. The host replaces it in place. */
  let timelineElement: HTMLElement | undefined;
  /** The line under the header's buttons that says a fresh read is under way, or how it went wrong. */
  let statusElement: HTMLElement | undefined;
  /** The trail on the page, so that a redraw of the same one keeps the reader's place. */
  let shownTrail: number | undefined;

  const post = (message: TrailWebviewMessage): void => api.postMessage(message);

  // Links never navigate the page. The host decides whether to open them.
  root.addEventListener('click', (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a');
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute('href');
    if (href) post({ type: 'openLink', href });
  });

  const showStatus = (text: string, retry: boolean): void => {
    eventsElement = undefined;
    moreElement = undefined;
    timelineElement = undefined;
    statusElement = undefined;
    shownTrail = undefined;
    root.replaceChildren(
      h(
        'div',
        { class: 'status-view', attrs: { role: 'status' } },
        h('p', { text }),
        retry && button('Retry', 'primary', () => post({ type: 'retry' })),
      ),
    );
  };

  const setStatus = (text: string | undefined): void => {
    if (!statusElement) return;
    statusElement.textContent = text ?? '';
    statusElement.hidden = !text;
  };

  const renderHeader = (view: TrailView): HTMLElement => {
    const meta = h('div', { class: 'meta' });
    meta.append(h('span', { class: 'strong', text: `Trail #${view.number}` }));
    const state = view.phase ?? view.status;
    if (state) meta.append(h('span', { class: `badge ${view.status === 'closed' ? 'closed' : 'open'}`, text: capitalize(state) }));
    if (view.type) meta.append(h('span', { text: capitalize(view.type) }));
    if (view.priority) meta.append(h('span', { text: `${capitalize(view.priority)} priority` }));
    if (view.project) meta.append(h('span', { text: view.project }));

    const people = h('div', { class: 'meta' });
    if (view.assignees.length > 0) people.append(h('span', { text: `Assigned to ${view.assignees.join(', ')}` }));
    const created = formatDate(view.createdAt);
    if (created) people.append(h('span', { text: `Created ${created}` }));
    const closed = formatDate(view.closedAt);
    const active = formatDate(view.lastActivityAt);
    if (closed) people.append(h('span', { text: `Closed ${closed}` }));
    else if (active) people.append(h('span', { text: `Last activity ${active}` }));

    const actions = h('div', { class: 'actions' });
    if (view.canOpenOnWeb) {
      actions.append(
        button('Open on entire.com', 'primary', () => post({ type: 'openOnWeb' })),
        button('Copy Link', 'secondary', () => post({ type: 'copyLink' })),
      );
    }
    actions.append(
      button('Refresh', 'secondary', () => post({ type: 'retry' }), 'Read this trail from Entire again'),
    );

    statusElement = h('p', { class: 'refresh-status', attrs: { role: 'status' } });
    setStatus(view.refreshing ? REFRESHING : view.notice);

    return h(
      'header',
      { class: 'header' },
      h('h1', { class: 'title', text: view.title }),
      meta,
      people.childNodes.length > 0 && people,
      actions,
      statusElement,
    );
  };

  const renderDescription = (view: TrailView): HTMLElement | undefined => {
    if (view.body.trim() === '') return undefined;
    const body = h('div', { class: 'text markdown' });
    body.innerHTML = renderMarkdown(view.body);
    return h('section', { class: 'description' }, h('h2', { text: 'Description' }), body);
  };

  const renderTabs = (view: TrailView): HTMLElement | undefined => {
    if (view.changes.length < 2) return undefined;
    const tabs = h('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Changes in this trail' } });
    view.changes.forEach((change, position) => {
      const tab = button(`${change.repository} #${change.number}`, 'tab', () => {
        if (position !== view.selected) post({ type: 'selectChange', position });
      });
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(position === view.selected));
      if (change.branch) tab.title = change.branch;
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

  const renderMerge = (merge: TrailMergeView): HTMLElement[] => {
    const parts: HTMLElement[] = [];
    const blocked = merge.gates.filter((gate) => gate.blocking && gate.outcome !== 'passed' && gate.outcome !== 'skipped');
    const verdict = merge.mergeable
      ? 'Ready to merge.'
      : merge.conflict
        ? `Not ready to merge: the branch has conflicts with its base (${merge.conflict}).`
        : blocked.length > 0
          ? `Not ready to merge: ${blocked.map((gate) => gate.label.toLowerCase()).join(', ')}.`
          : 'Not ready to merge.';
    parts.push(h('p', { class: `verdict ${merge.mergeable ? 'passed' : 'failed'}`, text: verdict }));

    if (merge.gates.length > 0) {
      const list = h('ul', { class: 'gates' });
      for (const gate of merge.gates) {
        list.append(
          h(
            'li',
            { class: 'gate' },
            outcomeBadge(gate.outcome),
            h(
              'div',
              { class: 'gate-body' },
              h(
                'div',
                {},
                h('span', { class: 'strong', text: gate.label }),
                !gate.blocking && h('span', { class: 'muted', text: ' (does not block a merge)' }),
                gate.findings !== undefined && gate.findings > 0
                  ? h('span', { class: 'muted', text: ` · ${count(gate.findings, 'finding', 'findings')}` })
                  : undefined,
              ),
              gate.rationale ? h('div', { class: 'muted', text: gate.rationale }) : undefined,
            ),
          ),
        );
      }
      parts.push(list);
    }

    if (merge.checksNote) parts.push(h('p', { class: 'notice', text: merge.checksNote }));
    if (merge.checks.length > 0) {
      const list = h('ul', { class: 'checks' });
      // Runs that need attention come first. The position sent to the host is the original one.
      const order: Outcome[] = ['failed', 'pending', 'passed', 'skipped'];
      const sorted = merge.checks
        .map((check, run) => ({ check, run }))
        .sort((a, b) => order.indexOf(a.check.outcome) - order.indexOf(b.check.outcome));
      for (const { check, run } of sorted) {
        list.append(
          h(
            'li',
            { class: 'check' },
            outcomeBadge(check.outcome),
            check.hasLink
              ? button(check.name, 'link', () => post({ type: 'openCheck', run }), 'Open the page of this run')
              : h('span', { text: check.name }),
            h('span', { class: 'muted', text: check.app ? `${check.detail} · ${check.app}` : check.detail }),
          ),
        );
      }
      const details = h(
        'details',
        { class: 'checks-group' },
        h('summary', {}, h('span', { class: 'strong', text: 'CI runs' }), h('span', { class: 'muted', text: ` ${merge.checkSummary}` })),
        list,
      );
      details.open = merge.checks.some((check) => check.outcome === 'failed' || check.outcome === 'pending');
      parts.push(details);
    }
    return parts;
  };

  const renderChange = (change: TrailChangeView): HTMLElement => {
    const meta = h('div', { class: 'meta' });
    if (change.branch) {
      meta.append(button(change.branch, 'chip', () => post({ type: 'copyBranch' }), 'Copy branch name'));
      if (change.base) meta.append(h('span', { text: `into ${change.base}` }));
    }
    if (change.status) meta.append(h('span', { text: capitalize(change.status) }));
    if (change.checkedOut) meta.append(h('span', { class: 'strong', text: 'Checked out here' }));
    if (!change.hasCodeChanges) meta.append(h('span', { text: 'No code changes yet' }));

    return h(
      'section',
      { class: 'change' },
      h('h2', { text: `Change ${change.repository} #${change.number}` }),
      change.title ? h('p', { class: 'change-title', text: change.title }) : undefined,
      meta.childNodes.length > 0 && meta,
      ...(change.merge ? renderMerge(change.merge) : []),
      change.canOpenOnWeb &&
        h(
          'div',
          { class: 'actions' },
          button('Open Change on entire.com', 'secondary', () => post({ type: 'openChangeOnWeb' })),
        ),
    );
  };

  const renderEvent = (event: TrailEventView, position: number): HTMLElement => {
    const time = formatDate(event.at);
    const head = h(
      'div',
      { class: 'event-head' },
      event.actor ? h('span', { class: 'strong', text: event.actor }) : undefined,
      time ? h('time', { text: time, attrs: { datetime: event.at ?? '' } }) : undefined,
    );
    const item = h('li', { class: `event ${event.commit ? 'commit' : 'note'}` }, head, h('div', { class: 'event-text', text: event.text }));

    const commit = event.commit;
    if (!commit) return item;

    const facts = h('div', { class: 'meta' });
    facts.append(button(commit.shortSha, 'chip', () => post({ type: 'copyCommitSha', event: position }), 'Copy commit SHA'));
    if (commit.additions !== undefined || commit.deletions !== undefined) {
      facts.append(
        h('span', { class: 'stat-add', text: `+${(commit.additions ?? 0).toLocaleString('en-US')}` }),
        h('span', { class: 'stat-del', text: `-${(commit.deletions ?? 0).toLocaleString('en-US')}` }),
      );
    }
    if (commit.files !== undefined) facts.append(h('span', { text: count(commit.files, 'file', 'files') }));
    if (commit.agents.length > 0) facts.append(h('span', { text: commit.agents.join(', ') }));
    if (!commit.local) {
      facts.append(
        h('span', {
          text:
            commit.remoteCheckpoints > 0
              ? `Not in this clone · ${count(commit.remoteCheckpoints, 'checkpoint', 'checkpoints')} on entire.com`
              : 'Not in this clone',
          title: 'Fetch this branch to open the commit and its checkpoints here.',
        }),
      );
    }
    item.append(facts);

    if (commit.local) {
      const actions = h('div', { class: 'event-actions' });
      for (let checkpoint = 0; checkpoint < commit.checkpoints; checkpoint += 1) {
        actions.append(
          button(
            commit.checkpoints === 1 ? 'Open Checkpoint' : `Open Checkpoint ${checkpoint + 1}`,
            'secondary',
            () => post({ type: 'openCheckpoint', event: position, checkpoint }),
            'Open the agent session behind this commit',
          ),
        );
      }
      actions.append(button('Show Commit Diff', 'secondary', () => post({ type: 'showCommitDiff', event: position })));
      item.append(actions);
    }
    return item;
  };

  const appendEvents = (events: TrailEventView[]): void => {
    if (!eventsElement) return;
    const fragment = document.createDocumentFragment();
    for (const event of events) {
      fragment.append(renderEvent(event, eventCount));
      eventCount += 1;
    }
    eventsElement.append(fragment);
  };

  /** The Load More row of the timeline, with the reason when a page failed to load. */
  const updateMore = (hasMore: boolean, problem?: string): void => {
    if (!moreElement) return;
    moreElement.replaceChildren();
    if (problem) moreElement.append(h('p', { class: 'notice', text: problem }));
    if (!hasMore) return;
    const more = button('Load More', 'secondary', () => {
      more.disabled = true;
      more.textContent = 'Loading…';
      post({ type: 'loadMoreTimeline' });
    });
    moreElement.append(more);
  };

  const renderTimeline = (timeline: TrailTimelineView): HTMLElement => {
    eventsElement = h('ol', { class: 'timeline' });
    moreElement = h('div', { class: 'timeline-more' });
    eventCount = 0;
    appendEvents(timeline.events);
    updateMore(timeline.hasMore);
    return h(
      'section',
      { class: 'timeline-section' },
      h('h2', { text: 'Timeline' }),
      timeline.notice ? h('p', { class: 'notice', text: timeline.notice }) : undefined,
      timeline.events.length === 0 && !timeline.notice
        ? h('p', { class: 'muted', text: 'Nothing has happened on this change yet.' })
        : undefined,
      eventsElement,
      moreElement,
    );
  };

  /** Stands where the timeline will be while the host reads it. */
  const renderTimelinePending = (): HTMLElement => {
    eventsElement = undefined;
    moreElement = undefined;
    eventCount = 0;
    return h(
      'section',
      { class: 'timeline-section' },
      h('h2', { text: 'Timeline' }),
      h('p', { class: 'pending', text: 'Loading…', attrs: { role: 'status' } }),
    );
  };

  /** Puts the timeline, once read, where its placeholder or an earlier timeline stands. */
  const replaceTimeline = (timeline: TrailTimelineView): void => {
    if (!timelineElement) return;
    const next = renderTimeline(timeline);
    timelineElement.replaceWith(next);
    timelineElement = next;
  };

  const renderTrail = (view: TrailView): void => {
    // The host sends a trail again as more of it is read, and the reader
    // stays where they were. Another trail starts at the top.
    const top = shownTrail === view.number ? window.scrollY : 0;
    eventsElement = undefined;
    moreElement = undefined;
    timelineElement = undefined;
    const parts: (HTMLElement | undefined)[] = [renderHeader(view), renderDescription(view)];
    if (view.partial) {
      // Only what the Trails view lists is known so far. The changes are on their way.
      parts.push(h('p', { class: 'pending', text: 'Loading…', attrs: { role: 'status' } }));
    } else {
      const change = view.changes[view.selected];
      timelineElement = view.timeline
        ? renderTimeline(view.timeline)
        : view.timelinePending
          ? renderTimelinePending()
          : undefined;
      parts.push(
        renderTabs(view),
        change
          ? renderChange(change)
          : h('section', {}, h('p', { class: 'muted', text: 'This trail has no branch in a repository yet.' })),
        timelineElement,
      );
    }
    root.replaceChildren(...parts.filter((element) => element !== undefined));
    shownTrail = view.number;
    if (window.scrollY !== top) window.scrollTo(0, top);
  };

  return {
    start(): void {
      showStatus('Loading…', false);
      post({ type: 'ready', protocol: PROTOCOL_VERSION });
    },

    handle(message: TrailHostMessage): void {
      switch (message.type) {
        case 'loading':
          showStatus('Loading…', false);
          return;
        case 'error':
          showStatus(message.message, message.canRetry);
          return;
        case 'trail':
          api.setState(message.restore);
          renderTrail(message.view);
          return;
        case 'timeline':
          replaceTimeline(message.timeline);
          return;
        case 'refreshed':
          setStatus(message.notice);
          return;
        case 'timelinePage':
          appendEvents(message.events);
          updateMore(message.hasMore, message.notice);
          return;
      }
    },
  };
}
