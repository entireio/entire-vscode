import type { TrailChange, TrailCheckRun, TrailEvent, TrailGate, TrailPage, TrailSummary } from './schemas';

/**
 * The parts of an `entire://` remote that name a repository on Entire.
 * `EntireRepo` in `webLinks.ts` fits it. It is declared here so the panel's
 * page, which shares this module, does not pull in code that needs Node.
 */
export interface HostedRepo {
  /** `gh` for a GitHub mirror, `et` for an Entire-native repository. */
  forge: string;
  /** GitHub owner, or Entire project. */
  owner: string;
  repo: string;
}

/** The lifecycle status of a trail. A trail is open until someone closes it. */
export type TrailStatus = 'open' | 'closed';

/** What the CLI can list: the trails of one status, or the trails of both. */
export type TrailListStatus = TrailStatus | 'all';

/**
 * Which trails the Trails view shows.
 *
 * A trail has a status, and an open trail is also in a phase that follows its
 * work: planning, building, or complete. The CLI lists by status and cannot
 * list by phase, so a phase is matched here, against the trails read so far.
 */
export interface TrailFilter {
  status: TrailListStatus;
  /** Only open trails in this phase. */
  phase?: string;
}

export const DEFAULT_TRAIL_FILTER: TrailFilter = { status: 'open' };

/** The phases of an open trail that the filter offers by name. */
export const OPEN_PHASES: readonly string[] = ['planning', 'building', 'complete'];

const PHASE_NAME = /^[a-z][a-z0-9_-]{0,39}$/;

/** A filter as one string: `all`, `open`, `closed`, or `open:<phase>`. */
export function trailFilterKey(filter: TrailFilter): string {
  return filter.phase ? `${filter.status}:${filter.phase}` : filter.status;
}

/** Reads a filter back from its key, or returns undefined for anything else. */
export function readTrailFilter(key: unknown): TrailFilter | undefined {
  if (typeof key !== 'string') return undefined;
  if (key === 'all' || key === 'open' || key === 'closed') return { status: key };
  const [status, phase, ...rest] = key.split(':');
  // Only an open trail has a phase to tell apart. A closed one is in the closed phase.
  if (status !== 'open' || !phase || rest.length > 0 || !PHASE_NAME.test(phase)) return undefined;
  return { status: 'open', phase };
}

/** The filter's name: "All", "Open", "Closed", or the phase, such as "Building". */
export function trailFilterLabel(filter: TrailFilter): string {
  if (filter.phase) return sentenceCase(filter.phase);
  return filter.status === 'all' ? 'All' : filter.status === 'closed' ? 'Closed' : 'Open';
}

/** What to say when no trail matches the filter. */
export function noTrailsText(filter: TrailFilter): string {
  if (filter.phase) return `No open trails in the ${words(filter.phase)} phase touch this repository.`;
  if (filter.status === 'all') return 'No trails touch this repository.';
  return `No ${filter.status} trails touch this repository.`;
}

/**
 * The filters to offer: every status the CLI lists by, then each phase of an
 * open trail. `seen` adds the phases that trails read so far are in, so a
 * phase that a later CLI introduces can still be picked.
 */
export function trailFilters(seen: Iterable<string | undefined> = []): TrailFilter[] {
  const extra = [...new Set(seen)]
    .filter((phase): phase is string => phase !== undefined && PHASE_NAME.test(phase))
    .filter((phase) => phase !== 'closed' && !OPEN_PHASES.includes(phase))
    .sort();
  return [
    { status: 'all' },
    { status: 'open' },
    { status: 'closed' },
    ...[...OPEN_PHASES, ...extra].map((phase): TrailFilter => ({ status: 'open', phase })),
  ];
}

/** Whether a trail the CLI listed for the filter's status also passes the rest of the filter. */
export function inTrailFilter(trail: Pick<TrailSummary, 'phase'>, filter: TrailFilter): boolean {
  return filter.phase === undefined || trail.phase === filter.phase;
}

/** The trails read so far for one status, and where the CLI's list continues. */
export interface TrailPages {
  /** Most recent activity first, as the CLI lists them. */
  trails: TrailSummary[];
  /** Present while the CLI has more trails to list. */
  nextPageToken?: string;
  /** How many trails the CLI has for the status in all, when it says. */
  total?: number;
}

/** Adds a page to the trails read so far, and returns how many of its trails were new. */
export function addTrailPage(list: TrailPages, page: TrailPage): number {
  // A trail moves to the front when it sees activity, so it can turn up again on a later page.
  const known = new Set(list.trails.map((trail) => trail.number));
  const fresh = page.trails.filter((trail) => !known.has(trail.number));
  list.trails.push(...fresh);
  if (page.nextPageToken) list.nextPageToken = page.nextPageToken;
  else delete list.nextPageToken;
  if (page.total !== undefined) list.total = page.total;
  return fresh.length;
}

/**
 * Pages one read may ask for. A phase can be rare among the open trails, and
 * without a limit a filter on it would read every page there is in one go.
 */
export const MAX_TRAIL_PAGES_PER_READ = 4;

/**
 * Reads further pages until `enough()` says the list holds what is wanted,
 * the CLI has no more, or `maxPages` have been read. `fetch` returns
 * undefined when a page could not be read, and the result is then false.
 */
export async function readTrailPages(
  list: TrailPages,
  fetch: (pageToken: string) => Promise<TrailPage | undefined>,
  enough: () => boolean,
  options: { maxPages?: number; onPage?: () => void } = {},
): Promise<boolean> {
  const maxPages = options.maxPages ?? MAX_TRAIL_PAGES_PER_READ;
  for (let read = 0; read < maxPages && list.nextPageToken && !enough(); read += 1) {
    const token = list.nextPageToken;
    const page = await fetch(token);
    if (!page) return false;
    const added = addTrailPage(list, page);
    // A page that brings nothing new and points back at itself would repeat without end.
    if (added === 0 && list.nextPageToken === token) delete list.nextPageToken;
    options.onPage?.();
  }
  return true;
}

/** The CLI's `--project` argument for a repository: `gh/<owner>` or `et/<project>`. */
export function trailProject(repo: HostedRepo): string {
  return `${repo.forge}/${repo.owner}`;
}

/** The CLI's `--repo` argument for a repository. */
export function trailRepo(repo: HostedRepo): string {
  return `${repo.forge}/${repo.owner}/${repo.repo}`;
}

/** A trail's ID on Entire is a ULID: 26 characters of Crockford base 32. */
const TRAIL_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isTrailId(value: unknown): value is string {
  return typeof value === 'string' && TRAIL_ID.test(value);
}

/**
 * How a CLI call names a trail. Given a number, the CLI first looks up the
 * trail's ID, which costs a request to entire.io. A call that already has
 * the ID passes it and skips that lookup.
 */
export interface TrailRef {
  /** The trail's number in its project. */
  number: number;
  id?: string;
}

/** A change, named the way the CLI takes it: `<repository>/<number>`. */
export interface ChangeRef {
  repository: string;
  number: number;
}

/**
 * What a timeline call reads: one change, or a trail, for which the CLI
 * picks the change. Its pick is certain only for a trail with one change:
 * with several open ones it exits with an error, and its reply does not say
 * which change it read.
 */
export type TimelineOf = ChangeRef | { trail: TrailRef };

export function changeRef(change: ChangeRef): ChangeRef {
  return { repository: change.repository, number: change.number };
}

export function sameChange(a: ChangeRef, b: ChangeRef): boolean {
  return a.repository === b.repository && a.number === b.number;
}

/** Whether a change is a branch of this repository. A trail can span several. */
export function isInRepo(change: TrailChange, repo: HostedRepo): boolean {
  return change.repository.toLowerCase() === repo.repo.toLowerCase();
}

/** Whether a change is the branch that is checked out in this repository. */
export function isCheckedOut(change: TrailChange, repo: HostedRepo, branch: string | undefined): boolean {
  return branch !== undefined && change.branch === branch && isInRepo(change, repo);
}

/**
 * Position of the change that stands for a trail in one repository: the one
 * on the checked-out branch, then the first one in the repository, then the
 * first one. -1 when the trail has no changes.
 */
export function primaryChange(changes: readonly TrailChange[], repo: HostedRepo, branch: string | undefined): number {
  const here = changes.map((change, position) => ({ change, position })).filter(({ change }) => isInRepo(change, repo));
  const current = branch ? here.find(({ change }) => change.branch === branch) : undefined;
  if (current) return current.position;
  if (here[0]) return here[0].position;
  return changes.length > 0 ? 0 : -1;
}

/** How a gate or a CI run stands, reduced to what the views draw. */
export type Outcome = 'passed' | 'failed' | 'pending' | 'skipped';

/** A status the CLI does not report as settled counts as pending. */
export function gateOutcome(gate: TrailGate): Outcome {
  switch (gate.status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

export function checkOutcome(run: TrailCheckRun): Outcome {
  if (run.status !== 'completed') return 'pending';
  switch (run.conclusion) {
    case 'success':
      return 'passed';
    case 'skipped':
    case 'neutral':
      return 'skipped';
    default:
      return 'failed';
  }
}

/** `in_progress` -> "in progress". */
export function words(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim();
}

function sentenceCase(value: string): string {
  const text = words(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const GATE_LABELS: Record<string, string> = {
  approvals: 'Approvals',
  checks: 'Checks',
  findings: 'Findings',
  up_to_date: 'Up to date with base',
};

/** A gate's name as the panel shows it. A gate this extension does not know keeps its key, spelled out. */
export function gateLabel(key: string): string {
  // Keys come from entire.io, so one could name an inherited member such as `constructor`.
  return Object.hasOwn(GATE_LABELS, key) ? (GATE_LABELS[key] ?? sentenceCase(key)) : sentenceCase(key);
}

/** What a CI run is doing or how it ended, in words. */
export function checkDetail(run: TrailCheckRun): string {
  if (run.status === 'completed') return words(run.conclusion ?? 'completed');
  return words(run.status ?? 'pending');
}

const OUTCOME_ORDER: Outcome[] = ['failed', 'pending', 'passed', 'skipped'];

/** "1 failed, 2 pending, 20 passed", leaving out the outcomes that did not occur. */
export function outcomeSummary(outcomes: readonly Outcome[]): string {
  return OUTCOME_ORDER.map((outcome) => {
    const count = outcomes.filter((candidate) => candidate === outcome).length;
    return count > 0 ? `${count} ${outcome}` : undefined;
  })
    .filter((part) => part !== undefined)
    .join(', ');
}

/** One line that says what a timeline entry is. */
export function eventText(event: TrailEvent): string {
  switch (event.kind) {
    case 'commit':
      return event.title ?? 'Commit';
    case 'trail_created':
      return 'Created the trail';
    case 'review_posted':
      if (event.findingCount === undefined) return 'Posted a review';
      if (event.findingCount === 0) return 'Posted a review with no findings';
      return event.findingCount === 1
        ? 'Posted a review with 1 finding'
        : `Posted a review with ${event.findingCount.toLocaleString('en-US')} findings`;
    case 'finding_resolved':
      return 'Resolved a finding';
    default:
      // The CLI adds kinds between releases. An unknown one is shown by name.
      return event.title ?? sentenceCase(event.kind);
  }
}
