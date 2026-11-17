// @vitest-environment jsdom
// The page of the Brain view is parsed here the way the editor's webview
// parses it, to check what a reader can and cannot click. It is a string
// built on the host, with no script of its own.
import { describe, expect, it } from 'vitest';
import type { BrainDetail } from '../../src/core/brain';
import { BRAIN_PAGE_COMMANDS, brainPageHtml, escapeHtml, type BrainPageSection } from '../../src/core/brainPage';

const NONCE = 'bm9uY2U=';
const XSS = '<img src=x onerror=alert(1)>';

const DETAILS: BrainDetail[] = [
  { key: 'state', label: 'Brain', value: 'Built · updated 2h ago' },
  { key: 'graph', label: 'Code graph', value: '60 files · 900 symbols · 3,200 relations' },
  { key: 'freshness', label: 'Freshness', value: 'Degraded', attention: true, tooltip: 'graph: 4 commits behind HEAD' },
  { key: 'warning', label: 'Warning', value: 'agents not wired', tooltip: 'agents not wired', attention: true },
];

function section(overrides: Partial<BrainPageSection> = {}): BrainPageSection {
  return { root: '/repos/widget', name: 'widget', state: 'ready', details: DETAILS, ...overrides };
}

/** The page as a document. */
function page(sections: BrainPageSection[]): Document {
  return new DOMParser().parseFromString(brainPageHtml(sections, NONCE), 'text/html');
}

/** What a link runs: the command, and the arguments it passes. */
function target(link: Element): { command: string; args: unknown[] | undefined } {
  const href = link.getAttribute('href') ?? '';
  const [command = '', query] = href.replace(/^command:/, '').split('?');
  return { command, args: query === undefined ? undefined : (JSON.parse(decodeURIComponent(query)) as unknown[]) };
}

const buttons = (doc: Document): { label: string; command: string; args: unknown[] | undefined }[] =>
  [...doc.querySelectorAll('a')].map((link) => ({ label: link.textContent ?? '', ...target(link) }));

describe('brainPageHtml', () => {
  it('lists what the brain holds as text, under a button that opens its graph', () => {
    const doc = page([section()]);
    expect(buttons(doc)).toEqual([{ label: 'View Brain', command: 'entire.openBrainGraph', args: ['/repos/widget'] }]);
    const rows = [...doc.querySelectorAll('dl .row')].map((row) => [
      row.querySelector('dt')?.textContent,
      row.querySelector('dd')?.textContent,
    ]);
    expect(rows).toEqual([
      ['Brain', 'Built · updated 2h ago'],
      ['Code graph', '60 files · 900 symbols · 3,200 relations'],
      ['Freshness', 'Degraded'],
      ['Warning', 'agents not wired'],
    ]);
  });

  it('gives a detail nothing to click: no link, no button, and nothing that takes the keyboard', () => {
    const doc = page([section()]);
    const details = doc.querySelector('dl');
    expect(details?.querySelectorAll('a, button, [role="button"], [tabindex], [onclick], input, summary')).toHaveLength(0);
    // The only things on the page that act are its buttons, and every one of them is a command link.
    const acting = doc.querySelectorAll('a, button, [role="button"], [tabindex], input, summary');
    expect([...acting].map((element) => element.tagName)).toEqual(['A']);
    expect(doc.querySelector('a')?.getAttribute('role')).toBe('button');
  });

  it('marks what needs a look, and says why on hover', () => {
    const doc = page([section()]);
    const [, , freshness, warning] = [...doc.querySelectorAll('dl .row')];
    expect(doc.querySelectorAll('dl .row.attention')).toHaveLength(2);
    expect(freshness?.classList.contains('attention')).toBe(true);
    // The reason is on the label and on the value, which are what the pointer can rest on.
    expect(freshness?.querySelector('dt')?.getAttribute('title')).toBe('graph: 4 commits behind HEAD');
    expect(freshness?.querySelector('dd')?.getAttribute('title')).toBe('graph: 4 commits behind HEAD');
    expect(warning?.querySelector('dd')?.getAttribute('title')).toBe('agents not wired');
    // A detail with nothing more to say has no hover text.
    expect(doc.querySelector('dl .row')?.querySelector('[title]')).toBeNull();
  });

  it('says where the graph is running, and offers to stop it', () => {
    const doc = page([section({ running: '127.0.0.1:50828' })]);
    expect(buttons(doc)).toEqual([
      { label: 'View Brain', command: 'entire.openBrainGraph', args: ['/repos/widget'] },
      { label: 'Stop', command: 'entire.stopBrainGraph', args: ['/repos/widget'] },
    ]);
    expect(doc.body.textContent).toContain('The graph is running on 127.0.0.1:50828.');
    expect(page([section()]).body.textContent).not.toContain('running on');
  });

  it.each([
    ['loading', 'Loading…', []],
    [
      'pluginMissing',
      'entire plugin install brain',
      [
        ['Copy Command', 'entire.copyBrainInstallCommand'],
        ['Retry', 'entire.refresh'],
      ],
    ],
    [
      'noBrain',
      'entire brain setup',
      [
        ['Copy Command', 'entire.copyBrainSetupCommand'],
        ['Retry', 'entire.refresh'],
      ],
    ],
    [
      'failed',
      'could not read the brain',
      [
        ['Retry', 'entire.refresh'],
        ['Show Log', 'entire.showLog'],
      ],
    ],
  ] as const)('says why there is nothing to list when the brain is %s, and offers what helps', (state, text, expected) => {
    const doc = page([section({ state, details: [] })]);
    expect(doc.body.textContent).toContain(text);
    expect(buttons(doc).map(({ label, command }) => [label, command])).toEqual(expected);
    // No graph button for a brain that cannot be shown, and no empty list.
    expect(doc.body.textContent).not.toContain('View Brain');
    expect(doc.querySelector('dl')).toBeNull();
  });

  it('does not run a command to install the plugin or build a brain: it copies one', () => {
    for (const state of ['pluginMissing', 'noBrain'] as const) {
      const commands = buttons(page([section({ state, details: [] })])).map(({ command }) => command);
      expect(commands.every((command) => command.startsWith('entire.copy') || command === 'entire.refresh')).toBe(true);
    }
  });

  it('heads each repository with its name when there are several, and passes each button its own repository', () => {
    const doc = page([section(), section({ root: '/repos/docs', name: 'docs', state: 'noBrain', details: [] })]);
    expect([...doc.querySelectorAll('h2')].map((heading) => heading.textContent)).toEqual(['widget', 'docs']);
    expect(doc.querySelectorAll('section')).toHaveLength(2);
    expect(buttons(doc)[0]).toEqual({ label: 'View Brain', command: 'entire.openBrainGraph', args: ['/repos/widget'] });
    // With one repository the view's own title is heading enough.
    expect(page([section()]).querySelector('h2')).toBeNull();
  });

  it('says so when no repository has Entire enabled', () => {
    const doc = page([]);
    expect(doc.body.textContent?.trim()).toBe('Entire is not enabled in an open repository.');
    expect(doc.querySelector('a')).toBeNull();
  });

  it('links only to the commands the page is allowed to run', () => {
    const states = ['ready', 'loading', 'pluginMissing', 'noBrain', 'failed'] as const;
    const doc = page(states.map((state) => section({ state, running: '127.0.0.1:1', details: state === 'ready' ? DETAILS : [] })));
    const used = new Set(buttons(doc).map(({ command }) => command));
    expect([...used].sort()).toEqual([...BRAIN_PAGE_COMMANDS].sort());
    for (const link of doc.querySelectorAll('a')) expect(link.getAttribute('href')).toMatch(/^command:entire\.[A-Za-z]+(\?|$)/);
  });

  it('shows what the plugin and the repository say as text, never as markup', () => {
    const hostile: BrainDetail[] = [{ key: 'warning', label: XSS, value: XSS, tooltip: `"${XSS}`, attention: true }];
    const html = brainPageHtml([section({ name: XSS, root: `/repos/"><script>alert(1)</script>`, details: hostile, running: XSS })], NONCE);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelector('img, script')).toBeNull();
    expect(doc.querySelector('dd')?.textContent).toBe(XSS);
    expect(doc.querySelector('dt')?.textContent).toBe(XSS);
    expect(doc.querySelector('dd')?.getAttribute('title')).toBe(`"${XSS}`);
    // The repository path survives the trip through the link, whatever is in it.
    expect(target(doc.querySelector('a') as Element).args).toEqual([`/repos/"><script>alert(1)</script>`]);
    // With several repositories, a name is a heading, and is escaped there too.
    const many = page([section({ name: XSS }), section({ name: 'docs', root: '/repos/docs' })]);
    expect(many.querySelector('h2')?.textContent).toBe(XSS);
    expect(many.querySelector('img')).toBeNull();
  });

  it('runs no script and loads nothing', () => {
    const html = brainPageHtml([section({ running: '127.0.0.1:50828' })], NONCE);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script, img, iframe, link, object, embed, form, base')).toHaveLength(0);
    for (const element of doc.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        // No event handler, and nothing fetched: the only addresses are command links.
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.name).not.toBe('src');
        if (attribute.name === 'href') expect(attribute.value).toMatch(/^command:entire\./);
      }
    }
    expect(html).not.toMatch(/javascript:|https?:\/\//i);
    const policy = doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content');
    expect(policy).toBe(`default-src 'none'; style-src 'nonce-${NONCE}'`);
    expect(doc.querySelector('style')?.getAttribute('nonce')).toBe(NONCE);
    expect(doc.querySelectorAll('[style]')).toHaveLength(0);
  });

  it('is the same text for the same content, so the view is not reloaded for nothing', () => {
    expect(brainPageHtml([section()], NONCE)).toBe(brainPageHtml([section()], NONCE));
    expect(brainPageHtml([section()], NONCE)).not.toBe(brainPageHtml([section({ running: '127.0.0.1:1' })], NONCE));
  });
});

describe('escapeHtml', () => {
  it('escapes what would start a tag, an entity, or end an attribute', () => {
    expect(escapeHtml(`<a href="x" title='y'>&amp;</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;amp;&lt;/a&gt;');
    expect(escapeHtml('plain text · 3,200')).toBe('plain text · 3,200');
  });
});
