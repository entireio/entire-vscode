import { BRAIN_VIZ_ARGS, isPluginMissing, parseVizUrl, readBrainStatus, type BrainStatus } from './brain';
import { parseCliVersion, type CliVersion } from './cliLocator';
import { fail, ok, type Failure, type Result } from './errors';
import type { Exec, ExecResult } from './exec';
import type { Lane, Priority } from './scheduler';
import {
  readRemoteCheckpoints,
  readRemoteSessionPage,
  remoteRefusal,
  remoteSessionCheckpointsPath,
  remoteSessionsPath,
  type RemoteCheckpoint,
  type RemoteSessionPage,
} from './remoteSessions';
import { readSearchPage, searchQuery, type SearchPage } from './search';
import { startServer, type RunningServer, type StartServer } from './serverProcess';
import {
  readAuthStatus,
  readCheckpointDetail,
  readCheckpointRows,
  readGraphVersion,
  readSessionRows,
  readStatus,
  readTrailDetail,
  readTrailPage,
  readTrailTimeline,
  type AuthStatus,
  type CheckpointDetail,
  type CheckpointRow,
  type SessionRow,
  type StatusInfo,
  type TrailDetail,
  type TrailPage,
  type TrailTimeline,
} from './schemas';
import { isCheckpointId, isSessionId } from './trailers';
import { parseCheckpointAuthor } from './transcript/cliText';
import { isTrailId, type TimelineOf, type TrailListStatus, type TrailRef } from './trails';

interface RunOptions {
  timeoutMs: number;
  priority?: Priority;
  signal?: AbortSignal;
  maxBytes?: number;
  /** Stream stdout to this file instead of collecting it. */
  stdoutFile?: string;
  /** Share one process between identical calls. Only for calls that take no signal. */
  dedupe?: boolean;
}

/** Most text the CLI's rendered transcript view may return. Raw transcripts go to a file and have no limit. */
const TRANSCRIPT_MAX_BYTES = 64 * 1024 * 1024;
const RAW_TRANSCRIPT_TIMEOUT_MS = 180_000;

/** `entire brain viz` listens in well under a second. This leaves room for a slow disk. */
const BRAIN_VIZ_READY_MS = 20_000;
const NO_BRAIN_PLUGIN = 'The entire-brain plugin is not installed.';
const NO_GRAPH_PLUGIN = 'The Graph plugin is not installed.';

/** Entire's search service answers in about two seconds. */
const SEARCH_TIMEOUT_MS = 30_000;
/** `entire auth status` asks entire.io about the saved login. */
const AUTH_TIMEOUT_MS = 15_000;

/** Trail calls go to entire.io, so they wait on the network. */
const TRAIL_TIMEOUT_MS = 30_000;
/** An owner, project, or repository name. It cannot start with a dash, so it is never read as a flag. */
const NAME = '[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}';
const TRAIL_PROJECT = new RegExp(`^(gh|et)/${NAME}$`);
const TRAIL_REPO = new RegExp(`^(gh|et)/${NAME}/${NAME}$`);
const REPO_NAME = new RegExp(`^${NAME}$`);
/** Page tokens are opaque. This only keeps out whitespace and control characters. */
const PAGE_TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** Calls to Entire's API wait on the network, and on the CLI finding the repository's ID first. */
const API_TIMEOUT_MS = 30_000;
/** A session's checkpoints come with its transcript, which can be large. The CLI stops at 32 MiB itself. */
const API_TRANSCRIPT_TIMEOUT_MS = 60_000;
const API_TRANSCRIPT_MAX_BYTES = 48 * 1024 * 1024;

function isCount(value: number, max: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= max;
}

/** The argument that names a trail: its ID when the caller has it, which saves the CLI a lookup, or its number. */
function trailArg(trail: TrailRef): string | undefined {
  if (!isCount(trail.number, Number.MAX_SAFE_INTEGER)) return undefined;
  return trail.id !== undefined && isTrailId(trail.id) ? trail.id : String(trail.number);
}

/** The project and repository whose trails a call reads, as the CLI's `--project` and `--repo` arguments. */
export interface TrailScope {
  project: string;
  repo: string;
}

/**
 * Typed, read-only calls into the Entire CLI.
 *
 * Two calls have side effects inside the CLI itself. `explainCheckpoint` and
 * `listCheckpoints` can fetch checkpoint refs from the checkpoint remote, and
 * `sessionList` deletes session state files idle for more than seven days.
 * Callers keep `sessionList` out of automatic refresh for that reason.
 *
 * The trail calls read entire.io over the network with the login the CLI has
 * saved. Of the CLI's trail commands, only `list`, `show`, and `timeline`
 * are used here, and none of them writes.
 *
 * The session calls named `remote…` read Entire's API through `entire api`,
 * with the same login. They pass a path and nothing else, which makes the
 * CLI send a GET: no method, field, or body flag is ever given.
 *
 * The brain calls run the entire-brain plugin, which may not be installed.
 * `status` and `viz` read the brain from disk. The commands that install the
 * plugin, or build or refresh a brain, are not used here: the Setup view runs
 * those in a terminal, where the user sees them and answers their prompts.
 *
 * `search` asks Entire's search service, and `authStatus` asks entire.io
 * about the saved login. `graphVersion` only says whether the Graph plugin
 * is installed.
 */
export class EntireCli {
  constructor(
    readonly binPath: string,
    private readonly exec: Exec,
    private readonly lane: Lane,
    private readonly log: (line: string) => void = () => {},
    private readonly serve: StartServer = startServer,
  ) {}

  private run(cwd: string, args: string[], options: RunOptions): Promise<ExecResult> {
    const task = async (): Promise<ExecResult> => {
      const started = Date.now();
      const result = await this.exec(this.binPath, args, {
        cwd,
        timeoutMs: options.timeoutMs,
        env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
        ...(options.stdoutFile ? { stdoutFile: options.stdoutFile } : {}),
      });
      const outcome = result.aborted ? 'aborted' : result.timedOut ? 'timed out' : `exit ${result.code}`;
      this.log(`entire ${args.join(' ')} (${outcome}, ${Date.now() - started} ms)`);
      const stderr = result.stderr.trim();
      if (stderr) this.log(`  stderr: ${stderr.split('\n').slice(0, 6).join('\n          ')}`);
      return result;
    };
    return this.lane.run(task, {
      ...(options.priority ? { priority: options.priority } : {}),
      ...(options.dedupe ? { key: `${cwd}\x00${args.join('\x00')}` } : {}),
    });
  }

  async version(cwd: string): Promise<Result<CliVersion>> {
    const result = await this.run(cwd, ['version'], { timeoutMs: 5000 });
    const failure = processFailure(result, 'check the Entire CLI version');
    if (failure) return { ok: false, failure };
    const version = parseCliVersion(result.stdout.toString('utf8'));
    return version
      ? ok(version)
      : fail('unexpectedOutput', 'The Entire CLI did not report a version.', result.stdout.toString('utf8'));
  }

  /** Local only, with no side effects. Safe to call on every refresh. */
  async status(cwd: string): Promise<Result<StatusInfo>> {
    const result = await this.run(cwd, ['status', '--json'], { timeoutMs: 10_000, dedupe: true });
    return jsonResult(result, 'read the Entire status', readStatus);
  }

  /**
   * Rows for the current branch. Slow when the CLI has remote checkpoints to
   * fetch, so it runs at background priority and nothing should await it
   * before drawing.
   */
  async listCheckpoints(cwd: string, limit: number): Promise<Result<CheckpointRow[]>> {
    const result = await this.run(cwd, ['checkpoint', 'explain', '--json', '--limit', String(limit), '--no-pager'], {
      timeoutMs: 90_000,
      priority: 'background',
      dedupe: true,
    });
    return jsonResult(result, 'list checkpoints', readCheckpointRows);
  }

  async explainCheckpoint(cwd: string, checkpointId: string, signal?: AbortSignal): Promise<Result<CheckpointDetail>> {
    if (!isCheckpointId(checkpointId)) return fail('unexpectedOutput', 'That is not a checkpoint ID.');
    // --checkpoint forces the argument to be read as an ID. A 12-hex ID is
    // otherwise indistinguishable from a commit SHA prefix.
    const result = await this.run(cwd, ['checkpoint', 'explain', '--checkpoint', checkpointId, '--json', '--no-pager'], {
      timeoutMs: 45_000,
      ...(signal ? { signal } : {}),
    });
    return jsonResult(result, 'read the checkpoint', readCheckpointDetail);
  }

  /** The CLI's own text rendering. It covers only the latest session of the checkpoint. */
  async fullText(cwd: string, checkpointId: string, signal?: AbortSignal): Promise<Result<string>> {
    if (!isCheckpointId(checkpointId)) return fail('unexpectedOutput', 'That is not a checkpoint ID.');
    const result = await this.run(cwd, ['checkpoint', 'explain', '--checkpoint', checkpointId, '--full', '--no-pager'], {
      timeoutMs: 60_000,
      maxBytes: TRANSCRIPT_MAX_BYTES,
      ...(signal ? { signal } : {}),
    });
    const failure = processFailure(result, 'read the transcript');
    if (failure) return { ok: false, failure };
    return ok(result.stdout.toString('utf8'));
  }

  /**
   * Who the CLI names as the author of a checkpoint: the author of the commit
   * that carries it, or else of the commit that stored its data. Undefined
   * when the CLI names no one. The CLI's JSON leaves the author out, so this
   * reads the header of its short text view.
   */
  async checkpointAuthor(cwd: string, checkpointId: string, signal?: AbortSignal): Promise<Result<string | undefined>> {
    if (!isCheckpointId(checkpointId)) return fail('unexpectedOutput', 'That is not a checkpoint ID.');
    const result = await this.run(cwd, ['checkpoint', 'explain', '--checkpoint', checkpointId, '--short', '--no-pager'], {
      timeoutMs: 45_000,
      ...(signal ? { signal } : {}),
    });
    const failure = processFailure(result, 'read the checkpoint');
    if (failure) return { ok: false, failure };
    return ok(parseCheckpointAuthor(result.stdout.toString('utf8')));
  }

  /**
   * Writes the stored transcript, in the agent's own format, to `file` and
   * returns its size in bytes. It goes to a file because the transcript of one
   * long session can run to hundreds of megabytes.
   */
  async rawTranscript(
    cwd: string,
    checkpointId: string,
    sessionIndex: number,
    file: string,
    signal?: AbortSignal,
  ): Promise<Result<number>> {
    if (!isCheckpointId(checkpointId)) return fail('unexpectedOutput', 'That is not a checkpoint ID.');
    if (!Number.isInteger(sessionIndex) || sessionIndex < 0) {
      return fail('unexpectedOutput', 'That is not a session index.');
    }
    const result = await this.run(
      cwd,
      [
        'checkpoint',
        'explain',
        '--checkpoint',
        checkpointId,
        '--transcript',
        '--session-index',
        String(sessionIndex),
        '--no-pager',
      ],
      { timeoutMs: RAW_TRANSCRIPT_TIMEOUT_MS, stdoutFile: file, ...(signal ? { signal } : {}) },
    );
    const failure = processFailure(result, 'read the raw transcript');
    if (failure) return { ok: false, failure };
    return ok(result.bytes);
  }

  /** Has a side effect in the CLI: it prunes session state idle for more than seven days. */
  async sessionList(cwd: string): Promise<Result<SessionRow[]>> {
    const result = await this.run(cwd, ['session', 'list', '--json'], { timeoutMs: 15_000, dedupe: true });
    return jsonResult(result, 'list sessions', readSessionRows);
  }

  /**
   * Writes the live transcript of a local session, in the agent's own format,
   * to `file` and returns its size in bytes.
   */
  async sessionRawTranscript(
    cwd: string,
    sessionId: string,
    file: string,
    signal?: AbortSignal,
  ): Promise<Result<number>> {
    if (!isSessionId(sessionId)) return fail('unexpectedOutput', 'That is not a session ID.');
    const result = await this.run(cwd, ['session', 'info', sessionId, '--transcript'], {
      timeoutMs: RAW_TRANSCRIPT_TIMEOUT_MS,
      stdoutFile: file,
      ...(signal ? { signal } : {}),
    });
    const failure = processFailure(result, 'read the session transcript');
    if (failure) return { ok: false, failure };
    return ok(result.bytes);
  }

  /**
   * One page of the repository's sessions as Entire lists them, on every
   * branch, most recent activity first. This is the list on the Sessions
   * page of entire.com, with the name Entire gave each session.
   *
   * The CLI works out which repository from the `origin` remote, and reads
   * the cell that hosts it.
   */
  async remoteSessions(cwd: string, limit: number, cursor?: string): Promise<Result<RemoteSessionPage>> {
    if (!isCount(limit, 200)) return fail('unexpectedOutput', 'That is not a page size.');
    if (cursor !== undefined && !PAGE_TOKEN.test(cursor)) return fail('unexpectedOutput', 'That is not a page token.');
    const result = await this.run(cwd, ['api', '--to', 'cell', remoteSessionsPath(limit, cursor)], {
      timeoutMs: API_TIMEOUT_MS,
      dedupe: true,
    });
    return apiResult(result, 'list the sessions on Entire', readRemoteSessionPage, {
      notFound: 'Entire does not list sessions for this repository.',
    });
  }

  /**
   * The checkpoints of one session as its page on entire.com lists them,
   * newest first. Entire sends them with the session's transcript, so this
   * is a slow call for a long session.
   */
  async remoteSessionCheckpoints(cwd: string, sessionId: string, signal?: AbortSignal): Promise<Result<RemoteCheckpoint[]>> {
    if (!isSessionId(sessionId)) return fail('unexpectedOutput', 'That is not a session ID.');
    const result = await this.run(cwd, ['api', '--to', 'cell', remoteSessionCheckpointsPath(sessionId)], {
      timeoutMs: API_TRANSCRIPT_TIMEOUT_MS,
      maxBytes: API_TRANSCRIPT_MAX_BYTES,
      ...(signal ? { signal } : { dedupe: true }),
    });
    return apiResult(result, 'list the checkpoints of the session on Entire', readRemoteCheckpoints, {
      notFound: 'Entire could not find this session.',
    });
  }

  /**
   * Searches the repository's checkpoints, commits, and sessions with
   * Entire's search service, best match first. The query goes after `--`,
   * so nothing in it is read as a flag. The CLI scopes the search to the
   * repository of the `origin` remote of `cwd`.
   */
  async search(cwd: string, query: string, limit: number, signal?: AbortSignal): Promise<Result<SearchPage>> {
    const text = searchQuery(query);
    if (text === undefined) return fail('unexpectedOutput', 'That is not a search query.');
    if (!isCount(limit, 100)) return fail('unexpectedOutput', 'That is not a page size.');
    const result = await this.run(cwd, ['search', '--json', '--limit', String(limit), '--', text], {
      timeoutMs: SEARCH_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    });
    return jsonResult(result, 'search Entire', readSearchPage, {
      remote: true,
      noAccess: 'Entire does not know this repository, or your login cannot see it.',
    });
  }

  /** Whether a login to Entire is saved, and whose. */
  async authStatus(cwd: string): Promise<Result<AuthStatus>> {
    const result = await this.run(cwd, ['auth', 'status', '--json'], { timeoutMs: AUTH_TIMEOUT_MS, dedupe: true });
    return jsonResult(result, 'read the login status', readAuthStatus, { remote: true });
  }

  /** The version of the Graph plugin, which fails with `pluginMissing` when it is not installed. Local only. */
  async graphVersion(cwd: string): Promise<Result<string>> {
    const result = await this.run(cwd, ['graph', 'version', '--json'], { timeoutMs: 10_000, dedupe: true });
    if (result.code !== 0 && result.code !== null && isPluginMissing(result.stderr, 'graph')) {
      return fail('pluginMissing', NO_GRAPH_PLUGIN, lastLines(result.stderr));
    }
    return jsonResult(result, 'check the Graph plugin', readGraphVersion);
  }

  /** Whether the repository has a brain, as the entire-brain plugin reports it. Reads local state only. */
  async brainStatus(cwd: string, signal?: AbortSignal): Promise<Result<BrainStatus>> {
    const result = await this.run(cwd, ['brain', 'status', '--json'], {
      timeoutMs: 30_000,
      ...(signal ? { signal } : { dedupe: true }),
    });
    // Without the plugin the CLI does not know the command, and says so with its usage text.
    if (result.code !== 0 && result.code !== null && isPluginMissing(result.stderr)) {
      return fail('pluginMissing', NO_BRAIN_PLUGIN, lastLines(result.stderr));
    }
    return jsonResult(result, 'read the brain status', readBrainStatus);
  }

  /**
   * Starts `entire brain viz`, the plugin's graph page for a repository, and
   * resolves with its address once it is listening. The page is served on
   * the loopback address, from the brain on disk, until the caller stops it.
   *
   * It takes no lane: the lanes bound how many short calls run at once, and
   * this one stays up for as long as the page is in use.
   */
  async startBrainViz(cwd: string, signal?: AbortSignal): Promise<Result<RunningServer>> {
    const started = Date.now();
    const server = await this.serve(this.binPath, BRAIN_VIZ_ARGS, {
      cwd,
      env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
      ready: parseVizUrl,
      readyTimeoutMs: BRAIN_VIZ_READY_MS,
      ...(signal ? { signal } : {}),
    });
    const command = `entire ${BRAIN_VIZ_ARGS.join(' ')}`;
    if (server.ok) {
      this.log(`${command} (listening on ${server.value.url} after ${Date.now() - started} ms)`);
      void server.value.exited.then(() => this.log(`${command} (stopped)`));
      return server;
    }
    const { failure } = server;
    this.log(`${command} (${failure.kind}, ${Date.now() - started} ms)`);
    if (failure.detail) this.log(`  stderr: ${lastLines(failure.detail, 6).split('\n').join('\n          ')}`);
    if (failure.kind === 'exit' && isPluginMissing(failure.detail ?? '')) {
      return fail('pluginMissing', NO_BRAIN_PLUGIN, lastLines(failure.detail ?? ''));
    }
    if (failure.kind === 'cliMissing') return fail('cliMissing', 'The Entire CLI could not be started.', failure.detail);
    if (failure.kind === 'timeout') return fail('timeout', 'The Entire CLI took too long to start the brain graph.', failure.detail);
    if (failure.kind === 'exit') {
      return fail('exit', 'The Entire CLI could not start the brain graph.', lastLines(failure.detail ?? ''));
    }
    return server;
  }

  /**
   * One page of the trails that touch a repository, most recent activity
   * first: the open ones, the closed ones, or with `all`, both. Those are
   * the only ways the CLI lists them. Trail calls read entire.io with the
   * login the CLI has saved.
   */
  async listTrails(
    cwd: string,
    scope: TrailScope,
    status: TrailListStatus,
    limit: number,
    pageToken?: string,
  ): Promise<Result<TrailPage>> {
    if (!TRAIL_PROJECT.test(scope.project) || !TRAIL_REPO.test(scope.repo)) {
      return fail('unexpectedOutput', 'That is not a repository on Entire.');
    }
    if (!isCount(limit, 100)) return fail('unexpectedOutput', 'That is not a page size.');
    if (pageToken !== undefined && !PAGE_TOKEN.test(pageToken)) {
      return fail('unexpectedOutput', 'That is not a page token.');
    }
    const args = [
      'trail',
      'list',
      '--project',
      scope.project,
      '--repo',
      scope.repo,
      // With no status the CLI lists every trail, open and closed.
      ...(status === 'all' ? [] : ['--status', status === 'closed' ? 'closed' : 'open']),
      '--limit',
      String(limit),
      '--json',
      ...(pageToken ? [`--page-token=${pageToken}`] : []),
    ];
    const result = await this.run(cwd, args, { timeoutMs: TRAIL_TIMEOUT_MS, dedupe: true });
    return jsonResult(result, 'list trails', readTrailPage, TRAIL_FAILURES);
  }

  /** One trail with its changes, their merge gates and CI runs, and its page on the web. */
  async showTrail(cwd: string, project: string, trail: TrailRef, signal?: AbortSignal): Promise<Result<TrailDetail>> {
    if (!TRAIL_PROJECT.test(project)) return fail('unexpectedOutput', 'That is not a project on Entire.');
    const name = trailArg(trail);
    if (name === undefined) return fail('unexpectedOutput', 'That is not a trail number.');
    const result = await this.run(cwd, ['trail', 'show', name, '--project', project, '--json'], {
      timeoutMs: TRAIL_TIMEOUT_MS,
      ...(signal ? { signal } : { dedupe: true }),
    });
    return jsonResult(result, 'read the trail', readTrailDetail, TRAIL_FAILURES);
  }

  /**
   * One page of the activity on a change, newest first.
   *
   * A change is named by its repository and its own number, which is not the
   * trail's number. Given a trail instead, the CLI picks the change, which a
   * caller can rely on only for a trail with one change. A later page is
   * asked for the way the first one was.
   */
  async trailTimeline(
    cwd: string,
    project: string,
    of: TimelineOf,
    limit: number,
    pageToken?: string,
    signal?: AbortSignal,
  ): Promise<Result<TrailTimeline>> {
    if (!TRAIL_PROJECT.test(project)) return fail('unexpectedOutput', 'That is not a project on Entire.');
    let name: string;
    if ('trail' in of) {
      const trail = trailArg(of.trail);
      if (trail === undefined) return fail('unexpectedOutput', 'That is not a trail number.');
      name = trail;
    } else {
      if (!REPO_NAME.test(of.repository)) return fail('unexpectedOutput', 'That is not a repository on Entire.');
      if (!isCount(of.number, Number.MAX_SAFE_INTEGER)) return fail('unexpectedOutput', 'That is not a change number.');
      name = `${of.repository}/${of.number}`;
    }
    if (!isCount(limit, 100)) return fail('unexpectedOutput', 'That is not a page size.');
    if (pageToken !== undefined && !PAGE_TOKEN.test(pageToken)) {
      return fail('unexpectedOutput', 'That is not a page token.');
    }
    const args = [
      'trail',
      'timeline',
      name,
      '--project',
      project,
      '--limit',
      String(limit),
      '--json',
      ...(pageToken ? [`--page-token=${pageToken}`] : []),
    ];
    const result = await this.run(cwd, args, { timeoutMs: TRAIL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
    return jsonResult(result, 'read the trail timeline', readTrailTimeline, TRAIL_FAILURES);
  }
}

/** How a failed call is worded, for calls that are not about a checkpoint. */
interface FailureWording {
  /** The call reads entire.io, so it can fail for want of a login or of access. */
  remote?: boolean;
  /** What to say when the CLI reports that the thing asked for does not exist. */
  notFound?: string;
  /** What to say when entire.io does not have the thing, or the saved login cannot see it. */
  noAccess?: string;
}

const TRAIL_FAILURES: FailureWording = { remote: true, notFound: 'Entire could not find this trail.' };

function lastLines(text: string, count = 3): string {
  return text.trim().split('\n').slice(-count).join('\n');
}

/** Maps a finished process to a failure, or undefined when it exited cleanly. */
function processFailure(result: ExecResult, action: string, wording: FailureWording = {}): Failure | undefined {
  if (result.spawnError) {
    return {
      kind: 'cliMissing',
      message: 'The Entire CLI could not be started.',
      detail: result.spawnError.message,
    };
  }
  if (result.aborted) return { kind: 'aborted', message: 'Cancelled.' };
  if (result.timedOut) return { kind: 'timeout', message: `The Entire CLI took too long to ${action}.` };
  if (result.truncated) return { kind: 'unexpectedOutput', message: 'The Entire CLI returned more data than expected.' };
  if (result.writeError) {
    return { kind: 'exit', message: `Entire could not save what the CLI returned.`, detail: result.writeError.message };
  }
  if (result.code !== 0) {
    const stderr = lastLines(result.stderr);
    if (wording.remote) {
      if (/not logged in|entire login|re-authenticate/i.test(stderr)) {
        return { kind: 'notLoggedIn', message: 'You are not logged in to Entire.', detail: stderr };
      }
      // The second and third are what `entire api` says of an origin it cannot place on Entire.
      if (/does not exist or is not visible|no active mirror|needs a GitHub repo/i.test(stderr)) {
        return {
          kind: 'noAccess',
          message: wording.noAccess ?? 'This project is not on Entire, or your login cannot see it.',
          detail: stderr,
        };
      }
    }
    // For a change, the CLI says "no change <repo>/<n> found".
    const missing = wording.remote ? /not found|\bno (change|trail)\b[^\n]*\bfound\b/i : /not found/i;
    if (missing.test(stderr)) {
      return {
        kind: 'notFound',
        message: wording.notFound ?? 'Entire has no session data for this checkpoint, on this machine or on the remote.',
        detail: stderr,
      };
    }
    return { kind: 'exit', message: `The Entire CLI could not ${action}.`, detail: stderr };
  }
  return undefined;
}

/**
 * Reads the reply to an `entire api` call. A call that Entire refuses exits
 * non-zero with the refusal as JSON on stdout, so here the exit code is
 * looked at first, and the refusal is read for what went wrong.
 */
function apiResult<T>(
  result: ExecResult,
  action: string,
  read: (value: unknown) => T | undefined,
  wording: FailureWording = {},
): Result<T> {
  const text = result.stdout.toString('utf8').trim();
  const refusal = result.code === 0 ? undefined : remoteRefusal(text);
  const failure = processFailure(
    refusal === undefined ? result : { ...result, stderr: `${result.stderr.trim()}\n${refusal}`.trim() },
    action,
    { remote: true, noAccess: 'This repository is not on Entire, or your login cannot see it.', ...wording },
  );
  if (failure) {
    // The API answers an expired or missing token in its own words, not the CLI's.
    if (failure.kind === 'exit' && /\b(unauthori[sz]ed|unauthenticated|invalid token|token (has )?expired)\b/i.test(refusal ?? '')) {
      return fail('notLoggedIn', 'You are not logged in to Entire.', failure.detail);
    }
    return { ok: false, failure };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('unexpectedOutput', `Entire returned no data when asked to ${action}.`, text.slice(0, 400));
  }
  const value = read(parsed);
  return value === undefined
    ? fail('unexpectedOutput', 'Entire returned data this extension does not understand.', text.slice(0, 400))
    : ok(value);
}

/**
 * Parses stdout as JSON before looking at the exit code: the CLI exits
 * non-zero for a partially readable checkpoint while still printing a usable
 * envelope. In a repo where Entire is disabled it prints prose and exits 0.
 */
function jsonResult<T>(
  result: ExecResult,
  action: string,
  read: (value: unknown) => T | undefined,
  wording: FailureWording = {},
): Result<T> {
  const text = result.stdout.toString('utf8').trim();
  if (text !== '' && !result.aborted && !result.timedOut && !result.truncated) {
    let parsed: unknown;
    let valid = true;
    try {
      parsed = JSON.parse(text);
    } catch {
      valid = false;
    }
    if (valid) {
      const value = read(parsed);
      if (value !== undefined) return ok(value);
      return fail('unexpectedOutput', `The Entire CLI returned data this extension does not understand.`, text.slice(0, 400));
    }
    if (/entire is (disabled|not enabled)|entire enable/i.test(text)) {
      return fail('notEnabled', 'Entire is not enabled in this repository.', text.slice(0, 400));
    }
  }
  const failure = processFailure(result, action, wording);
  if (failure) return { ok: false, failure };
  return fail('unexpectedOutput', `The Entire CLI returned no data when asked to ${action}.`, text.slice(0, 400));
}
