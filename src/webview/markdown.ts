import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// A transcript can contain any image URL, and loading one would tell a remote
// server that the transcript was opened. Images become plain links.
md.renderer.rules.image = (tokens, index) => {
  const token = tokens[index];
  const source = String(token?.attrGet('src') ?? '');
  const label = token?.content || 'image';
  return `<a href="${md.utils.escapeHtml(source)}">${md.utils.escapeHtml(label)}</a>`;
};

/**
 * Renders assistant text to sanitized HTML.
 *
 * markdown-it runs with raw HTML off, so tags in the text come out escaped.
 * DOMPurify then removes anything that could load a resource, run script, or
 * restyle the page, in case a markdown-it rule ever lets something through.
 */
export function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(md.render(text), {
    FORBID_TAGS: ['style', 'img', 'picture', 'video', 'audio', 'source', 'form', 'input', 'button', 'iframe', 'svg', 'math'],
    FORBID_ATTR: ['style', 'class', 'id', 'name', 'srcset'],
    ALLOW_DATA_ATTR: false,
  });
}
