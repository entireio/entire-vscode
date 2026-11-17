// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { button, h } from '../../src/webview/dom';

const XSS = '<img src=x onerror=alert(1)>';

describe('h', () => {
  it('creates an element of the given tag', () => {
    const element = h('section');
    expect(element.tagName).toBe('SECTION');
    expect(element.childNodes).toHaveLength(0);
    expect(element.getAttributeNames()).toEqual([]);
  });

  it('sets the class, title, and attributes', () => {
    const element = h('span', { class: 'chip strong', title: 'Copy commit SHA', attrs: { role: 'status', 'aria-hidden': 'true' } });
    expect(element.className).toBe('chip strong');
    expect(element.title).toBe('Copy commit SHA');
    expect(element.getAttribute('role')).toBe('status');
    expect(element.getAttribute('aria-hidden')).toBe('true');
  });

  it('puts the text in as text, never as markup', () => {
    const element = h('p', { text: `Hello ${XSS} <script>alert(1)</script>` });
    expect(element.textContent).toBe(`Hello ${XSS} <script>alert(1)</script>`);
    expect(element.children).toHaveLength(0);
  });

  it('keeps an empty text', () => {
    const element = h('p', { text: '' });
    expect(element.textContent).toBe('');
  });

  it('appends element and string children in order, with strings as text', () => {
    const child = h('span', { text: 'inner' });
    const element = h('p', {}, 'before ', child, ` after ${XSS}`);
    expect(element.textContent).toBe(`before inner after ${XSS}`);
    expect(element.children).toHaveLength(1);
    expect(element.children[0]).toBe(child);
    expect(element.querySelector('img')).toBeNull();
  });

  it('skips children that are undefined, null, or false', () => {
    const element = h('div', {}, undefined, h('span', { text: 'kept' }), null, false, 'text');
    expect(element.childNodes).toHaveLength(2);
    expect(element.textContent).toBe('kepttext');
  });

  it('keeps an empty string child out of the way of the others', () => {
    const element = h('div', {}, '', h('span', { text: 'a' }));
    expect(element.textContent).toBe('a');
  });

  it('does not treat an attribute value as markup', () => {
    const element = h('a', { attrs: { href: 'https://example.com/"><script>alert(1)</script>' } });
    expect(element.getAttribute('href')).toBe('https://example.com/"><script>alert(1)</script>');
    expect(element.children).toHaveLength(0);
  });
});

describe('button', () => {
  it('creates a button that does not submit, with its label as text', () => {
    const element = button(`Open ${XSS}`, 'primary', () => {});
    expect(element.tagName).toBe('BUTTON');
    expect(element.getAttribute('type')).toBe('button');
    expect(element.className).toBe('primary');
    expect(element.textContent).toBe(`Open ${XSS}`);
    expect(element.children).toHaveLength(0);
  });

  it('calls the handler on each click', () => {
    const onClick = vi.fn();
    const element = button('Retry', 'primary', onClick);
    expect(onClick).not.toHaveBeenCalled();
    element.click();
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('sets a title when one is given, and none otherwise', () => {
    expect(button('abc1234', 'chip', () => {}, 'Copy commit SHA').title).toBe('Copy commit SHA');
    expect(button('Retry', 'primary', () => {}).hasAttribute('title')).toBe(false);
  });
});
