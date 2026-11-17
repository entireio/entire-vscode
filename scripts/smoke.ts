import os from 'node:os';
import { CheckpointIndex, loadPage } from '../src/core/checkpointIndex';
import { CheckpointStore } from '../src/core/checkpointStore';
import { isExecutableFile, isSupportedVersion, locateCli, loginShellProbe } from '../src/core/cliLocator';
import { EntireCli } from '../src/core/entireCli';
import { exec } from '../src/core/exec';
import { Git } from '../src/core/git';
import { Lane } from '../src/core/scheduler';
import { totalTokens } from '../src/core/schemas';
import { parseCliText } from '../src/core/transcript/cliText';
import { toWireTurn } from '../src/core/transcript/model';
import { parseCompactTranscript } from '../src/core/transcript/normalize';
import { isCommitSha } from '../src/core/trailers';
import {
  checkOutcome,
  gateLabel,
  gateOutcome,
  outcomeSummary,
  primaryChange,
  trailProject,
  trailRepo,
} from '../src/core/trails';
import {
  commitUrl,
  parseEntireRemote,
  repoUrl,
  resolveWebBase,
  sessionUrl,
  type EntireRepo,
} from '../src/core/webLinks';

const say = (line = ''): void => console.log(line);

async function timed<T>(label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const value = await work();
  say(`  [${(performance.now() - started).toFixed(0)} ms] ${label}`);
  return value;
}

/** What the Trails view and the trail panel read, for a repository that Entire hosts. */
async function trails(cli: EntireCli, git: Git, root: string, hosted: EntireRepo, branch: string | undefined): Promise<void> {
  say();
  say('Trails');
  const scope = { project: trailProject(hosted), repo: trailRepo(hosted) };
  const page = await timed('first page of open trails from the CLI', () => cli.listTrails(root, scope, 'open', 50));
  if (!page.ok) {
    say(`  trails failed: ${page.failure.kind}: ${page.failure.message}`);
    return;
  }
  const { trails: listed, total, nextPageToken } = page.value;
  say(`  open trails=${listed.length} of ${total ?? '?'} more=${nextPageToken !== undefined}`);
  for (const trail of listed.slice(0, 3)) {
    const change = trail.changes[primaryChange(trail.changes, hosted, branch)];
    say(`  #${trail.number} ${trail.phase ?? trail.status ?? '?'} ${trail.title.slice(0, 50)} | ${change?.branch ?? 'no branch'}`);
  }
  if (nextPageToken) {
    const second = await timed('second page', () => cli.listTrails(root, scope, 'open', 50, nextPageToken));
    if (second.ok) {
      const seen = new Set(listed.map((trail) => trail.number));
      const repeats = second.value.trails.filter((trail) => seen.has(trail.number)).length;
      say(`  second page trails=${second.value.trails.length} repeated from the first=${repeats}`);
    } else {
      say(`  second page failed: ${second.failure.kind}: ${second.failure.message}`);
    }
  }

  const sample = listed.find((trail) => trail.changes.length > 0) ?? listed[0];
  if (!sample) return;
  const detail = await timed(`trail ${sample.number} from the CLI`, () => cli.showTrail(root, scope.project, sample));
  if (!detail.ok) {
    say(`  trail failed: ${detail.failure.kind}: ${detail.failure.message}`);
    return;
  }
  say(`  web trail   ${detail.value.url ?? '(none reported)'}`);
  for (const change of detail.value.changes) {
    const merge = change.mergeability;
    const gates = merge?.gates.map((gate) => `${gateLabel(gate.key)}=${gateOutcome(gate)}`).join(', ');
    say(
      `  change ${change.repository}#${change.number} ${change.branch ?? '?'} -> ${change.base ?? '?'} ` +
        (merge
          ? `mergeable=${merge.mergeable} gates=[${gates}] runs=[${outcomeSummary(merge.checks.map(checkOutcome))}]`
          : 'no merge state'),
    );
  }
  const change = detail.value.changes[primaryChange(detail.value.changes, hosted, branch)];
  if (!change) return;
  const timeline = await timed(`timeline of ${change.repository}#${change.number}`, () =>
    cli.trailTimeline(root, scope.project, change, 50),
  );
  if (!timeline.ok) {
    say(`  timeline failed: ${timeline.failure.kind}: ${timeline.failure.message}`);
    return;
  }
  const kinds = new Map<string, number>();
  for (const event of timeline.value.events) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
  const shas = timeline.value.events
    .map((event) => event.commitSha)
    .filter((sha): sha is string => sha !== undefined && isCommitSha(sha));
  const local = (await Promise.all(shas.map((sha) => git.commit(root, sha)))).filter((commit) => commit !== undefined);
  say(
    `  timeline entries=${timeline.value.events.length} [${[...kinds].map(([kind, n]) => `${kind}=${n}`).join(', ')}] ` +
      `more=${timeline.value.nextPageToken !== undefined} incomplete=${timeline.value.incomplete}`,
  );
  say(
    `  commits=${shas.length} in this clone=${local.length} ` +
      `with a checkpoint here=${local.filter((commit) => commit.checkpointIds.length > 0).length}`,
  );
}

export async function main(args: string[]): Promise<number> {
  const [repoArg, checkpointArg] = args;
  if (!repoArg) {
    console.error('Usage: npm run smoke -- <path-to-repo> [checkpoint-id]');
    return 2;
  }

  const git = new Git(exec, new Lane(4));
  const paths = await git.repoPaths(repoArg);
  if (!paths.ok) {
    say(`Not usable: ${paths.failure.message}`);
    return 1;
  }
  const { root } = paths.value;
  say(`Repository  ${root}`);
  say(`Git dir     ${paths.value.gitDir}`);
  say(`Common dir  ${paths.value.commonDir}`);

  const located = await locateCli(undefined, {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir(),
    isExecutable: isExecutableFile,
    probeLoginShell: loginShellProbe(exec, process.env, root),
  });
  if (!located) {
    say('Entire CLI  not found');
    return 1;
  }
  const cli = new EntireCli(located.path, exec, new Lane(4));
  const version = await cli.version(root);
  say(
    `Entire CLI  ${located.path} (${located.source}) ` +
      (version.ok
        ? `${version.value.raw}${isSupportedVersion(version.value) ? '' : ' UNSUPPORTED'}`
        : version.failure.message),
  );

  const status = await cli.status(root);
  if (!status.ok) {
    say(`Status      ${status.failure.kind}: ${status.failure.message}`);
    return 1;
  }
  say(
    `Status      enabled=${status.value.enabled}${status.value.error ? ` error="${status.value.error}"` : ''}` +
      ` agents=[${status.value.agents.join(', ')}] active=${status.value.activeSessions.length}`,
  );

  const origin = await git.originUrl(root);
  const entireRepo = parseEntireRemote(origin);
  const base = resolveWebBase(undefined, process.env);
  say(`Origin      ${origin ?? '(none)'}`);
  say(`Web         ${entireRepo ? repoUrl(base, entireRepo) : 'no links (origin is not entire://)'}`);

  const tip = await git.head(root);
  if (!tip) {
    say('HEAD        no commits yet');
    return 0;
  }
  const branch = await git.branch(root);
  say(`HEAD        ${tip} (${branch ?? 'detached'})`);

  if (entireRepo) await trails(cli, git, root, entireRepo, branch);

  say();
  say('Checkpoints');
  const index = new CheckpointIndex(tip);
  await timed('first page from git', () =>
    loadPage(index, async (skip, count) => {
      const window = await git.logWindow(root, tip, skip, count);
      return window.ok ? window.value : undefined;
    }),
  );
  const multi = index.commits.filter((commit) => commit.checkpointIds.length > 1).length;
  say(
    `  linked commits=${index.commits.length} scanned=${index.scanned} exhausted=${index.exhausted} ` +
      `commits with several checkpoints=${multi}`,
  );

  const rows = await timed('enrichment rows from the CLI', () => cli.listCheckpoints(root, 500));
  if (rows.ok) {
    index.setRows(rows.value);
    const matched = index.commits.filter((commit) => commit.checkpointIds.some((id) => index.row(id))).length;
    say(`  rows=${rows.value.length} commits enriched=${matched} unlinked rows=${index.unlinkedRows().length}`);
    say(`  sessions referenced by rows=${index.sessions().length}`);
  } else {
    say(`  enrichment failed: ${rows.failure.kind}: ${rows.failure.message}`);
  }
  for (const commit of index.commits.slice(0, 3)) {
    const row = commit.checkpointIds.map((id) => index.row(id)).find(Boolean);
    say(`  ${commit.shortSha} ${commit.subject.slice(0, 60)} | ${commit.checkpointIds.join(',')} | ${row?.agent ?? '?'}`);
  }

  const sessions = await timed('session list from the CLI', () => cli.sessionList(root));
  say(sessions.ok ? `  local sessions=${sessions.value.length}` : `  sessions failed: ${sessions.failure.message}`);

  const checkpointId = checkpointArg ?? index.commits[0]?.checkpointIds[0] ?? index.unlinkedRows()[0]?.checkpointId;
  if (!checkpointId) {
    say();
    say('No checkpoint to open.');
    return 0;
  }

  say();
  say(`Checkpoint ${checkpointId}`);
  const detail = await timed('explain from the CLI', () => cli.explainCheckpoint(root, checkpointId));
  if (!detail.ok) {
    say(`  explain failed: ${detail.failure.kind}: ${detail.failure.message}`);
    return 1;
  }
  say(`  branch=${detail.value.branch ?? '?'} files=${detail.value.filesTouched.length} partial=${detail.value.partial}`);
  for (const session of detail.value.sessions) {
    say(
      `  session[${session.index}] ${session.agent ?? '?'} ${session.model ?? ''} ` +
        `tokens=${session.tokenUsage ? totalTokens(session.tokenUsage) : '?'} id=${session.sessionId ?? '?'}`,
    );
  }
  const commit = index.commitsFor(checkpointId)[0];
  if (entireRepo) {
    if (commit) say(`  web commit  ${commitUrl(base, entireRepo, commit.sha)} (on remote: ${await git.isOnRemote(root, commit.sha)})`);
    const sessionId = detail.value.sessions.at(-1)?.sessionId;
    if (sessionId) say(`  web session ${sessionUrl(base, entireRepo, sessionId)}`);
  }
  if (commit) say(`  commit files=${(await git.commitFiles(root, commit.sha)).length}`);

  const store = new CheckpointStore(git);
  const tree = await timed('locate in git', () => store.locate(root, checkpointId));
  if (!tree) {
    say('  not found in local git storage');
    return 0;
  }
  say(`  tree=${tree.treeish} prefix="${tree.prefix}"`);
  const stored = await store.sessions(root, tree);
  for (const session of stored) {
    const meta = await store.sessionMeta(root, tree, session);
    const text = await timed(`read transcript.jsonl of session ${session.index}`, () =>
      store.compactTranscript(root, tree, session),
    );
    if (text === undefined) {
      say(`  session[${session.index}] has no normalized transcript`);
      continue;
    }
    const parsed = parseCompactTranscript(text, meta?.compactTranscriptStart);
    const wire = parsed.turns.map(toWireTurn);
    const tools = wire.flatMap((turn) => turn.blocks).filter((block) => block.kind === 'tool').length;
    const images = wire.flatMap((turn) => turn.blocks).filter((block) => block.kind === 'image').length;
    const first = parsed.turns[parsed.startTurn]?.blocks.find((block) => block.kind === 'text');
    say(
      `  session[${session.index}] bytes=${text.length} wire bytes=${JSON.stringify(wire).length} turns=${parsed.turns.length} ` +
        `start line=${meta?.compactTranscriptStart ?? 'null'} start turn=${parsed.startTurn} tools=${tools} images=${images}`,
    );
    say(`    first prompt of this checkpoint: ${first?.kind === 'text' ? JSON.stringify(first.text.slice(0, 90)) : '(none)'}`);
  }

  const full = await timed('text fallback from the CLI', () => cli.fullText(root, checkpointId));
  if (full.ok) {
    const parsed = parseCliText(full.value);
    const tools = parsed.turns.flatMap((turn) => turn.blocks).filter((block) => block.kind === 'tool').length;
    say(`  text view turns=${parsed.turns.length} tools=${tools}`);
  } else {
    say(`  text view failed: ${full.failure.message}`);
  }
  return 0;
}
