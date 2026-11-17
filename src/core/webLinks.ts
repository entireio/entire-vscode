/** A repository that Entire hosts, as addressed by an `entire://` remote. */
export interface EntireRepo {
  /** `gh` for a GitHub mirror, `et` for an Entire-native repository. */
  forge: 'gh' | 'et';
  /** GitHub owner, or Entire project. */
  owner: string;
  repo: string;
}

export const DEFAULT_WEB_BASE = 'https://entire.com';

/**
 * Parses `entire://<cluster-host>/<forge>/<owner-or-project>/<repo>[.git]`.
 *
 * Only this scheme proves that Entire hosts the repository. A github.com
 * remote might be connected through the GitHub App, and nothing in a local
 * clone says whether it is, so it gets no links.
 */
export function parseEntireRemote(remoteUrl: string | undefined): EntireRepo | undefined {
  if (!remoteUrl) return undefined;
  const match = /^entire:\/\/([^/\s]+)\/(gh|et)\/([^/\s]+)\/([^/\s]+?)\/?$/.exec(remoteUrl.trim());
  if (!match) return undefined;
  const [, , forge, owner, rawRepo] = match;
  const repo = (rawRepo ?? '').replace(/\.git$/i, '');
  if (!owner || !repo) return undefined;
  return { forge: forge as 'gh' | 'et', owner, repo };
}

/**
 * Picks the web origin: the setting, then `ENTIRE_WEB_BASE_URL`, then
 * entire.com. A value that is not an http(s) URL is ignored.
 */
export function resolveWebBase(setting: string | undefined, env: NodeJS.ProcessEnv): string {
  for (const candidate of [setting, env.ENTIRE_WEB_BASE_URL]) {
    const value = candidate?.trim();
    if (!value) continue;
    try {
      const url = new URL(value);
      if (url.protocol === 'https:' || url.protocol === 'http:') {
        return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
      }
    } catch {
      // Not a URL; try the next source.
    }
  }
  return DEFAULT_WEB_BASE;
}

export function repoUrl(base: string, repo: EntireRepo): string {
  return `${base}/${repo.forge}/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

/** Checkpoints have no page of their own. The commit page is the way in. */
export function commitUrl(base: string, repo: EntireRepo, sha: string): string {
  return `${repoUrl(base, repo)}/commit/${encodeURIComponent(sha)}`;
}

export function sessionUrl(base: string, repo: EntireRepo, sessionId: string): string {
  return `${repoUrl(base, repo)}/session/${encodeURIComponent(sessionId)}`;
}
