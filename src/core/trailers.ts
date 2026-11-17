/** Legacy checkpoint ID: 12 lowercase hex characters. */
const HEX_ID = /^[0-9a-f]{12}$/;
/** Current checkpoint ID: a 26-character uppercase Crockford base32 ULID. */
const ULID_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isCheckpointId(value: string): boolean {
  return HEX_ID.test(value) || ULID_ID.test(value);
}

export function isCommitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value) || /^[0-9a-f]{64}$/.test(value);
}

/**
 * The Entire CLI's own pattern for a checkpoint link (`trailers.go`): the key
 * anywhere in the message, one ID, then whitespace or the end.
 *
 * It is deliberately not git's definition of a trailer. Git reads trailers
 * from the last paragraph only, and a squash merge joins the messages of the
 * commits it squashed, so each `Entire-Checkpoint` line ends up in a paragraph
 * of its own. Reading only git's trailer block would drop all but the last.
 */
const CHECKPOINT_LINK = /Entire-Checkpoint:\s*([0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26})(?:\s|$)/g;

/** Every checkpoint ID a commit message links to, in order, without duplicates. */
export function parseCheckpointIds(message: string): string[] {
  const ids: string[] = [];
  for (const match of message.matchAll(CHECKPOINT_LINK)) {
    const id = match[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface CommitRecord {
  sha: string;
  shortSha: string;
  /** Author time in seconds since the epoch. */
  authorTime: number;
  author: string;
  subject: string;
  /** Every checkpoint the commit message links to, in order, without duplicates. */
  checkpointIds: string[];
}

const FIELD = '\x1f';
const RECORD = '\x00';

/**
 * `git log` format that pairs with {@link parseLogRecords}. Use it with `-z`,
 * which ends each record with NUL. The last field is the whole message.
 */
export const LOG_FORMAT = ['%H', '%h', '%at', '%aN', '%s', '%B'].join('%x1f');

export function parseLogRecords(output: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const raw of output.split(RECORD)) {
    if (raw.trim() === '') continue;
    const fields = raw.split(FIELD);
    const [sha, shortSha, time, author, subject] = fields;
    if (!sha || !isCommitSha(sha)) continue;
    records.push({
      sha,
      shortSha: shortSha || sha.slice(0, 7),
      authorTime: Number.parseInt(time ?? '', 10) || 0,
      author: author ?? '',
      subject: subject ?? '',
      // A message can itself contain the field separator, so rejoin the rest.
      checkpointIds: parseCheckpointIds(fields.slice(5).join(FIELD)),
    });
  }
  return records;
}
