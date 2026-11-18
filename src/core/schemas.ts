/**
 * Shapes of the Entire CLI's JSON output, read tolerantly.
 *
 * The CLI is pre-1.0 and adds fields between releases, so these readers take
 * what they recognize, default what is missing, and drop entries that lack an
 * ID instead of rejecting the whole payload.
 */
import { isTrailId } from './trails';

export interface ActiveSession {
  sessionId?: string;
  agent?: string;
  model?: string;
  status?: string;
  branch?: string;
  worktreePath?: string;
}

export interface StatusInfo {
  enabled: boolean;
  /** Present when the CLI could not evaluate the repo, e.g. "not a git repository". */
  error?: string;
  agents: string[];
  activeSessions: ActiveSession[];
}

/** One row of `entire checkpoint explain --json` with no target. */
export interface CheckpointRow {
  checkpointId: string;
  /** The session the row's `agent` and `message` describe. */
  sessionId?: string;
  agent?: string;
  date?: string;
  /**
   * The commit subject when a commit on the branch carries the checkpoint,
   * and otherwise the latest prompt of its session.
   */
  message?: string;
  sessionIds: string[];
  sessionCount?: number;
}

export interface TokenUsage {
  input: number;
  cacheCreation: number;
  cacheRead: number;
  output: number;
  apiCalls: number;
}

export interface SessionSummaryText {
  intent?: string;
  outcome?: string;
}

/** One session slot inside a checkpoint. */
export interface CheckpointSession {
  index: number;
  sessionId?: string;
  agent?: string;
  model?: string;
  kind?: string;
  createdAt?: string;
  filesTouched: string[];
  /** Usage since the previous checkpoint of the same session. */
  tokenUsage?: TokenUsage;
  summary?: SessionSummaryText;
}

export interface CheckpointTask {
  toolUseId: string;
  agentId?: string;
  subagentType?: string;
  description?: string;
  startedAt?: string;
  completedAt?: string;
}

/** `entire checkpoint explain --checkpoint <id> --json`. */
export interface CheckpointDetail {
  checkpointId: string;
  branch?: string;
  /** Named `checkpoints_count` by the CLI, but it counts prompts. */
  promptCount?: number;
  filesTouched: string[];
  sessions: CheckpointSession[];
  tasks: CheckpointTask[];
  /** The CLI could read only part of the checkpoint. */
  partial: boolean;
}

export interface SessionTokens {
  total: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/** One row of `entire session list --json`. */
export interface SessionRow {
  sessionId: string;
  agent?: string;
  model?: string;
  /** `active`, `idle`, or `ended`. */
  status?: string;
  kind?: string;
  startedAt?: string;
  endedAt?: string;
  lastActive?: string;
  turns?: number;
  /** Turns not yet condensed into a checkpoint. */
  pendingTurns?: number;
  lastCheckpointId?: string;
  tokens?: SessionTokens;
  lastPrompt?: string;
}

/** One CI run on the head commit of a change. */
export interface TrailCheckRun {
  name: string;
  /** `queued`, `in_progress`, or `completed`. */
  status?: string;
  /** Set once the run completes: `success`, `failure`, `skipped`, and so on. */
  conclusion?: string;
  detailsUrl?: string;
  appName?: string;
}

/** One condition a change has to meet before it can merge. */
export interface TrailGate {
  key: string;
  blocking: boolean;
  /** `passed`, `failed`, `skipped`, or a status that means it is still being evaluated. */
  status?: string;
  rationale?: string;
  findingCount?: number;
}

export interface TrailMergeability {
  mergeable: boolean;
  headSha?: string;
  /** `clean` when the branch merges without conflicts. */
  conflictStatus?: string;
  /** `available` when the CLI could read the CI runs. */
  checksAvailability?: string;
  checks: TrailCheckRun[];
  gates: TrailGate[];
}

/**
 * One branch of a trail, in one repository. The CLI calls it a change, and
 * numbers it inside its repository, apart from the trail's own number.
 */
export interface TrailChange {
  /** Short repository name, such as `widget`. */
  repository: string;
  number: number;
  title?: string;
  status?: string;
  branch?: string;
  base?: string;
  hasCodeChanges: boolean;
  updatedAt?: string;
  /** The change's page on the web. Only `entire trail show` reports it. */
  url?: string;
  /** Only `entire trail show` reports it. */
  mergeability?: TrailMergeability;
}

/** A trail as `entire trail list --json` reports it. */
export interface TrailSummary {
  number: number;
  /** The trail's ID on Entire. A CLI call that names the trail by it is quicker than one by number. */
  id?: string;
  title: string;
  body?: string;
  /** `open` or `closed`. */
  status?: string;
  /** `planning`, `building`, `complete`, or `closed`. */
  phase?: string;
  /** `bug`, `feature`, or `task`. */
  type?: string;
  priority?: string;
  assignees: string[];
  createdAt?: string;
  lastActivityAt?: string;
  closedAt?: string;
  changes: TrailChange[];
}

export interface TrailPage {
  trails: TrailSummary[];
  /** Present when the CLI has more trails to list. */
  nextPageToken?: string;
  /** How many trails match the filter in all, when the CLI says. */
  total?: number;
}

/** `entire trail show <number> --json`. */
export interface TrailDetail extends TrailSummary {
  /** The trail's page on the web. The CLI asks callers to use this and not to build one. */
  url?: string;
  projectName?: string;
}

/** One entry of a change's timeline: a commit, a review, a resolved finding, and so on. */
export interface TrailEvent {
  kind: string;
  /** Who did it: a person's name or login, or the name of an agent. */
  actor?: string;
  occurredAt?: string;
  /** For a commit, its subject. */
  title?: string;
  commitSha?: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
  /** Checkpoints entire.io has for the commit. */
  checkpointCount?: number;
  agents: string[];
  findingCount?: number;
}

/** `entire trail timeline --json`, for one change of a trail. Newest first. */
export interface TrailTimeline {
  events: TrailEvent[];
  nextPageToken?: string;
  commitCount?: number;
  /** The CLI could not read the whole history of the branch. */
  incomplete: boolean;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : [];
}

function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

/** Copies only the defined entries, so optional fields stay absent instead of `undefined`. */
function compact<T extends object>(value: { [K in keyof T]: T[K] | undefined }): T {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = entry;
  }
  return out as T;
}

/** `entire auth status --json`, as far as the extension uses it. */
export interface AuthStatus {
  loggedIn: boolean;
  /** The account, such as `github:octocat`. */
  user?: string;
  displayName?: string;
}

export function readAuthStatus(value: unknown): AuthStatus | undefined {
  if (!isObject(value) || typeof value.logged_in !== 'boolean') return undefined;
  return compact<AuthStatus>({
    loggedIn: value.logged_in,
    user: str(value.user),
    displayName: str(value.display_name),
  });
}

/** The version that `entire graph version --json` reports, such as `v0.6.0`. */
export function readGraphVersion(value: unknown): string | undefined {
  return isObject(value) ? str(value.version) : undefined;
}

export function readStatus(value: unknown): StatusInfo | undefined {
  if (!isObject(value) || typeof value.enabled !== 'boolean') return undefined;
  return compact<StatusInfo>({
    enabled: value.enabled,
    error: str(value.error),
    agents: strings(value.agents),
    activeSessions: objects(value.active_sessions).map((session) =>
      compact<ActiveSession>({
        sessionId: str(session.session_id),
        agent: str(session.agent),
        model: str(session.model),
        status: str(session.status),
        branch: str(session.branch),
        worktreePath: str(session.worktree_path),
      }),
    ),
  });
}

export function readCheckpointRows(value: unknown): CheckpointRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: CheckpointRow[] = [];
  for (const item of objects(value)) {
    const checkpointId = str(item.checkpoint_id);
    if (!checkpointId) continue;
    const sessionId = str(item.session_id);
    const sessionIds = strings(item.session_ids);
    if (sessionId && !sessionIds.includes(sessionId)) sessionIds.unshift(sessionId);
    rows.push(
      compact<CheckpointRow>({
        checkpointId,
        sessionId,
        agent: str(item.agent),
        date: str(item.date),
        message: str(item.message),
        sessionIds,
        sessionCount: num(item.session_count),
      }),
    );
  }
  return rows;
}

function readTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isObject(value)) return undefined;
  return {
    input: num(value.input_tokens) ?? 0,
    cacheCreation: num(value.cache_creation_tokens) ?? 0,
    cacheRead: num(value.cache_read_tokens) ?? 0,
    output: num(value.output_tokens) ?? 0,
    apiCalls: num(value.api_call_count) ?? 0,
  };
}

function readSummary(value: unknown): SessionSummaryText | undefined {
  if (!isObject(value)) return undefined;
  const summary = compact<SessionSummaryText>({ intent: str(value.intent), outcome: str(value.outcome) });
  return summary.intent || summary.outcome ? summary : undefined;
}

export function readCheckpointDetail(value: unknown): CheckpointDetail | undefined {
  if (!isObject(value)) return undefined;
  const checkpointId = str(value.checkpoint_id);
  if (!checkpointId) return undefined;
  const sessions = objects(value.sessions).map((session, position) =>
    compact<CheckpointSession>({
      index: num(session.index) ?? position,
      sessionId: str(session.session_id),
      agent: str(session.agent),
      model: str(session.model),
      kind: str(session.kind),
      createdAt: str(session.created_at),
      filesTouched: strings(session.files_touched),
      tokenUsage: readTokenUsage(session.token_usage),
      summary: readSummary(session.summary),
    }),
  );
  const tasks: CheckpointTask[] = [];
  for (const task of objects(value.tasks)) {
    const toolUseId = str(task.tool_use_id);
    if (!toolUseId) continue;
    tasks.push(
      compact<CheckpointTask>({
        toolUseId,
        agentId: str(task.agent_id),
        subagentType: str(task.subagent_type),
        description: str(task.task_description),
        startedAt: str(task.started_at),
        completedAt: str(task.completed_at),
      }),
    );
  }
  return compact<CheckpointDetail>({
    checkpointId,
    branch: str(value.branch),
    promptCount: num(value.checkpoints_count),
    filesTouched: strings(value.files_touched),
    sessions,
    tasks,
    partial: value.partial === true,
  });
}

function readSessionTokens(value: unknown): SessionTokens | undefined {
  if (!isObject(value)) return undefined;
  return {
    total: num(value.total) ?? 0,
    input: num(value.input) ?? 0,
    cacheRead: num(value.cache_read) ?? 0,
    cacheWrite: num(value.cache_write) ?? 0,
    output: num(value.output) ?? 0,
  };
}

export function readSessionRows(value: unknown): SessionRow[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows: SessionRow[] = [];
  for (const item of objects(value)) {
    const sessionId = str(item.session_id);
    if (!sessionId) continue;
    rows.push(
      compact<SessionRow>({
        sessionId,
        agent: str(item.agent),
        model: str(item.model),
        status: str(item.status),
        kind: str(item.kind),
        startedAt: str(item.started_at),
        endedAt: str(item.ended_at),
        lastActive: str(item.last_active),
        turns: num(item.turns),
        pendingTurns: num(item.pending_turns),
        lastCheckpointId: str(item.last_checkpoint_id),
        tokens: readSessionTokens(item.tokens),
        lastPrompt: str(item.last_prompt),
      }),
    );
  }
  return rows;
}

/** Names from a list whose entries are strings or objects with a `name`. */
function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const name = isObject(item) ? (str(item.name) ?? str(item.label)) : str(item);
    if (name) out.push(name);
  }
  return out;
}

function readMergeability(value: unknown): TrailMergeability | undefined {
  if (!isObject(value)) return undefined;
  const checks = isObject(value.checks) ? value.checks : {};
  const runs: TrailCheckRun[] = [];
  for (const run of objects(checks.runs)) {
    const name = str(run.name);
    if (!name) continue;
    runs.push(
      compact<TrailCheckRun>({
        name,
        status: str(run.status),
        conclusion: str(run.conclusion),
        detailsUrl: str(run.details_url),
        appName: str(run.app_name),
      }),
    );
  }
  const gates: TrailGate[] = [];
  for (const gate of objects(value.gates)) {
    const key = str(gate.gate_key) ?? str(gate.gate_type);
    if (!key) continue;
    gates.push(
      compact<TrailGate>({
        key,
        blocking: gate.blocking === true,
        status: str(gate.status),
        rationale: str(gate.rationale),
        findingCount: num(gate.finding_count),
      }),
    );
  }
  return compact<TrailMergeability>({
    mergeable: value.mergeable === true,
    headSha: str(value.head_sha),
    conflictStatus: str(value.conflict_status),
    checksAvailability: str(checks.availability),
    checks: runs,
    gates,
  });
}

function readTrailChanges(value: unknown): TrailChange[] {
  const changes: TrailChange[] = [];
  for (const change of objects(value)) {
    const repository = str(change.repository);
    const number = num(change.number);
    if (!repository || number === undefined) continue;
    changes.push(
      compact<TrailChange>({
        repository,
        number,
        title: str(change.title),
        status: str(change.status),
        branch: str(change.branch),
        base: str(change.base),
        hasCodeChanges: change.hasCodeChanges === true,
        updatedAt: str(change.updatedAt),
        url: str(change.url),
        mergeability: readMergeability(change.mergeability),
      }),
    );
  }
  return changes;
}

function readTrailSummary(item: Json): TrailSummary | undefined {
  const number = num(item.number);
  if (number === undefined) return undefined;
  return compact<TrailSummary>({
    number,
    // Kept only in the form the CLI is known to accept. Without it, calls name the trail by number.
    id: isTrailId(item.id) ? item.id : undefined,
    title: str(item.title) ?? `Trail ${number}`,
    body: str(item.body),
    status: str(item.status),
    phase: str(item.phase),
    type: str(item.type),
    priority: str(item.priority),
    assignees: strings(item.assignees),
    createdAt: str(item.createdAt),
    lastActivityAt: str(item.lastActivityAt) ?? str(item.updatedAt),
    closedAt: str(item.closedAt),
    changes: readTrailChanges(item.changes),
  });
}

export function readTrailPage(value: unknown): TrailPage | undefined {
  if (!isObject(value) || !Array.isArray(value.items)) return undefined;
  const trails: TrailSummary[] = [];
  for (const item of objects(value.items)) {
    const trail = readTrailSummary(item);
    if (trail) trails.push(trail);
  }
  // The CLI reports one total per group, and one group when the list is not grouped.
  const groups = objects(value.groupTotals).length > 0 ? objects(value.groupTotals) : objects(value.groups);
  const totals = groups.map((group) => num(group.totalCount)).filter((count) => count !== undefined);
  return compact<TrailPage>({
    trails,
    nextPageToken: str(value.nextPageToken),
    total: totals.length > 0 ? totals.reduce((sum, count) => sum + count, 0) : undefined,
  });
}

export function readTrailDetail(value: unknown): TrailDetail | undefined {
  if (!isObject(value)) return undefined;
  const summary = readTrailSummary(value);
  if (!summary) return undefined;
  const project = isObject(value.project) ? value.project : {};
  return compact<TrailDetail>({ ...summary, url: str(value.url), projectName: str(project.name) });
}

function readActor(value: unknown): string | undefined {
  if (!isObject(value)) return undefined;
  const identity = isObject(value.identity) ? value.identity : {};
  return str(identity.display_name) ?? str(value.label) ?? str(value.login);
}

export function readTrailTimeline(value: unknown): TrailTimeline | undefined {
  if (!isObject(value) || !Array.isArray(value.items)) return undefined;
  const events: TrailEvent[] = [];
  for (const item of objects(value.items)) {
    const kind = str(item.kind);
    if (!kind) continue;
    events.push(
      compact<TrailEvent>({
        kind,
        actor: readActor(item.actor),
        occurredAt: str(item.occurredAt),
        title: str(item.title),
        commitSha: str(item.commitSha),
        additions: num(item.additions),
        deletions: num(item.deletions),
        filesChanged: num(item.filesChanged),
        checkpointCount: num(item.checkpointCount),
        agents: names(item.agents),
        findingCount: num(item.findingCount),
      }),
    );
  }
  return compact<TrailTimeline>({
    events,
    nextPageToken: str(value.nextPageToken),
    commitCount: num(value.commitCount),
    incomplete: value.incomplete === true,
  });
}

/** Total tokens for a checkpoint session, counting cache reads and writes. */
export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheCreation + usage.cacheRead + usage.output;
}
