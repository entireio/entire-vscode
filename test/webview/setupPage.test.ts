// @vitest-environment jsdom
// The page of the Setup view is parsed here the way the editor's webview
// parses it, to check what a reader can click and what each button runs. It
// is a string built on the host, with no script of its own.
import { describe, expect, it } from 'vitest';
import { setupModel, type MachineFacts, type RepoFacts } from '../../src/core/setup';
import { SETUP_PAGE_COMMANDS, setupPageHtml, type SetupPage } from '../../src/core/setupPage';

const NONCE = 'bm9uY2U=';
const XSS = '<img src=x onerror=alert(1)>';

const machine = (overrides: Partial<MachineFacts> = {}): MachineFacts => ({
  cli: 'ok',
  cliVersion: '0.13.4',
  login: 'loggedOut',
  graphPlugin: 'missing',
  ...overrides,
});

const repo = (overrides: Partial<RepoFacts> = {}): RepoFacts => ({
  root: '/repos/widget',
  name: 'widget',
  enabled: false,
  hosted: true,
  graphGuide: false,
  brain: 'pluginMissing',
  ...overrides,
});

const steps = (facts: MachineFacts, repos: RepoFacts[]): SetupPage => ({ kind: 'steps', model: setupModel(facts, repos) });

function parse(page: SetupPage): Document {
  return new DOMParser().parseFromString(setupPageHtml(page, NONCE), 'text/html');
}

/** What each link runs: its label, the command, and the arguments it passes. */
function buttons(doc: Document): { label: string; command: string; args?: unknown[] }[] {
  return [...doc.querySelectorAll('a')].map((link) => {
    const href = link.getAttribute('href') ?? '';
    const [command = '', query] = href.replace(/^command:/, '').split('?');
    return {
      label: link.textContent ?? '',
      command,
      ...(query === undefined ? {} : { args: JSON.parse(decodeURIComponent(query)) as unknown[] }),
    };
  });
}

describe('setupPageHtml', () => {
  it('lists the steps of the machine, then those of the repository, each with its state', () => {
    const doc = parse(steps(machine(), [repo()]));
    expect([...doc.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['This Machine', 'widget']);
    const rows = [...doc.querySelectorAll('li.step')].map((row) => [
      row.getAttribute('data-step'),
      row.querySelector('.title')?.textContent,
      row.querySelector('.status')?.textContent,
    ]);
    expect(rows).toEqual([
      ['cli', 'Entire CLI', 'Done'],
      ['login', 'Login', 'Needed'],
      ['enable', 'Enable Entire', 'Needed'],
      ['graph', 'Graph', 'Optional'],
      ['brain', 'Brain', 'Optional'],
      ['connect', 'Brain Connect', 'Waiting'],
    ]);
  });

  it('passes each button its repository and its action, and null for a step of the machine', () => {
    const doc = parse(steps(machine(), [repo()]));
    expect(buttons(doc)).toEqual([
      { label: 'Log In', command: 'entire.runSetupStep', args: [null, 'login'] },
      { label: 'Enable', command: 'entire.runSetupStep', args: ['/repos/widget', 'enable'] },
      { label: 'Install Plugin', command: 'entire.runSetupStep', args: ['/repos/widget', 'installGraph'] },
      { label: 'Install Plugin', command: 'entire.runSetupStep', args: ['/repos/widget', 'installBrain'] },
      { label: 'Check Again', command: 'entire.checkSetup' },
      { label: 'Hide Setup', command: 'entire.hideSetup' },
    ]);
  });

  it('offers to install the CLI or set its path when it is missing', () => {
    const doc = parse(steps({ cli: 'missing' }, [repo({ enabled: undefined })]));
    expect(buttons(doc).slice(0, 2)).toEqual([
      { label: 'Install', command: 'entire.runSetupStep', args: [null, 'installCli'] },
      { label: 'Set Path', command: 'entire.runSetupStep', args: [null, 'setCliPath'] },
    ]);
    expect(doc.querySelector('[data-step="enable"] p')?.textContent).toBe('Needs the Entire CLI.');
  });

  it('says so when everything is set up, and keeps the way to hide the view', () => {
    const doc = parse(
      steps(machine({ login: 'loggedIn', graphPlugin: 'installed' }), [
        repo({ enabled: true, graphGuide: true, brain: 'built', brainHosted: 'connected' }),
      ]),
    );
    expect(doc.querySelector('.summary')?.textContent).toMatch(/^Entire is set up\./);
    expect(buttons(doc)).toEqual([
      { label: 'Check Again', command: 'entire.checkSetup' },
      { label: 'Hide Setup', command: 'entire.hideSetup' },
    ]);
  });

  it('asks for a repository when none is open, and says when it is loading', () => {
    expect(parse({ kind: 'noRepository' }).body.textContent).toContain('Open a folder that contains a Git repository');
    expect(buttons(parse({ kind: 'noRepository' }))).toEqual([{ label: 'Hide Setup', command: 'entire.hideSetup' }]);
    expect(parse({ kind: 'loading' }).body.textContent?.trim()).toBe('Loading…');
  });

  it('links only to the commands the page is allowed to run', () => {
    const pages: SetupPage[] = [
      steps({ cli: 'missing' }, [repo()]),
      steps(machine(), [repo()]),
      { kind: 'noRepository' },
    ];
    const used = new Set(pages.flatMap((page) => buttons(parse(page)).map(({ command }) => command)));
    expect([...used].sort()).toEqual([...SETUP_PAGE_COMMANDS].sort());
    for (const page of pages) {
      for (const link of parse(page).querySelectorAll('a')) {
        expect(link.getAttribute('href')).toMatch(/^command:entire\.[A-Za-z]+(\?|$)/);
      }
    }
  });

  it('shows what repositories and the CLI say as text, never as markup', () => {
    const hostile = repo({ name: XSS, root: `/repos/"><script>alert(1)</script>` });
    const html = setupPageHtml(steps(machine({ login: 'loggedIn', user: XSS }), [hostile]), NONCE);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('img, script')).toBeNull();
    expect(doc.querySelectorAll('h2')[1]?.textContent).toBe(XSS);
    expect(doc.querySelector('[data-step="login"] p')?.textContent).toBe(`Logged in to Entire as ${XSS}.`);
    // The repository's path survives the trip through the link, whatever is in it.
    expect(buttons(doc).find((entry) => entry.label === 'Enable')?.args).toEqual([`/repos/"><script>alert(1)</script>`, 'enable']);
  });

  it('runs no script and loads nothing', () => {
    const html = setupPageHtml(steps(machine(), [repo()]), NONCE);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script, img, iframe, link, object, embed, form, base')).toHaveLength(0);
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.name).not.toBe('src');
        if (attribute.name === 'href') expect(attribute.value).toMatch(/^command:entire\./);
      }
    }
    expect(html).not.toMatch(/javascript:|https?:\/\//i);
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
    expect(policy).toBe(`default-src 'none'; style-src 'nonce-${NONCE}'`);
    expect(doc.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('is the same text for the same content, so the view is not reloaded for nothing', () => {
    expect(setupPageHtml(steps(machine(), [repo()]), NONCE)).toBe(setupPageHtml(steps(machine(), [repo()]), NONCE));
    expect(setupPageHtml(steps(machine(), [repo()]), NONCE)).not.toBe(
      setupPageHtml(steps(machine({ login: 'loggedIn' }), [repo()]), NONCE),
    );
  });
});
