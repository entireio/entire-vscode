const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "5m ago", "3h ago", "6d ago", then a date. Empty for an unknown time. */
export function relativeTime(time: number | string | undefined, now = Date.now()): string {
  if (time === undefined || time === '') return '';
  const then = typeof time === 'number' ? time : Date.parse(time);
  if (!Number.isFinite(then)) return '';
  const elapsed = now - then;
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d ago`;
  const date = new Date(then);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return (sameYear ? DAY_OF_YEAR : DAY_WITH_YEAR).format(date);
}

// Made once: building a formatter costs far more than using one, and a list
// formats a date for every row each time it redraws.
const DAY_OF_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_WITH_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** 950 -> "950", 12_400 -> "12.4K", 10_407_798 -> "10.4M". */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  let value = count;
  let unit = '';
  for (const next of ['K', 'M', 'B']) {
    value /= 1000;
    unit = next;
    // Rounding can reach 1000 (999,950 would read "1000K"), which belongs to the next unit.
    if (Number(value.toFixed(1)) < 1000) break;
  }
  return `${trimZero(value.toFixed(1))}${unit}`;
}

/**
 * "12 of 249" for a checkpoint's place in its session. A plus sign after the
 * total means the session may have earlier checkpoints than the ones counted.
 */
export function formatPosition(position: { ordinal: number; total: number; mayHaveEarlier: boolean }): string {
  const total = `${position.total.toLocaleString('en-US')}${position.mayHaveEarlier ? '+' : ''}`;
  return `${position.ordinal.toLocaleString('en-US')} of ${total}`;
}

/** Shortens text to `limit` characters, ending in an ellipsis, without splitting a surrogate pair. */
export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let end = Math.max(0, limit - 1);
  const edge = text.charCodeAt(end - 1);
  if (edge >= 0xd800 && edge <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

function trimZero(value: string): string {
  return value.endsWith('.0') ? value.slice(0, -2) : value;
}

/** The first non-empty line of `text`, shortened to `limit` characters. */
export function headline(text: string | undefined, limit = 90): string {
  if (!text) return '';
  const line = text
    .split('\n')
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== '');
  if (!line) return '';
  return truncate(line, limit);
}

/** Joins the parts that have content with a middle dot. */
export function joinParts(...parts: (string | undefined)[]): string {
  return parts.filter((part): part is string => !!part).join(' · ');
}
