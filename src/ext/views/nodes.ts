import * as vscode from 'vscode';
import { formatPosition, formatTokens, headline, joinParts, relativeTime } from '../../core/format';
import type { SessionPosition } from '../../core/checkpointIndex';
import { totalTokens, type CheckpointRow, type CheckpointSession, type TrailSummary } from '../../core/schemas';
import type { CommitRecord } from '../../core/trailers';
import { isCheckedOut, primaryChange } from '../../core/trails';
import type { DetailTarget, TrailTarget } from '../../shared/protocol';
import type { RepoContext, SessionEntry } from '../repoManager';

export type Node =
  | { kind: 'repo'; repo: RepoContext }
  | { kind: 'commit'; repo: RepoContext; commit: CommitRecord }
  | {
      kind: 'checkpoint';
      repo: RepoContext;
      checkpointId: string;
      commit?: CommitRecord;
      row?: CheckpointRow;
      /** Preselects this session when the checkpoint opens from the Sessions view. */
      sessionId?: string;
      /**
       * Where the checkpoint sits in that session, when the row's list knows
       * it better than the clone does: a list that Entire supplied.
       */
      position?: SessionPosition;
      parentId: string;
    }
  | {
      kind: 'slot';
      repo: RepoContext;
      checkpointId: string;
      commit?: CommitRecord;
      session: CheckpointSession;
      parentId: string;
    }
  | {
      kind: 'loadMore';
      repo: RepoContext;
      /** The list this row extends. See `LISTS`. */
      list: string;
      noun: ListNoun;
      shown: number;
      /** Absent when more can still be read than is known so far. */
      total?: number;
      /**
       * For a list that shows only some of what its source lists: how much of
       * the source has been read to find the rows shown.
       */
      scanned?: { read: number; total?: number };
    }
  | { kind: 'otherGroup'; repo: RepoContext }
  | { kind: 'sessionGroup'; repo: RepoContext; group: 'active' | 'recent' }
  | { kind: 'session'; repo: RepoContext; session: SessionEntry }
  | { kind: 'trail'; repo: RepoContext; trail: TrailSummary }
  | { kind: 'message'; id: string; text: string };

/** What a list holds, for the label of its Load More row. */
export type ListNoun = 'Checkpoints' | 'Sessions' | 'Trails';

export function nodeId(node: Node): string {
  switch (node.kind) {
    case 'repo':
      return `${node.repo.root}|repo`;
    case 'commit':
      return `${node.repo.root}|commit:${node.commit.sha}`;
    case 'checkpoint':
      return `${node.parentId}|cp:${node.checkpointId}`;
    case 'slot':
      return `${node.parentId}|slot:${node.session.index}`;
    case 'loadMore':
      return `${node.repo.root}|more:${node.list}`;
    case 'otherGroup':
      return `${node.repo.root}|other`;
    case 'sessionGroup':
      return `${node.repo.root}|group:${node.group}`;
    case 'session':
      return `${node.repo.root}|session:${node.session.sessionId}`;
    case 'trail':
      return `${node.repo.root}|trail:${node.trail.number}`;
    case 'message':
      return node.id;
  }
}

/**
 * The rows of a list that are currently shown, followed by a Load More row
 * when there are more.
 */
export function paged<T>(
  repo: RepoContext,
  list: string,
  noun: ListNoun,
  items: readonly T[],
  toNode: (item: T) => Node,
  options: PagedOptions = {},
): Node[] {
  const { moreToRead = false, sourceTotal, scanned } = options;
  const nodes = items.slice(0, repo.limit(list)).map(toNode);
  if (items.length > nodes.length || moreToRead) {
    // A total the source reported earlier can fall behind the rows read since.
    const total = moreToRead ? (sourceTotal !== undefined && sourceTotal > nodes.length ? sourceTotal : undefined) : items.length;
    nodes.push({
      kind: 'loadMore',
      repo,
      list,
      noun,
      shown: nodes.length,
      ...(total === undefined ? {} : { total }),
      ...(scanned && moreToRead ? { scanned } : {}),
    });
  }
  return nodes;
}

export interface PagedOptions {
  /** The list's source can still produce rows beyond `items`, so the total is not known from them. */
  moreToRead?: boolean;
  /** The total the source reports, for a list whose source knows it. */
  sourceTotal?: number;
  /** For a list that keeps only some of what its source lists: how far the source has been read. */
  scanned?: { read: number; total?: number };
}

export const LOAD_MORE_SCHEME = 'entire-more';

/**
 * A URI that stands for one Load More row: its repository, its list, and how
 * many rows the list showed when the row was made. The count makes the URI
 * new each time the list grows, so the editor asks about each row once.
 */
export function loadMoreUri(node: Extract<Node, { kind: 'loadMore' }>): vscode.Uri {
  return vscode.Uri.from({
    scheme: LOAD_MORE_SCHEME,
    path: `/${node.list}`,
    query: JSON.stringify({ root: node.repo.root, list: node.list, limit: node.repo.limit(node.list) }),
  });
}

export function readLoadMoreUri(uri: vscode.Uri): { root: string; list: string; limit: number } | undefined {
  try {
    const value: unknown = JSON.parse(uri.query);
    if (typeof value !== 'object' || value === null) return undefined;
    const { root, list, limit } = value as Record<string, unknown>;
    if (typeof root !== 'string' || typeof list !== 'string' || typeof limit !== 'number') return undefined;
    return { root, list, limit };
  } catch {
    return undefined;
  }
}

/** How many sessions a checkpoint holds, as far as the CLI's row says. Zero when there is no row. */
function sessionCount(row: CheckpointRow | undefined): number {
  return row ? (row.sessionCount ?? row.sessionIds.length) : 0;
}

/** "12 of 249": where a checkpoint sits among the checkpoints of a session. */
function positionText(repo: RepoContext, sessionId: string | undefined, checkpointId: string): string | undefined {
  const position = sessionId ? repo.index?.position(sessionId, checkpointId) : undefined;
  return position ? formatPosition(position) : undefined;
}

/**
 * How many checkpoints a session has. For a session that Entire lists it is
 * Entire's count, as on entire.com, unless the clone knows of more. Once
 * Entire's list of the session's checkpoints has been read, it is the number
 * in that list, which is what the session's page on entire.com shows and can
 * be fewer than the count.
 */
function checkpointCount(session: SessionEntry): number {
  if (session.checkpointsFromEntire) return session.checkpoints.length;
  return Math.max(session.listedCheckpoints ?? 0, session.checkpoints.length);
}

/** "36 checkpoints", with a plus when the clone may not know them all and Entire has not counted them. */
function checkpointCountText(session: SessionEntry): string | undefined {
  const count = checkpointCount(session);
  if (count === 0) return undefined;
  const open = session.listedCheckpoints === undefined && session.mayHaveEarlier ? '+' : '';
  return `${count.toLocaleString('en-US')}${open} ${count === 1 ? 'checkpoint' : 'checkpoints'}`;
}

const NO_DATA = 'no session data';
const NO_DATA_TOOLTIP =
  "Entire has no session data for this checkpoint. The commit records the checkpoint's ID, but the data is uploaded separately, and this checkpoint's was not found on this machine or on the remote.";

/** An icon in the muted color, for a row that stands for something that is not there. */
function muted(icon: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(icon, new vscode.ThemeColor('disabledForeground'));
}

/** The single checkpoint a commit row stands for, when it carries exactly one. */
function soleCheckpoint(commit: CommitRecord): string | undefined {
  return commit.checkpointIds.length === 1 ? commit.checkpointIds[0] : undefined;
}

export function detailTarget(node: Node): DetailTarget | undefined {
  switch (node.kind) {
    case 'commit': {
      const checkpointId = soleCheckpoint(node.commit);
      return checkpointId
        ? { repoRoot: node.repo.root, mode: 'checkpoint', checkpointId, commitSha: node.commit.sha }
        : undefined;
    }
    case 'checkpoint':
      return {
        repoRoot: node.repo.root,
        mode: 'checkpoint',
        checkpointId: node.checkpointId,
        ...(node.commit ? { commitSha: node.commit.sha } : {}),
        ...(node.sessionId ? { sessionId: node.sessionId } : {}),
      };
    case 'slot':
      return {
        repoRoot: node.repo.root,
        mode: 'checkpoint',
        checkpointId: node.checkpointId,
        ...(node.commit ? { commitSha: node.commit.sha } : {}),
        ...(node.session.sessionId ? { sessionId: node.session.sessionId } : {}),
      };
    case 'session':
      return { repoRoot: node.repo.root, mode: 'session', sessionId: node.session.sessionId };
    default:
      return undefined;
  }
}

/** The two views whose rows open the detail panel. */
export type DetailView = 'checkpoints' | 'sessions';

/** The view a row that opens the detail panel is in. A row's ID starts with its session's when it is under one. */
export function detailViewOf(node: Node): DetailView | undefined {
  switch (node.kind) {
    case 'session':
      return 'sessions';
    case 'commit':
      return 'checkpoints';
    case 'checkpoint':
    case 'slot':
      return node.parentId.startsWith(`${node.repo.root}|session:`) ? 'sessions' : 'checkpoints';
    default:
      return undefined;
  }
}

/**
 * Whether a row is the one to have selected while a detail tab shows
 * `target`. A session row stands for its session, as opened from that row. A
 * commit row stands for its only checkpoint. A row that names a session, such
 * as a session of a checkpoint that holds several, stands for the checkpoint
 * in that session only.
 */
export function standsFor(node: Node, target: DetailTarget): boolean {
  if (node.kind === 'message' || node.repo.root !== target.repoRoot) return false;
  if (target.mode === 'session') return node.kind === 'session' && node.session.sessionId === target.sessionId;
  if (node.kind !== 'commit' && node.kind !== 'checkpoint' && node.kind !== 'slot') return false;
  const facts = nodeFacts(node);
  if (!target.checkpointId || facts.checkpointId !== target.checkpointId) return false;
  if (target.commitSha && facts.commitSha && facts.commitSha !== target.commitSha) return false;
  const named = node.kind === 'slot' ? node.session.sessionId : node.kind === 'checkpoint' ? node.sessionId : undefined;
  return !named || !target.sessionId || named === target.sessionId;
}

/** What the trail panel opens on, for a trail row. */
export function trailTarget(node: Node): TrailTarget | undefined {
  if (node.kind !== 'trail') return undefined;
  const target: TrailTarget = { repoRoot: node.repo.root, mode: 'trail', trail: node.trail.number };
  if (node.trail.id) target.id = node.trail.id;
  return target;
}

export interface NodeFacts {
  repo?: RepoContext;
  commitSha?: string;
  checkpointId?: string;
  sessionId?: string;
  /** Session slot inside the checkpoint, for the raw transcript. */
  sessionIndex?: number;
}

/** The identifiers a row carries, which decide the commands it offers. */
export function nodeFacts(node: Node): NodeFacts {
  switch (node.kind) {
    case 'commit': {
      const checkpointId = soleCheckpoint(node.commit);
      const row = checkpointId ? node.repo.index?.row(checkpointId) : undefined;
      return {
        repo: node.repo,
        commitSha: node.commit.sha,
        ...(checkpointId ? { checkpointId } : {}),
        ...(row?.sessionId ? { sessionId: row.sessionId } : {}),
        // The only session of a checkpoint is in its first slot.
        ...(sessionCount(row) === 1 ? { sessionIndex: 0 } : {}),
      };
    }
    case 'checkpoint': {
      const sessionId = node.sessionId ?? node.row?.sessionId;
      return {
        repo: node.repo,
        checkpointId: node.checkpointId,
        ...(node.commit ? { commitSha: node.commit.sha } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(sessionCount(node.row) === 1 ? { sessionIndex: 0 } : {}),
      };
    }
    case 'slot':
      return {
        repo: node.repo,
        checkpointId: node.checkpointId,
        sessionIndex: node.session.index,
        ...(node.commit ? { commitSha: node.commit.sha } : {}),
        ...(node.session.sessionId ? { sessionId: node.session.sessionId } : {}),
      };
    case 'session':
      return { repo: node.repo, sessionId: node.session.sessionId };
    case 'repo':
    case 'loadMore':
    case 'otherGroup':
    case 'sessionGroup':
    case 'trail':
      return { repo: node.repo };
    case 'message':
      return {};
  }
}

/** Space-separated flags that `when` clauses in package.json match on. */
function contextValue(node: Node, extra: string[] = []): string {
  const facts = nodeFacts(node);
  const flags = [node.kind, ...extra];
  if (facts.commitSha) flags.push('hasCommit');
  if (facts.checkpointId) flags.push('hasCheckpoint');
  if (facts.sessionId) flags.push('hasSession');
  if (facts.checkpointId && facts.sessionIndex !== undefined) flags.push('hasTranscript');
  // A web page exists for a commit or a session, and only for repos that Entire hosts.
  if (facts.repo?.entireRepo && (facts.commitSha || facts.sessionId)) flags.push('web');
  return flags.join(' ');
}

function openCommand(node: Node): vscode.Command {
  return { command: 'entire.openDetail', title: 'Open', arguments: [node] };
}

function markdown(lines: (string | undefined)[]): vscode.MarkdownString {
  const text = new vscode.MarkdownString(lines.filter((line) => line !== undefined).join('\n\n'));
  text.supportHtml = false;
  text.isTrusted = false;
  return text;
}

/** Escapes text that goes into a Markdown tooltip. */
function plain(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, '\\$&');
}

/** Tooltip lines that name a checkpoint's session and say where the checkpoint sits in it. */
function sessionPlace(
  repo: RepoContext,
  sessionId: string | undefined,
  checkpointId: string,
  known?: SessionPosition,
): string[] {
  const position = known ?? (sessionId ? repo.index?.position(sessionId, checkpointId) : undefined);
  if (!sessionId || !position) return [];
  return [
    `Session \`${sessionId}\``,
    position.mayHaveEarlier
      ? `Checkpoint ${formatPosition(position)} of this session. The Entire CLI lists the checkpoints of the newest 500 commits on this branch, so this session may have earlier ones.`
      : `Checkpoint ${formatPosition(position)} of this session.`,
  ];
}

/**
 * The hover text of a row, built when the row is hovered and not before. A
 * list redraws every row each time it grows, and most rows are never hovered.
 */
export function tooltip(node: Node): vscode.MarkdownString | undefined {
  switch (node.kind) {
    case 'commit': {
      const { commit, repo } = node;
      const sole = soleCheckpoint(commit);
      const row = sole ? repo.index?.row(sole) : undefined;
      const place = sole && sessionCount(row) === 1 ? sessionPlace(repo, row?.sessionId, sole) : [];
      return markdown([
        `**${plain(commit.subject)}**`,
        `Commit \`${commit.sha}\``,
        `${plain(commit.author)}, ${new Date(commit.authorTime * 1000).toLocaleString()}`,
        ...commit.checkpointIds.map((id) => `Checkpoint \`${id}\``),
        ...place,
        sole && repo.withoutData.has(sole) ? NO_DATA_TOOLTIP : undefined,
      ]);
    }

    case 'checkpoint': {
      const { row, commit } = node;
      const within = node.sessionId ?? (sessionCount(row) === 1 ? row?.sessionId : undefined);
      return markdown([
        row?.message ? `**${plain(headline(row.message, 200))}**` : undefined,
        `Checkpoint \`${node.checkpointId}\``,
        commit ? `Commit \`${commit.sha}\`` : 'No commit on this branch carries this checkpoint.',
        row?.date ? new Date(row.date).toLocaleString() : undefined,
        ...sessionPlace(node.repo, within, node.checkpointId, node.position),
        node.repo.withoutData.has(node.checkpointId) ? NO_DATA_TOOLTIP : undefined,
      ]);
    }

    case 'slot': {
      const { session } = node;
      return markdown([
        session.summary?.intent ? `**${plain(headline(session.summary.intent, 200))}**` : undefined,
        session.sessionId ? `Session \`${session.sessionId}\`` : undefined,
        session.createdAt ? new Date(session.createdAt).toLocaleString() : undefined,
        session.filesTouched.length > 0 ? `${session.filesTouched.length} files touched` : undefined,
        session.tokenUsage
          ? `${totalTokens(session.tokenUsage).toLocaleString()} tokens since the previous checkpoint`
          : undefined,
      ]);
    }

    case 'session': {
      const { session } = node;
      const tokens = session.local?.tokens?.total;
      const named = session.name ?? session.lastPrompt ?? session.title;
      return markdown([
        named ? `**${plain(headline(named, 200))}**` : undefined,
        session.opening ? `Opening prompt: ${plain(headline(session.opening, 200))}` : undefined,
        // A session that is still going has moved on from the prompt that opened it.
        session.name && session.lastPrompt && session.lastPrompt !== session.name && session.lastPrompt !== session.opening
          ? `Latest prompt: ${plain(headline(session.lastPrompt, 200))}`
          : undefined,
        `Session \`${session.sessionId}\``,
        joinParts(session.agent, session.model, session.status) || undefined,
        session.branch ? `Branch ${plain(session.branch)}` : undefined,
        session.local?.turns !== undefined ? `${session.local.turns} turns` : undefined,
        tokens !== undefined ? `${tokens.toLocaleString()} tokens` : undefined,
        session.lastActive ? `Last active ${new Date(session.lastActive).toLocaleString()}` : undefined,
        checkpointCountText(session) ?? 'No checkpoints',
      ]);
    }

    case 'trail': {
      const { trail, repo } = node;
      const hosted = repo.entireRepo;
      const state = joinParts(trail.phase ?? trail.status, trail.type, trail.priority === 'none' ? undefined : trail.priority);
      return markdown([
        `**${plain(headline(trail.title, 200))}**`,
        `Trail ${trail.number}${state ? `, ${plain(state)}` : ''}`,
        ...trail.changes.map((change) => {
          const branch = change.branch ? `\`${change.branch}\`` : 'no branch';
          const into = change.base ? ` into \`${change.base}\`` : '';
          const here = hosted && isCheckedOut(change, hosted, repo.branch) ? ', checked out here' : '';
          return `${plain(change.repository)} ${change.number}: ${branch}${into}${here}`;
        }),
        trail.assignees.length > 0 ? `Assigned to ${plain(trail.assignees.join(', '))}` : undefined,
        trail.lastActivityAt ? `Last activity ${new Date(trail.lastActivityAt).toLocaleString()}` : undefined,
      ]);
    }

    default:
      return undefined;
  }
}

/** The icon of a trail row, which follows the trail's phase. */
function trailIcon(trail: TrailSummary, checkedOut: boolean): vscode.ThemeIcon {
  if (trail.status === 'closed' || trail.phase === 'closed') return muted('git-pull-request-closed');
  const icon =
    trail.phase === 'complete' ? 'pass' : trail.phase === 'planning' ? 'git-pull-request-draft' : 'git-pull-request';
  return checkedOut ? new vscode.ThemeIcon(icon, new vscode.ThemeColor('charts.green')) : new vscode.ThemeIcon(icon);
}

export function treeItem(node: Node): vscode.TreeItem {
  const item = buildItem(node);
  item.id = nodeId(node);
  return item;
}

function buildItem(node: Node): vscode.TreeItem {
  switch (node.kind) {
    case 'repo': {
      const item = new vscode.TreeItem(node.repo.name, vscode.TreeItemCollapsibleState.Expanded);
      item.description = node.repo.branch ?? '';
      item.iconPath = new vscode.ThemeIcon('repo');
      item.tooltip = node.repo.root;
      item.contextValue = 'repo';
      return item;
    }

    case 'commit': {
      const { commit, repo } = node;
      const sole = soleCheckpoint(commit);
      const row = sole ? repo.index?.row(sole) : undefined;
      const sessions = sessionCount(row);
      const noData = sole !== undefined && repo.withoutData.has(sole);
      // Rows under a commit exist to tell things apart: its checkpoints when
      // it carries several, or its sessions when its checkpoint holds several.
      // A checkpoint with one session has neither, and the commit row stands
      // for it. Otherwise one long session would appear as a row of its own
      // under every commit it touched.
      const item = new vscode.TreeItem(
        commit.subject || '(no subject)',
        !sole || sessions > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = joinParts(
        commit.shortSha,
        noData
          ? NO_DATA
          : !sole
            ? `${commit.checkpointIds.length} checkpoints`
            : sessions > 1
              ? `${sessions} sessions`
              : row?.agent,
        sole && sessions === 1 ? positionText(repo, row?.sessionId, sole) : undefined,
        relativeTime(commit.authorTime * 1000),
      );
      item.iconPath = noData ? muted('git-commit') : new vscode.ThemeIcon('git-commit');
      // A commit with one checkpoint opens it. A commit with several expands instead.
      if (sole) item.command = openCommand(node);
      item.contextValue = contextValue(node, sole ? ['openable'] : []);
      return item;
    }

    case 'checkpoint': {
      const { row, commit } = node;
      const sessions = sessionCount(row);
      // Under a session, the place is in that session. Elsewhere it is in the
      // checkpoint's own session, when it has exactly one.
      const within = node.sessionId ?? (sessions === 1 ? row?.sessionId : undefined);
      // A ULID is never shortened: sibling IDs share their leading characters.
      const item = new vscode.TreeItem(
        headline(row?.message) || node.checkpointId,
        sessions > 1 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      const noData = node.repo.withoutData.has(node.checkpointId);
      item.description = joinParts(
        noData ? NO_DATA : node.sessionId ? undefined : sessions > 1 ? `${sessions} sessions` : row?.agent,
        node.position ? formatPosition(node.position) : positionText(node.repo, within, node.checkpointId),
        relativeTime(row?.date),
        commit?.shortSha,
      );
      item.iconPath = noData ? muted('bookmark') : new vscode.ThemeIcon('bookmark');
      item.command = openCommand(node);
      item.contextValue = contextValue(node, ['openable']);
      return item;
    }

    case 'slot': {
      const { session } = node;
      const item = new vscode.TreeItem(
        joinParts(session.agent ?? 'Agent session', session.model),
        vscode.TreeItemCollapsibleState.None,
      );
      item.description = joinParts(
        positionText(node.repo, session.sessionId, node.checkpointId),
        session.tokenUsage ? `${formatTokens(totalTokens(session.tokenUsage))} tokens` : undefined,
      );
      item.iconPath = new vscode.ThemeIcon('comment-discussion');
      item.command = openCommand(node);
      item.contextValue = contextValue(node, ['openable']);
      return item;
    }

    case 'loadMore': {
      const item = new vscode.TreeItem(`Load More ${node.noun}`, vscode.TreeItemCollapsibleState.None);
      const shown = node.shown.toLocaleString();
      item.description = node.scanned
        ? // A filtered list cannot say how many rows are left, only how far it has looked.
          `${shown} shown · ${node.scanned.read.toLocaleString()}${
            node.scanned.total === undefined ? '' : ` of ${node.scanned.total.toLocaleString()}`
          } read`
        : node.total === undefined
          ? `${shown} shown`
          : `${shown} of ${node.total.toLocaleString()} shown`;
      item.iconPath = new vscode.ThemeIcon('fold-down');
      item.command = { command: 'entire.loadMore', title: 'Load More', arguments: [node] };
      // The URI is how the extension learns that this row has scrolled into view.
      item.resourceUri = loadMoreUri(node);
      item.tooltip = 'More rows load when you scroll here. Click to load them now.';
      item.contextValue = 'loadMore';
      return item;
    }

    case 'otherGroup': {
      const count = node.repo.index?.unlinkedRows().length ?? 0;
      const item = new vscode.TreeItem('Other Checkpoints', vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(count);
      item.iconPath = new vscode.ThemeIcon('archive');
      item.tooltip =
        'Checkpoints that no scanned commit on this branch carries, such as imported checkpoints and checkpoints from other branches.';
      item.contextValue = 'otherGroup';
      return item;
    }

    case 'sessionGroup': {
      const item = new vscode.TreeItem(
        node.group === 'active' ? 'Active' : 'Recent',
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = 'sessionGroup';
      return item;
    }

    case 'session': {
      const { session } = node;
      const live = session.status === 'active' || session.status === 'idle';
      // The name is the one entire.com shows, for a session that Entire lists,
      // and otherwise the prompt that opened the session. Until either is
      // known, the row falls back to the latest prompt or to the newest
      // checkpoint's message.
      const item = new vscode.TreeItem(
        headline(session.name ?? session.lastPrompt ?? session.title) || `${session.agent ?? 'Agent'} session`,
        checkpointCount(session) > 0 ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
      );
      item.description = joinParts(
        session.agent,
        live ? session.status : undefined,
        checkpointCountText(session),
        relativeTime(session.lastActive),
      );
      item.iconPath =
        session.status === 'active'
          ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
          : session.status === 'idle'
            ? new vscode.ThemeIcon('circle-outline')
            : new vscode.ThemeIcon('comment-discussion');
      item.command = openCommand(node);
      item.contextValue = contextValue(node, ['openable', 'hasTranscript']);
      return item;
    }

    case 'trail': {
      const { trail, repo } = node;
      const hosted = repo.entireRepo;
      // A trail can have a branch in several repositories. The row describes the one here.
      const change = hosted ? trail.changes[primaryChange(trail.changes, hosted, repo.branch)] : undefined;
      const checkedOut = change !== undefined && hosted !== undefined && isCheckedOut(change, hosted, repo.branch);
      const item = new vscode.TreeItem(headline(trail.title) || `Trail ${trail.number}`, vscode.TreeItemCollapsibleState.None);
      item.description = joinParts(
        `#${trail.number}`,
        trail.phase ?? trail.status,
        change?.branch ? (checkedOut ? `${change.branch} (checked out)` : change.branch) : undefined,
        relativeTime(trail.lastActivityAt),
      );
      item.iconPath = trailIcon(trail, checkedOut);
      item.command = openCommand(node);
      // Trails are listed only for repositories that Entire hosts, so each has a page on the web.
      item.contextValue = contextValue(node, ['openable', 'web']);
      return item;
    }

    case 'message': {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon('info');
      item.contextValue = 'message';
      return item;
    }
  }
}
