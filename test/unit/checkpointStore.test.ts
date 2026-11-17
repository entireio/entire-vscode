import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore, safeTreePath, type CheckpointTree } from '../../src/core/checkpointStore';
import { exec } from '../../src/core/exec';
import { Git } from '../../src/core/git';
import { Lane } from '../../src/core/scheduler';
import { parseCompactTranscript } from '../../src/core/transcript/normalize';
import { checkpointFiles, createFixtureRepo, transcriptLine, type FixtureRepo } from '../helpers/fixtureRepo';
import { isolateGitConfig } from './support';

const HEX = 'abcdef012345';
const ULID = '01HZXK3M5N7P9R2T4V6W8Y0A1B';
const OTHER_ULID = '01HZXK3M5N7P9R2T4V6W8Y0C2D';
const LEGACY_LOCAL = 'refs/heads/entire/checkpoints/v1';
const LEGACY_REMOTE = 'refs/remotes/origin/entire/checkpoints/v1';
const legacyPrefix = (id: string): string => `${id.slice(0, 2)}/${id.slice(2)}/`;

const TRANSCRIPT = [
  transcriptLine('user', [{ text: 'Earlier prompt' }]),
  transcriptLine('assistant', [{ type: 'text', text: 'Earlier reply' }]),
  transcriptLine('user', [{ text: 'Prompt of this checkpoint' }]),
  transcriptLine('assistant', [{ type: 'text', text: 'Reply of this checkpoint' }]),
];

describe('safeTreePath', () => {
  it.each([
    ['/0/transcript.jsonl', '0/transcript.jsonl'],
    ['0/metadata.json', '0/metadata.json'],
    ['/ab/cdef012345/1/transcript.jsonl', 'ab/cdef012345/1/transcript.jsonl'],
    ['///0/full.jsonl', '0/full.jsonl'],
    ['metadata.json', 'metadata.json'],
    ['assets/img-0a1b2c.png', 'assets/img-0a1b2c.png'],
    ['/tasks/toolu_01AbC/agent-a1.jsonl', 'tasks/toolu_01AbC/agent-a1.jsonl'],
  ])('turns %j into %j', (stored, expected) => {
    expect(safeTreePath(stored)).toBe(expected);
  });

  it.each([
    ['a parent segment', '../secrets.json'],
    ['a parent segment after the root slash', '/../secrets.json'],
    ['a parent segment in the middle', '/0/../../other/metadata.json'],
    ['a parent segment at the end', '/0/..'],
    ['a current-directory segment', '/0/./transcript.jsonl'],
    ['a leading current-directory segment', './0/transcript.jsonl'],
    ['an empty segment', '/0//transcript.jsonl'],
    ['a trailing slash', '/0/'],
  ])('rejects traversal: %s', (_label, stored) => {
    expect(safeTreePath(stored)).toBeUndefined();
  });

  it.each([
    ['a space', '/0/my transcript.jsonl'],
    ['a colon, which separates the ref from the path', '/0/a:b.jsonl'],
    ['a backslash', '\\0\\transcript.jsonl'],
    ['a backslash traversal', '/0/..\\..\\x'],
    ['a newline', '/0/transcript.jsonl\n'],
    ['a newline in the middle', '/0/a\nb'],
    ['a NUL byte', '/0/a\x00b'],
    ['a glob', '/0/*.jsonl'],
    ['a question mark', '/0/transcript.jsonl?'],
    ['a tilde', '~/transcript.jsonl'],
    ['a caret', '/0/a^b'],
    ['an at sign with braces', '/0/@{upstream}'],
    ['a quote', '/0/"a".jsonl'],
    ['a dollar sign', '/0/$HOME'],
    ['a percent escape', '/0/%2e%2e/x'],
    ['a non-ASCII letter', '/0/übersicht.jsonl'],
    ['a tab', '/0/a\tb'],
  ])('rejects %s', (_label, stored) => {
    expect(safeTreePath(stored)).toBeUndefined();
  });

  it.each([
    ['an empty string', ''],
    ['only slashes', '///'],
    ['undefined', undefined],
    ['null', null],
    ['a number', 0],
    ['an array', ['0', 'transcript.jsonl']],
    ['an object', { path: '/0/transcript.jsonl' }],
  ])('rejects %s', (_label, stored) => {
    expect(safeTreePath(stored)).toBeUndefined();
  });
});

describe('CheckpointStore', () => {
  const store = new CheckpointStore(new Git(exec, new Lane(4)));
  let repo: FixtureRepo;

  beforeAll(() => isolateGitConfig());
  afterAll(() => vi.unstubAllEnvs());
  beforeEach(() => {
    repo = createFixtureRepo();
  });
  afterEach(() => repo.dispose());

  /** Locates a checkpoint that the test expects to exist. */
  const locate = async (id: string): Promise<CheckpointTree> => {
    const tree = await store.locate(repo.root, id);
    if (!tree) throw new Error(`checkpoint ${id} was not located`);
    return tree;
  };

  describe('locate', () => {
    it('finds a checkpoint stored as its own ref, with an uppercase shard', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]));
      expect(await store.locate(repo.root, ULID)).toEqual({
        treeish: `refs/entire/checkpoints/1B/${ULID}`,
        prefix: '',
      });
    });

    it('finds a checkpoint whose shard differs in case from the end of its ID', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]), '1b');
      expect(await store.locate(repo.root, ULID)).toEqual({
        treeish: `refs/entire/checkpoints/1b/${ULID}`,
        prefix: '',
      });
    });

    it('finds a checkpoint under a shard that is unrelated to its ID', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}]), 'zz');
      expect((await store.locate(repo.root, ULID))?.treeish).toBe(`refs/entire/checkpoints/zz/${ULID}`);
    });

    it('finds a hex checkpoint stored as its own ref', async () => {
      repo.addRefCheckpoint(HEX, checkpointFiles(HEX, [{}]));
      expect(await store.locate(repo.root, HEX)).toEqual({ treeish: `refs/entire/checkpoints/45/${HEX}`, prefix: '' });
    });

    it('picks the right ref among several checkpoints in one shard', async () => {
      const sibling = `${OTHER_ULID.slice(0, 24)}${ULID.slice(-2)}`;
      repo.addRefCheckpoint(sibling, checkpointFiles(sibling, [{}]));
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}]));
      expect((await store.locate(repo.root, ULID))?.treeish).toBe(`refs/entire/checkpoints/1B/${ULID}`);
      expect((await store.locate(repo.root, sibling))?.treeish).toBe(`refs/entire/checkpoints/1B/${sibling}`);
    });

    it('finds a legacy checkpoint when only the remote-tracking branch exists', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, {
        [HEX]: checkpointFiles(HEX, [{ transcript: TRANSCRIPT }], legacyPrefix(HEX)),
      });
      expect(await store.locate(repo.root, HEX)).toEqual({ treeish: LEGACY_REMOTE, prefix: 'ab/cdef012345/' });
    });

    it('finds a legacy checkpoint on the local branch', async () => {
      repo.addLegacyCheckpoints(LEGACY_LOCAL, { [HEX]: checkpointFiles(HEX, [{}], legacyPrefix(HEX)) });
      expect(await store.locate(repo.root, HEX)).toEqual({ treeish: LEGACY_LOCAL, prefix: 'ab/cdef012345/' });
    });

    it('falls back to the remote-tracking branch when the local branch lacks the checkpoint', async () => {
      repo.addLegacyCheckpoints(LEGACY_LOCAL, { '111111111111': checkpointFiles('111111111111', [{}], legacyPrefix('111111111111')) });
      repo.addLegacyCheckpoints(LEGACY_REMOTE, {
        '111111111111': checkpointFiles('111111111111', [{}], legacyPrefix('111111111111')),
        [HEX]: checkpointFiles(HEX, [{}], legacyPrefix(HEX)),
      });
      expect(await store.locate(repo.root, HEX)).toEqual({ treeish: LEGACY_REMOTE, prefix: 'ab/cdef012345/' });
      expect((await store.locate(repo.root, '111111111111'))?.treeish).toBe(LEGACY_LOCAL);
    });

    it('finds a legacy checkpoint on a remote that is not called origin', async () => {
      const ref = 'refs/remotes/upstream/entire/checkpoints/v1';
      repo.addLegacyCheckpoints(ref, { [HEX]: checkpointFiles(HEX, [{}], legacyPrefix(HEX)) });
      expect((await store.locate(repo.root, HEX))?.treeish).toBe(ref);
    });

    it('prefers the checkpoint ref over the legacy branch', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, { [HEX]: checkpointFiles(HEX, [{}], legacyPrefix(HEX)) });
      repo.addRefCheckpoint(HEX, checkpointFiles(HEX, [{}]));
      expect(await store.locate(repo.root, HEX)).toEqual({ treeish: `refs/entire/checkpoints/45/${HEX}`, prefix: '' });
    });

    it('returns undefined for a checkpoint that is stored nowhere', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}]));
      repo.addLegacyCheckpoints(LEGACY_REMOTE, { [HEX]: checkpointFiles(HEX, [{}], legacyPrefix(HEX)) });
      expect(await store.locate(repo.root, OTHER_ULID)).toBeUndefined();
      expect(await store.locate(repo.root, 'ffffffffffff')).toBeUndefined();
    });

    it('returns undefined in a repository with no checkpoint data', async () => {
      repo.commit('Only a commit');
      expect(await store.locate(repo.root, ULID)).toBeUndefined();
      expect(await store.locate(repo.root, HEX)).toBeUndefined();
    });

    it('does not match a ref whose name only ends with the ID', async () => {
      repo.writeRef(`refs/entire/checkpoints/1B/prefix-${ULID}`, checkpointFiles(ULID, [{}]));
      repo.writeRef(`refs/entire/checkpoints/1B/${ULID}/nested`, checkpointFiles(ULID, [{}]));
      expect(await store.locate(repo.root, ULID)).toBeUndefined();
    });

    it.each(['', 'HEAD', '*', '../../heads/main', ULID.toLowerCase(), `${HEX}/x`, 'abcdef01234*'])(
      'returns undefined for %j, which is not a checkpoint ID',
      async (id) => {
        repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}]));
        repo.addRefCheckpoint(HEX, checkpointFiles(HEX, [{}]));
        expect(await store.locate(repo.root, id)).toBeUndefined();
      },
    );
  });

  describe('sessions', () => {
    it('lists the session slots of a checkpoint ref, with tree-relative paths', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT }, {}, { transcript: TRANSCRIPT }]));
      expect(await store.sessions(repo.root, await locate(ULID))).toEqual([
        { index: 0, compactTranscriptPath: '0/transcript.jsonl', metadataPath: '0/metadata.json' },
        { index: 1, metadataPath: '1/metadata.json' },
        { index: 2, compactTranscriptPath: '2/transcript.jsonl', metadataPath: '2/metadata.json' },
      ]);
    });

    it('lists the session slots of a legacy checkpoint, with the shard prefix in each path', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, {
        [HEX]: checkpointFiles(HEX, [{ transcript: TRANSCRIPT }, {}], legacyPrefix(HEX)),
      });
      expect(await store.sessions(repo.root, await locate(HEX))).toEqual([
        {
          index: 0,
          compactTranscriptPath: 'ab/cdef012345/0/transcript.jsonl',
          metadataPath: 'ab/cdef012345/0/metadata.json',
        },
        { index: 1, metadataPath: 'ab/cdef012345/1/metadata.json' },
      ]);
    });

    it('keeps a slot for an entry it cannot read, so later slots keep their index', async () => {
      repo.addRefCheckpoint(ULID, {
        'metadata.json': JSON.stringify({
          sessions: [
            null,
            'not an object',
            { metadata: '/../../escape/metadata.json', compact_transcript: '/2/transcript jsonl' },
            { metadata: '/3/metadata.json', compact_transcript: '/3/transcript.jsonl' },
          ],
        }),
      });
      expect(await store.sessions(repo.root, await locate(ULID))).toEqual([
        { index: 0 },
        { index: 1 },
        { index: 2 },
        { index: 3, compactTranscriptPath: '3/transcript.jsonl', metadataPath: '3/metadata.json' },
      ]);
    });

    it.each([
      ['is not JSON', 'not json at all'],
      ['is a JSON array', '[]'],
      ['has no sessions', '{"checkpoint_id":"x"}'],
      ['has sessions of the wrong type', '{"sessions":{"0":{}}}'],
    ])('returns no sessions when the root metadata %s', async (_label, metadata) => {
      repo.addRefCheckpoint(ULID, { 'metadata.json': metadata });
      expect(await store.sessions(repo.root, await locate(ULID))).toEqual([]);
    });

    it('returns no sessions when the tree no longer exists', async () => {
      expect(await store.sessions(repo.root, { treeish: `refs/entire/checkpoints/1B/${ULID}`, prefix: '' })).toEqual([]);
    });
  });

  describe('compactTranscript', () => {
    it('reads the transcript of a session that has one', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]));
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.compactTranscript(repo.root, tree, session))).toBe(`${TRANSCRIPT.join('\n')}\n`);
    });

    it('returns undefined for a session that has none', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}, { transcript: TRANSCRIPT }]));
      const tree = await locate(ULID);
      const [without, withTranscript] = await store.sessions(repo.root, tree);
      expect(without && (await store.compactTranscript(repo.root, tree, without))).toBeUndefined();
      expect(withTranscript && (await store.compactTranscript(repo.root, tree, withTranscript))).toContain('Prompt of this checkpoint');
    });

    it('returns undefined when the metadata names a transcript that is not in the tree', async () => {
      const files = checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]);
      delete files['0/transcript.jsonl'];
      repo.addRefCheckpoint(ULID, files);
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session?.compactTranscriptPath).toBe('0/transcript.jsonl');
      expect(session && (await store.compactTranscript(repo.root, tree, session))).toBeUndefined();
    });

    it('reads the transcript of a legacy checkpoint', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, {
        [HEX]: checkpointFiles(HEX, [{ transcript: TRANSCRIPT }], legacyPrefix(HEX)),
        '111111111111': checkpointFiles(
          '111111111111',
          [{ transcript: [transcriptLine('user', [{ text: 'Another checkpoint' }])] }],
          legacyPrefix('111111111111'),
        ),
      });
      const tree = await locate(HEX);
      const [session] = await store.sessions(repo.root, tree);
      const text = session && (await store.compactTranscript(repo.root, tree, session));
      expect(text).toBe(`${TRANSCRIPT.join('\n')}\n`);
    });

    it('keeps non-ASCII text intact', async () => {
      const line = transcriptLine('user', [{ text: 'Größe → 10 км 😀' }]);
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: [line] }]));
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.compactTranscript(repo.root, tree, session))).toBe(`${line}\n`);
    });
  });

  describe('sessionMeta', () => {
    const metaFor = async (start: number | null | undefined) => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [start === undefined ? { transcript: TRANSCRIPT } : { transcript: TRANSCRIPT, start }]));
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      if (!session) throw new Error('no session');
      return store.sessionMeta(repo.root, tree, session);
    };

    it('reads a numeric start line', async () => {
      expect(await metaFor(2)).toStrictEqual({ sessionId: 'session-0', compactTranscriptStart: 2 });
    });

    it('reads a start line of zero as zero, not as absent', async () => {
      expect(await metaFor(0)).toStrictEqual({ sessionId: 'session-0', compactTranscriptStart: 0 });
    });

    it('reads a null start line as null', async () => {
      expect(await metaFor(null)).toStrictEqual({ sessionId: 'session-0', compactTranscriptStart: null });
    });

    it('leaves the start line absent when the metadata has none', async () => {
      expect(await metaFor(undefined)).toStrictEqual({ sessionId: 'session-0' });
    });

    it.each([-1, 1.5, '2', true, [2], { line: 2 }])('ignores the start line %j, which is not a line index', async (start) => {
      const files = checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]);
      files['0/metadata.json'] = JSON.stringify({ session_id: 'session-0', compact_transcript_start: start });
      repo.addRefCheckpoint(ULID, files);
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.sessionMeta(repo.root, tree, session))).toStrictEqual({ sessionId: 'session-0' });
    });

    it('reads the metadata of each session separately', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ start: 4 }, { start: null }, {}]));
      const tree = await locate(ULID);
      const sessions = await store.sessions(repo.root, tree);
      const metas = await Promise.all(sessions.map((session) => store.sessionMeta(repo.root, tree, session)));
      expect(metas).toStrictEqual([
        { sessionId: 'session-0', compactTranscriptStart: 4 },
        { sessionId: 'session-1', compactTranscriptStart: null },
        { sessionId: 'session-2' },
      ]);
    });

    it('reads the metadata of a legacy checkpoint', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, { [HEX]: checkpointFiles(HEX, [{ start: 3 }], legacyPrefix(HEX)) });
      const tree = await locate(HEX);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.sessionMeta(repo.root, tree, session))).toStrictEqual({ sessionId: 'session-0', compactTranscriptStart: 3 });
    });

    it('returns undefined when the session has no metadata path, or the file is missing or malformed', async () => {
      const files = checkpointFiles(ULID, [{}, {}]);
      delete files['0/metadata.json'];
      files['1/metadata.json'] = '{"compact_transcript_start": 2';
      repo.addRefCheckpoint(ULID, files);
      const tree = await locate(ULID);
      const [missing, malformed] = await store.sessions(repo.root, tree);
      expect(await store.sessionMeta(repo.root, tree, { index: 5 })).toBeUndefined();
      expect(missing && (await store.sessionMeta(repo.root, tree, missing))).toBeUndefined();
      expect(malformed && (await store.sessionMeta(repo.root, tree, malformed))).toBeUndefined();
    });
  });

  describe('openingPrompt', () => {
    const OPENING = 'run the server and show me the UI';
    const session = (first: string, ...rest: string[]): string[] => [
      transcriptLine('user', [{ text: first }]),
      transcriptLine('assistant', [{ type: 'text', text: 'On it.' }]),
      ...rest.map((text) => transcriptLine('user', [{ text }])),
    ];

    /** The text of the opening prompt, for the cases that are not about where the transcript starts. */
    const opening = async (id: string, sessionId: string): Promise<string | undefined> =>
      (await store.openingPrompt(repo.root, await locate(id), sessionId))?.text;

    it('reads the prompt that opens the session from the start of its transcript', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: session(OPENING, 'now stop it'), start: 2 }]));
      expect(await store.openingPrompt(repo.root, await locate(ULID), 'session-0')).toEqual({
        text: OPENING,
        fromSessionStart: true,
      });
    });

    it.each([
      ['null', null],
      ['absent', undefined],
    ] as const)('says when the transcript holds only the checkpoint\'s part: a start line that is %s', async (_label, start) => {
      // The first prompt of such a transcript opens the session only if the checkpoint is the session's first.
      const files = checkpointFiles(ULID, [start === undefined ? { transcript: session('a later prompt') } : { transcript: session('a later prompt'), start }]);
      repo.addRefCheckpoint(ULID, files);
      expect(await store.openingPrompt(repo.root, await locate(ULID), 'session-0')).toEqual({
        text: 'a later prompt',
        fromSessionStart: false,
      });
    });

    it('gives the same prompt for every checkpoint of a session, whichever part of the transcript is its own', async () => {
      // A later checkpoint stores the whole conversation so far, and marks where its own part begins.
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: session(OPENING), start: 0 }]));
      repo.addRefCheckpoint(OTHER_ULID, checkpointFiles(OTHER_ULID, [{ transcript: session(OPENING, 'second', 'third'), start: 3 }]));
      expect(await opening(ULID, 'session-0')).toBe(OPENING);
      expect(await opening(OTHER_ULID, 'session-0')).toBe(OPENING);
    });

    it('reads the slot of the session asked for, in a checkpoint that holds several', async () => {
      repo.addRefCheckpoint(
        ULID,
        checkpointFiles(ULID, [{ transcript: session('first session') }, { transcript: session('second session') }, {}]),
      );
      expect(await opening(ULID, 'session-0')).toBe('first session');
      expect(await opening(ULID, 'session-1')).toBe('second session');
      // A session with no stored transcript, and a session the checkpoint does not hold.
      expect(await opening(ULID, 'session-2')).toBeUndefined();
      expect(await opening(ULID, 'session-9')).toBeUndefined();
    });

    it('reads a legacy checkpoint', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, { [HEX]: checkpointFiles(HEX, [{ transcript: session(OPENING) }], legacyPrefix(HEX)) });
      expect(await opening(HEX, 'session-0')).toBe(OPENING);
    });

    it('looks past what the agent injected, and past lines that are not the user\'s', async () => {
      const transcript = [
        transcriptLine('assistant', [{ type: 'text', text: 'Resuming.' }]),
        transcriptLine('user', [{ text: '<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>' }]),
        transcriptLine('user', [{ text: 'add a retry to the upload' }]),
      ];
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript }]));
      expect(await opening(ULID, 'session-0')).toBe('add a retry to the upload');
    });

    it('finds the prompt at the start of a transcript far larger than the part it reads', async () => {
      const filler = transcriptLine('assistant', [{ type: 'text', text: 'x'.repeat(2000) }]);
      const transcript = [...session(OPENING), ...Array.from({ length: 800 }, () => filler), transcriptLine('user', [{ text: 'much later' }])];
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript }]));
      expect(transcript.join('\n').length).toBeGreaterThan(1024 * 1024);
      expect(await opening(ULID, 'session-0')).toBe(OPENING);
    });

    it('gives no name when the first prompt is longer than the part it reads, and does not take a later one', async () => {
      // A pasted document, say. A name from further down the conversation would be the wrong name.
      const transcript = [transcriptLine('user', [{ text: 'y'.repeat(400 * 1024) }]), ...session('not the opening prompt')];
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript }]));
      expect(await store.openingPrompt(repo.root, await locate(ULID), 'session-0')).toBeUndefined();
    });

    it('does not take the only slot of a checkpoint for the session when the slot names another', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: session(OPENING), start: 0 }]));
      expect(await opening(ULID, 'session-0')).toBe(OPENING);
      expect(await opening(ULID, 'some-other-session')).toBeUndefined();
    });

    it('gives no name for a session with no stored transcript, or a checkpoint with no sessions', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{}]));
      expect(await store.openingPrompt(repo.root, await locate(ULID), 'session-0')).toBeUndefined();
      repo.addRefCheckpoint(OTHER_ULID, { 'metadata.json': JSON.stringify({ checkpoint_id: OTHER_ULID, sessions: [] }) });
      expect(await store.openingPrompt(repo.root, await locate(OTHER_ULID), 'session-0')).toBeUndefined();
    });

    it('gives no name for a transcript in which the user says nothing', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: [transcriptLine('assistant', [{ type: 'text', text: 'Hello' }])] }]));
      expect(await store.openingPrompt(repo.root, await locate(ULID), 'session-0')).toBeUndefined();
    });
  });

  describe('asset', () => {
    const PNG = 'not really a png, but bytes all the same';

    it('reads an asset that sits beside the session transcript', async () => {
      repo.addRefCheckpoint(ULID, {
        ...checkpointFiles(ULID, [{}, { transcript: TRANSCRIPT }]),
        '1/assets/img-0a1b2c.png': PNG,
        '0/assets/img-0a1b2c.png': 'the other session',
      });
      const tree = await locate(ULID);
      const [, session] = await store.sessions(repo.root, tree);
      const asset = session && (await store.asset(repo.root, tree, session, 'assets/img-0a1b2c.png'));
      expect(asset).toBeInstanceOf(Buffer);
      expect(asset?.toString('utf8')).toBe(PNG);
    });

    it('reads an asset of a legacy checkpoint from inside its shard directory', async () => {
      repo.addLegacyCheckpoints(LEGACY_REMOTE, {
        [HEX]: { ...checkpointFiles(HEX, [{ transcript: TRANSCRIPT }], legacyPrefix(HEX)), '0/assets/img-ff.jpg': PNG },
      });
      const tree = await locate(HEX);
      const [session] = await store.sessions(repo.root, tree);
      expect((session && (await store.asset(repo.root, tree, session, 'assets/img-ff.jpg')))?.toString('utf8')).toBe(PNG);
    });

    it('finds the session directory from the metadata path when there is no transcript', async () => {
      repo.addRefCheckpoint(ULID, { ...checkpointFiles(ULID, [{}]), '0/assets/img-1.png': PNG });
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session?.compactTranscriptPath).toBeUndefined();
      expect((session && (await store.asset(repo.root, tree, session, 'assets/img-1.png')))?.toString('utf8')).toBe(PNG);
    });

    it('returns undefined for an asset that is not stored', async () => {
      repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT }]));
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.asset(repo.root, tree, session, 'assets/img-missing.png'))).toBeUndefined();
    });

    it.each([
      ['a path outside assets/', 'transcript.jsonl'],
      ['the session metadata', 'metadata.json'],
      ['a traversal out of assets/', 'assets/../metadata.json'],
      ['a traversal to another session', 'assets/../../1/full.jsonl'],
      ['a traversal to the checkpoint root', '../metadata.json'],
      ['a directory that merely starts with assets', 'assets-other/img.png'],
      ['an absolute-looking path outside assets/', '/0/full.jsonl'],
      ['odd characters', 'assets/img 1.png'],
      ['a ref-syntax character', 'assets/a:b.png'],
      ['an empty path', ''],
    ])('refuses %s', async (_label, assetPath) => {
      repo.addRefCheckpoint(ULID, {
        ...checkpointFiles(ULID, [{ transcript: TRANSCRIPT }, {}]),
        '0/assets-other/img.png': PNG,
        '0/assets/img 1.png': PNG,
      });
      const tree = await locate(ULID);
      const [session] = await store.sessions(repo.root, tree);
      expect(session && (await store.asset(repo.root, tree, session, assetPath))).toBeUndefined();
    });

    it('returns undefined for a session with no stored paths', async () => {
      repo.addRefCheckpoint(ULID, { ...checkpointFiles(ULID, [{}]), 'assets/img-1.png': PNG });
      const tree = await locate(ULID);
      expect(await store.asset(repo.root, tree, { index: 0 }, 'assets/img-1.png')).toBeUndefined();
    });
  });

  it('reads one checkpoint end to end: locate, sessions, metadata, transcript, start turn', async () => {
    repo.addRefCheckpoint(ULID, checkpointFiles(ULID, [{ transcript: TRANSCRIPT, start: 2 }]));
    const tree = await locate(ULID);
    const [session] = await store.sessions(repo.root, tree);
    if (!session) throw new Error('no session');
    const text = await store.compactTranscript(repo.root, tree, session);
    const meta = await store.sessionMeta(repo.root, tree, session);
    const parsed = parseCompactTranscript(text ?? '', meta?.compactTranscriptStart);

    expect(parsed.turns).toHaveLength(4);
    expect(parsed.startTurn).toBe(2);
    expect(parsed.turns[parsed.startTurn]?.blocks).toEqual([{ kind: 'text', text: 'Prompt of this checkpoint' }]);
  });
});
