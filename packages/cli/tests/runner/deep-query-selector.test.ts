import { describe, it, expect } from 'vitest';
import { DEEP_QS } from '../../src/runner/cdp-client.js';

/**
 * Tests for the DEEP_QS shadow-DOM-piercing querySelector function.
 *
 * Since we run in a Node (non-DOM) environment, we build a lightweight
 * mock DOM tree that mirrors the relevant API surface:
 *   - querySelectorAll('*') returns all descendants
 *   - querySelector(sel) finds by id ("#id") or attribute ("[data-testid='x']")
 *   - shadowRoot property points to a shadow root (or is undefined)
 */

// ─── Minimal DOM mock ────────────────────────────────────────────────────────

interface MockElement {
  id: string;
  attrs: Record<string, string>;
  shadowRoot?: MockShadowRoot;
  children: MockElement[];
}

interface MockShadowRoot {
  children: MockElement[];
  querySelector(sel: string): MockElement | null;
  querySelectorAll(sel: string): MockElement[];
}

function createElement(id: string, attrs: Record<string, string> = {}): MockElement {
  return { id, attrs, children: [] };
}

function attachShadow(el: MockElement): MockShadowRoot {
  const sr: MockShadowRoot = {
    children: [],
    querySelector(sel: string) { return findInTree(this.children, sel); },
    querySelectorAll(_sel: string) { return collectAll(this.children); },
  };
  el.shadowRoot = sr;
  return sr;
}

/** Collect all descendant elements (flat). */
function collectAll(elements: MockElement[]): MockElement[] {
  const result: MockElement[] = [];
  for (const el of elements) {
    result.push(el);
    result.push(...collectAll(el.children));
  }
  return result;
}

/** Simple selector matcher: supports "#id" and "[attr='val']". */
function matchesSelector(el: MockElement, sel: string): boolean {
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  const attrMatch = sel.match(/^\[([^=]+)='([^']+)'\]$/);
  if (attrMatch) return el.attrs[attrMatch[1]] === attrMatch[2];
  // class selector ".foo"
  if (sel.startsWith('.')) return (el.attrs.class ?? '').split(' ').includes(sel.slice(1));
  return false;
}

function findInTree(elements: MockElement[], sel: string): MockElement | null {
  for (const el of elements) {
    if (matchesSelector(el, sel)) return el;
    const found = findInTree(el.children, sel);
    if (found) return found;
  }
  return null;
}

/**
 * Build a mock `document` object and evaluate DEEP_QS against it.
 * The mock document has querySelector/querySelectorAll that search the light DOM tree.
 */
function runDeepQS(lightDomRoot: MockElement[], sel: string): MockElement | null {
  const mockDocument = {
    querySelector(s: string) { return findInTree(lightDomRoot, s); },
    querySelectorAll(_s: string) { return collectAll(lightDomRoot); },
  };

  // Escape single quotes the same way the real cdp-client does (escapeSelector)
  const safeSel = sel.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // Wrap the function string and call it with our mock document
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', `return (${DEEP_QS})('${safeSel}')`);
  return fn(mockDocument) as MockElement | null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('DEEP_QS', () => {
  it('should be a syntactically valid JS function expression', () => {
    // Must not throw when parsed
    // eslint-disable-next-line no-new-func
    expect(() => new Function(`return (${DEEP_QS})`)).not.toThrow();
  });

  it('should find an element in the light DOM (fast path)', () => {
    const btn = createElement('submit-btn');
    const result = runDeepQS([btn], '#submit-btn');
    expect(result).toBe(btn);
  });

  it('should return null when element does not exist', () => {
    const btn = createElement('other');
    const result = runDeepQS([btn], '#nonexistent');
    expect(result).toBeNull();
  });

  it('should find an element inside a shadow root', () => {
    const host = createElement('host');
    const sr = attachShadow(host);
    const inner = createElement('shadow-btn');
    sr.children.push(inner);

    const result = runDeepQS([host], '#shadow-btn');
    expect(result).toBe(inner);
  });

  it('should find an element inside nested shadow roots', () => {
    // host > shadow > mid > shadow > deep
    const host = createElement('host');
    const sr1 = attachShadow(host);
    const mid = createElement('mid');
    sr1.children.push(mid);
    const sr2 = attachShadow(mid);
    const deep = createElement('deep-element');
    sr2.children.push(deep);

    const result = runDeepQS([host], '#deep-element');
    expect(result).toBe(deep);
  });

  it('should prefer light DOM over shadow DOM (fast path)', () => {
    const lightEl = createElement('target');
    const host = createElement('host');
    const sr = attachShadow(host);
    const shadowEl = createElement('target');
    sr.children.push(shadowEl);

    const result = runDeepQS([lightEl, host], '#target');
    // document.querySelector finds lightEl first — fast path
    expect(result).toBe(lightEl);
  });

  it('should find elements by data-testid attribute through shadow DOM', () => {
    const host = createElement('host');
    const sr = attachShadow(host);
    const inner = createElement('inner', { 'data-testid': 'add-connection-btn' });
    sr.children.push(inner);

    const result = runDeepQS([host], "[data-testid='add-connection-btn']");
    expect(result).toBe(inner);
  });

  it('should find elements by class through shadow DOM', () => {
    const host = createElement('host');
    const sr = attachShadow(host);
    const inner = createElement('inner', { class: 'my-button primary' });
    sr.children.push(inner);

    const result = runDeepQS([host], '.my-button');
    expect(result).toBe(inner);
  });

  it('should handle multiple shadow hosts at the same level', () => {
    const host1 = createElement('host1');
    const sr1 = attachShadow(host1);
    sr1.children.push(createElement('not-target'));

    const host2 = createElement('host2');
    const sr2 = attachShadow(host2);
    const target = createElement('target-deep');
    sr2.children.push(target);

    const result = runDeepQS([host1, host2], '#target-deep');
    expect(result).toBe(target);
  });

  it('should return null when no shadow roots contain the element', () => {
    const host = createElement('host');
    const sr = attachShadow(host);
    sr.children.push(createElement('other'));

    const result = runDeepQS([host], '#nonexistent');
    expect(result).toBeNull();
  });

  it('should handle elements with no shadow root gracefully', () => {
    const plain = createElement('plain');
    plain.children.push(createElement('child'));

    // No shadow root on plain — should just check light DOM
    const result = runDeepQS([plain], '#child');
    expect(result).toBe(plain.children[0]);
  });
});
