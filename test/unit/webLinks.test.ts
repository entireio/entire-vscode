import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WEB_BASE,
  commitUrl,
  parseEntireRemote,
  repoUrl,
  resolveWebBase,
  sessionUrl,
  type EntireRepo,
} from '../../src/core/webLinks';

describe('parseEntireRemote', () => {
  it('reads a GitHub mirror remote', () => {
    expect(parseEntireRemote('entire://us-east.entire.io/gh/entireio/cli')).toEqual({
      forge: 'gh',
      owner: 'entireio',
      repo: 'cli',
    });
  });

  it('reads an Entire-native remote', () => {
    expect(parseEntireRemote('entire://us-east.entire.io/et/my-project/my-repo')).toEqual({
      forge: 'et',
      owner: 'my-project',
      repo: 'my-repo',
    });
  });

  it.each(['.git', '.GIT', '.Git', '.gIt'])('drops a %s suffix', (suffix) => {
    expect(parseEntireRemote(`entire://host/gh/owner/repo${suffix}`)).toEqual({ forge: 'gh', owner: 'owner', repo: 'repo' });
  });

  it('accepts a trailing slash', () => {
    expect(parseEntireRemote('entire://host/et/project/repo/')).toEqual({ forge: 'et', owner: 'project', repo: 'repo' });
  });

  it('accepts a .git suffix followed by a trailing slash', () => {
    expect(parseEntireRemote('entire://host/gh/owner/repo.git/')).toEqual({ forge: 'gh', owner: 'owner', repo: 'repo' });
  });

  it('ignores whitespace around the URL', () => {
    expect(parseEntireRemote('  entire://host/gh/owner/repo\n')).toEqual({ forge: 'gh', owner: 'owner', repo: 'repo' });
  });

  it('keeps dots, dashes, and underscores in names', () => {
    expect(parseEntireRemote('entire://host:8443/gh/my.org/my-repo_2.0')).toEqual({
      forge: 'gh',
      owner: 'my.org',
      repo: 'my-repo_2.0',
    });
  });

  it('keeps a repository name that merely contains ".git"', () => {
    expect(parseEntireRemote('entire://host/gh/owner/my.github.io')?.repo).toBe('my.github.io');
  });

  it.each([
    ['undefined', undefined],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a github.com https remote', 'https://github.com/entireio/cli.git'],
    ['a github.com scp-style ssh remote', 'git@github.com:entireio/cli.git'],
    ['a github.com ssh:// remote', 'ssh://git@github.com/entireio/cli.git'],
    ['an https URL on an Entire host', 'https://us-east.entire.io/gh/entireio/cli'],
    ['a GitLab forge prefix', 'entire://host/gl/owner/repo'],
    ['a Bitbucket forge prefix', 'entire://host/bb/owner/repo'],
    ['a spelled-out forge prefix', 'entire://host/github/owner/repo'],
    ['no forge prefix', 'entire://host/owner/repo'],
    ['a missing host', 'entire:///gh/owner/repo'],
    ['a missing host, with the forge in its place', 'entire://gh/owner/repo'],
    ['a missing repository', 'entire://host/gh/owner'],
    ['a missing repository after a slash', 'entire://host/gh/owner/'],
    ['a missing owner', 'entire://host/gh//repo'],
    ['a repository that is only .git', 'entire://host/gh/owner/.git'],
    ['an extra path segment', 'entire://host/gh/owner/repo/extra'],
    ['a deep path', 'entire://host/gh/owner/repo/tree/main'],
    ['two trailing slashes', 'entire://host/gh/owner/repo//'],
    ['whitespace inside', 'entire://host/gh/owner/re po'],
    ['a different scheme with the same shape', 'entirex://host/gh/owner/repo'],
    ['a scheme prefix', 'xentire://host/gh/owner/repo'],
  ])('rejects %s', (_label, remote) => {
    expect(parseEntireRemote(remote)).toBeUndefined();
  });
});

const REPO: EntireRepo = { forge: 'gh', owner: 'entireio', repo: 'cli' };
const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('URL builders', () => {
  it('builds the repository URL', () => {
    expect(repoUrl(DEFAULT_WEB_BASE, REPO)).toBe('https://entire.com/gh/entireio/cli');
    expect(repoUrl(DEFAULT_WEB_BASE, { forge: 'et', owner: 'project', repo: 'repo' })).toBe(
      'https://entire.com/et/project/repo',
    );
  });

  it('builds the commit URL under the repository', () => {
    expect(commitUrl(DEFAULT_WEB_BASE, REPO, SHA)).toBe(`https://entire.com/gh/entireio/cli/commit/${SHA}`);
  });

  it('builds the session URL under the repository', () => {
    expect(sessionUrl(DEFAULT_WEB_BASE, REPO, '11111111-2222-4333-8444-555555555555')).toBe(
      'https://entire.com/gh/entireio/cli/session/11111111-2222-4333-8444-555555555555',
    );
  });

  it('builds on a base that has a path', () => {
    expect(repoUrl('https://staging.example.com/app', REPO)).toBe('https://staging.example.com/app/gh/entireio/cli');
  });

  it('percent-encodes the owner and repository', () => {
    const url = repoUrl(DEFAULT_WEB_BASE, { forge: 'gh', owner: 'a b#c', repo: 'x?y%z' });
    expect(url).toBe('https://entire.com/gh/a%20b%23c/x%3Fy%25z');
    const parsed = new URL(url);
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(parsed.pathname.split('/').map(decodeURIComponent)).toEqual(['', 'gh', 'a b#c', 'x?y%z']);
  });

  it('percent-encodes a session ID so it stays one path segment', () => {
    const url = sessionUrl(DEFAULT_WEB_BASE, REPO, 'ses_1/../../admin?x=1#top');
    const parsed = new URL(url);
    expect(parsed.origin).toBe('https://entire.com');
    expect(parsed.search).toBe('');
    expect(parsed.hash).toBe('');
    expect(parsed.pathname.split('/')).toHaveLength(6);
    expect(decodeURIComponent(parsed.pathname.split('/')[5] ?? '')).toBe('ses_1/../../admin?x=1#top');
  });

  it('percent-encodes the commit segment', () => {
    const parsed = new URL(commitUrl(DEFAULT_WEB_BASE, REPO, 'abc/def?g'));
    expect(parsed.search).toBe('');
    expect(parsed.pathname).toBe('/gh/entireio/cli/commit/abc%2Fdef%3Fg');
  });

  it('encodes non-ASCII names to an ASCII-only URL that decodes back', () => {
    const url = repoUrl(DEFAULT_WEB_BASE, { forge: 'et', owner: 'prøjekt', repo: 'репо' });
    expect(url).toMatch(/^[\x21-\x7e]+$/);
    expect(decodeURIComponent(url)).toBe('https://entire.com/et/prøjekt/репо');
  });

  it('links a parsed remote', () => {
    const repo = parseEntireRemote('entire://us-east.entire.io/gh/entireio/cli.git');
    expect(repo && repoUrl(DEFAULT_WEB_BASE, repo)).toBe('https://entire.com/gh/entireio/cli');
  });
});

describe('resolveWebBase', () => {
  it('defaults to entire.com', () => {
    expect(DEFAULT_WEB_BASE).toBe('https://entire.com');
    expect(resolveWebBase(undefined, {})).toBe('https://entire.com');
    expect(resolveWebBase('', {})).toBe('https://entire.com');
  });

  it('uses the setting first', () => {
    expect(resolveWebBase('https://setting.example.com', { ENTIRE_WEB_BASE_URL: 'https://env.example.com' })).toBe(
      'https://setting.example.com',
    );
  });

  it.each([undefined, '', '   '])('uses ENTIRE_WEB_BASE_URL when the setting is %j', (setting) => {
    expect(resolveWebBase(setting, { ENTIRE_WEB_BASE_URL: 'https://env.example.com' })).toBe('https://env.example.com');
  });

  it('accepts plain http, for a local server', () => {
    expect(resolveWebBase('http://localhost:3000', {})).toBe('http://localhost:3000');
  });

  it('trims whitespace and trailing slashes', () => {
    expect(resolveWebBase('  https://setting.example.com/  ', {})).toBe('https://setting.example.com');
    expect(resolveWebBase('https://setting.example.com///', {})).toBe('https://setting.example.com');
  });

  it('keeps a base path', () => {
    expect(resolveWebBase('https://setting.example.com/app/', {})).toBe('https://setting.example.com/app');
  });

  it('returns a base that the URL builders can extend, even when the setting has a query or fragment', () => {
    const base = resolveWebBase('https://setting.example.com/app/?tab=1#top', {});
    expect(repoUrl(base, REPO)).toBe('https://setting.example.com/app/gh/entireio/cli');
  });

  it.each([
    ['an ftp URL', 'ftp://files.example.com'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a file URL', 'file:///etc/passwd'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['an entire:// URL', 'entire://us-east.entire.io'],
    ['a bare host', 'entire.com'],
    ['a host and port with no scheme', 'localhost:3000'],
    ['prose', 'not a url'],
  ])('ignores a setting that is %s and falls back to the environment', (_label, setting) => {
    expect(resolveWebBase(setting, { ENTIRE_WEB_BASE_URL: 'https://env.example.com' })).toBe('https://env.example.com');
  });

  it.each(['ftp://files.example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'entire.com', 'nope'])(
    'ignores the non-http environment value %j and falls back to the default',
    (value) => {
      expect(resolveWebBase(undefined, { ENTIRE_WEB_BASE_URL: value })).toBe(DEFAULT_WEB_BASE);
    },
  );

  it('falls back to the default when both sources are unusable', () => {
    expect(resolveWebBase('javascript:alert(1)', { ENTIRE_WEB_BASE_URL: 'ftp://files.example.com' })).toBe(DEFAULT_WEB_BASE);
  });

  it('does not let an invalid setting hide a valid environment value', () => {
    expect(resolveWebBase('::::', { ENTIRE_WEB_BASE_URL: 'http://127.0.0.1:8080/' })).toBe('http://127.0.0.1:8080');
  });
});
