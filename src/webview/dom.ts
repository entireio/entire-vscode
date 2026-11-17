type Child = Node | string | undefined | null | false;

interface Props {
  class?: string;
  text?: string;
  title?: string;
  attrs?: Record<string, string>;
}

/** Creates an element. Text always goes in through `textContent`, never as markup. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  if (props.text !== undefined) element.textContent = props.text;
  if (props.title) element.title = props.title;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    element.append(child);
  }
  return element;
}

export function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const element = h('button', { class: className, text: label, attrs: { type: 'button' }, ...(title ? { title } : {}) });
  element.addEventListener('click', onClick);
  return element;
}

/** "Mar 4, 3:07 PM" in the reader's locale. Empty for a missing or unreadable time. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
