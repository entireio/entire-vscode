import { describe, expect, it } from 'vitest';
import type { TrailSummary } from '../../src/core/schemas';
import {
  hasLocalTerms,
  matchesTerms,
  oneLine,
  readSearchPage,
  readSearchScope,
  searchQuery,
  searchTerms,
  trailMatches,
} from '../../src/core/search';

const SHA = 'b83de22f58079bf0f599f009d938e72ddcdf9980';
const CHECKPOINT = '01M7PM7H9GQMRY1QPYW787WX0D';
const SESSION = 'd549f207-c9a9-4f23-968f-c4e46f52ba7d';

/** A commit and a session as `entire search --json` returned them, trimmed. */
const commitResult = {
  type: 'commit',
  data: {
    id: SHA,
    commitSha: SHA,
    commitMessage: `Point the extension's homepage at entire.com\n\nOpen VSX asked for it.\n\nCo-Authored-By: Someone <someone@example.com>\nEntire-Checkpoint: ${CHECKPOINT}`,
    commitSubject: "Point the extension's homepage at entire.com",
    branch: 'enable-entire',
    org: 'entireio',
    repo: 'entire-vscode',
    author: 'Fixture Author',
    authorUsername: 'fixture-author',
    createdAt: '2026-11-18T06:06:43.000Z',
    additions: 8,
    deletions: 4,
    filesChanged: 3,
    htmlUrl: null,
  },
  searchMeta: { matchType: 'both', score: 3.29, tier: 0 },
};

const sessionResult = {
  type: 'session',
  data: {
    sessionId: SESSION,
    matchedCheckpointId: CHECKPOINT,
    displayName: 'Point Extension Homepage to entire.com',
    prompt: 'resolve this comment and push all the commits',
    agent: 'Claude Code',
    model: 'test-model',
    stepCount: 1,
    branch: 'enable-entire',
    authorUsername: 'fixture-author',
    createdAt: '2026-11-18T06:06:46.423616Z',
  },
  searchMeta: { matchType: 'both', score: 1.09, snippet: '[user]: resolve this\n[assistant]:   The branch   is pushed.' },
};

const page = (results: unknown[]): unknown => ({
  results,
  total: results.length,
  page: 1,
  total_pages: 1,
  limit: 10,
  counts: { repos: 0, checkpoints: 0, commits: 1, prs: 0, sessions: 1 },
  reranked: true,
});

describe('readSearchPage', () => {
  it('reads a commit with the checkpoint its message names, and a session with the checkpoint that matched', () => {
    expect(readSearchPage(page([commitResult, sessionResult]))).toEqual({
      total: 2,
      hits: [
        {
          kind: 'commit',
          sha: SHA,
          subject: "Point the extension's homepage at entire.com",
          checkpointIds: [CHECKPOINT],
          branch: 'enable-entire',
          author: 'Fixture Author',
          createdAt: '2026-11-18T06:06:43.000Z',
        },
        {
          kind: 'session',
          sessionId: SESSION,
          checkpointId: CHECKPOINT,
          name: 'Point Extension Homepage to entire.com',
          prompt: 'resolve this comment and push all the commits',
          agent: 'Claude Code',
          branch: 'enable-entire',
          author: 'fixture-author',
          createdAt: '2026-11-18T06:06:46.423616Z',
          snippet: '[user]: resolve this [assistant]: The branch is pushed.',
        },
      ],
    });
  });

  it('keeps the order the service ranked the results in', () => {
    const hits = readSearchPage(page([sessionResult, commitResult]))?.hits.map((hit) => hit.kind);
    expect(hits).toEqual(['session', 'commit']);
  });

  it('reads a commit with no checkpoint, and takes its subject from the message when there is none', () => {
    const data = { commitSha: SHA, commitMessage: 'Tidy up\n\nMore words.', branch: 'main' };
    const hit = readSearchPage(page([{ type: 'commit', data }]))?.hits[0];
    expect(hit).toMatchObject({ kind: 'commit', sha: SHA, subject: 'Tidy up', checkpointIds: [] });
  });

  it('reads a checkpoint, which the service may return', () => {
    const hit = readSearchPage(
      page([{ type: 'checkpoint', data: { checkpointId: CHECKPOINT, title: 'Add the parser', sessionId: SESSION, commitSha: SHA } }]),
    )?.hits[0];
    expect(hit).toEqual({ kind: 'checkpoint', checkpointId: CHECKPOINT, title: 'Add the parser', sessionId: SESSION, commitSha: SHA });
  });

  it('skips what the extension cannot open, and hits whose IDs it cannot check', () => {
    const hits = readSearchPage(
      page([
        { type: 'pr', data: { id: 1, title: 'A pull request' } },
        { type: 'repo', data: { id: 'entireio/entire-vscode' } },
        { type: 'commit', data: { commitSha: 'not-a-sha', commitSubject: 'x' } },
        { type: 'session', data: { sessionId: '--help' } },
        { type: 'session', data: { sessionId: SESSION, matchedCheckpointId: '--flag' } },
        { type: 'checkpoint', data: { checkpointId: 'nope' } },
        { type: 'commit' },
        'garbage',
        null,
      ]),
    )?.hits;
    // Only the session survives, without the checkpoint it named, which was not a checkpoint ID.
    expect(hits).toEqual([{ kind: 'session', sessionId: SESSION }]);
  });

  it('reads an empty page', () => {
    expect(readSearchPage(page([]))).toEqual({ hits: [], total: 0 });
  });

  it('rejects output that is not a page of results', () => {
    expect(readSearchPage(undefined)).toBeUndefined();
    expect(readSearchPage([])).toBeUndefined();
    expect(readSearchPage({ results: 'none' })).toBeUndefined();
  });
});

describe('searchQuery', () => {
  it('trims the query and keeps it on one line', () => {
    expect(searchQuery('  retry backoff  ')).toBe('retry backoff');
    expect(searchQuery('-starts with a dash')).toBe('-starts with a dash');
  });

  it('refuses an empty query, a long one, and one with control characters', () => {
    expect(searchQuery('')).toBeUndefined();
    expect(searchQuery('   ')).toBeUndefined();
    expect(searchQuery('x'.repeat(501))).toBeUndefined();
    expect(searchQuery('two\nlines')).toBeUndefined();
    expect(searchQuery('bell\x07')).toBeUndefined();
  });
});

describe('readSearchScope', () => {
  it('reads the three scopes and nothing else', () => {
    expect(readSearchScope('checkpoints')).toBe('checkpoints');
    expect(readSearchScope('sessions')).toBe('sessions');
    expect(readSearchScope('trails')).toBe('trails');
    expect(readSearchScope('commits')).toBeUndefined();
    expect(readSearchScope(undefined)).toBeUndefined();
  });
});

describe('oneLine', () => {
  it('folds white space and drops what is empty', () => {
    expect(oneLine(' a\n\tb  c ')).toBe('a b c');
    expect(oneLine('  ')).toBeUndefined();
    expect(oneLine(undefined)).toBeUndefined();
  });
});

describe('searchTerms and matchesTerms', () => {
  it('needs every word, in any field, in any case', () => {
    const terms = searchTerms('Parser WRITE');
    expect(matchesTerms(terms, ['Add the parser', 'Now write it'])).toBe(true);
    expect(matchesTerms(terms, ['Add the parser'])).toBe(false);
  });

  it('reads branch: as a filter on the branch, and leaves the other filters to Entire', () => {
    const terms = searchTerms('parser branch:feat author:alice date:week');
    expect(terms).toEqual({ words: ['parser'], branch: 'feat' });
    expect(matchesTerms(terms, ['Add the parser'], 'feature/parser')).toBe(true);
    expect(matchesTerms(terms, ['Add the parser'], 'main')).toBe(false);
    expect(matchesTerms(terms, ['Add the parser'])).toBe(false);
  });

  it('keeps words that only look like filters', () => {
    expect(searchTerms('https://entire.com').words).toEqual(['https://entire.com']);
  });

  it('matches nothing for a query of filters only Entire reads', () => {
    const terms = searchTerms('author:alice date:week');
    expect(hasLocalTerms(terms)).toBe(false);
    expect(matchesTerms(terms, ['anything'])).toBe(false);
  });
});

describe('trailMatches', () => {
  const trail: TrailSummary = {
    number: 2923,
    title: 'Enable Entire and point the homepage at entire.com',
    body: 'Adds the hooks that capture agent sessions.',
    status: 'open',
    phase: 'complete',
    assignees: [],
    changes: [{ repository: 'entire-vscode', number: 4, branch: 'enable-entire', hasCodeChanges: true }],
  };

  it('matches the number, with or without #', () => {
    expect(trailMatches(searchTerms('#2923'), trail)).toBe(true);
    expect(trailMatches(searchTerms('2923'), trail)).toBe(true);
    expect(trailMatches(searchTerms('#292'), trail)).toBe(false);
  });

  it('matches words in the title, description, phase, and branches', () => {
    expect(trailMatches(searchTerms('homepage'), trail)).toBe(true);
    expect(trailMatches(searchTerms('hooks complete'), trail)).toBe(true);
    expect(trailMatches(searchTerms('#2923 hooks'), trail)).toBe(true);
    expect(trailMatches(searchTerms('enable-entire'), trail)).toBe(true);
    expect(trailMatches(searchTerms('planning'), trail)).toBe(false);
  });

  it('filters on the branch of a change', () => {
    expect(trailMatches(searchTerms('branch:enable'), trail)).toBe(true);
    expect(trailMatches(searchTerms('homepage branch:main'), trail)).toBe(false);
  });

  it('matches nothing without a word or a branch', () => {
    expect(trailMatches(searchTerms(''), trail)).toBe(false);
    expect(trailMatches(searchTerms('author:alice'), trail)).toBe(false);
  });
});
