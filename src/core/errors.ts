/** Why a git or Entire CLI call did not produce usable data. */
export type FailureKind =
  | 'cliMissing'
  | 'cliTooOld'
  | 'notGit'
  | 'notEnabled'
  | 'notFound'
  /** entire.io rejected the call because no login is saved, or the saved one expired. */
  | 'notLoggedIn'
  /** The project is not on entire.io, or the saved login cannot see it. */
  | 'noAccess'
  /** The command belongs to a plugin of the Entire CLI that is not installed. */
  | 'pluginMissing'
  | 'timeout'
  | 'aborted'
  | 'exit'
  | 'spawn'
  | 'unexpectedOutput';

export interface Failure {
  kind: FailureKind;
  /** One sentence that is safe to show in the UI. */
  message: string;
  /** Extra context for the log, such as stderr. */
  detail?: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(kind: FailureKind, message: string, detail?: string): Result<T> {
  return { ok: false, failure: detail === undefined ? { kind, message } : { kind, message, detail } };
}
