/**
 * JavaScript Tool - CDP Runtime.evaluate with fallback
 *
 * Execute JavaScript in the browser tab and return the result.
 * - Primary: CDP Runtime.evaluate (supports awaitPromise + returnByValue)
 * - Fallback: chrome.scripting.executeScript (when debugger is busy)
 *
 * Features:
 * - Async code support (top-level await via async wrapper)
 * - Output sanitization (sensitive data redaction)
 * - Output truncation (configurable max bytes)
 * - Timeout handling
 * - Detailed error classification
 */

import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import {
  assertTabInjectable,
  ExpectedPageRestrictionError,
  isRestrictedChromeUrl,
  restrictedUrlErrorMessage,
  logUnexpectedToolError,
} from '@/utils/restricted-url';
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  sanitizeAndLimitOutput,
  sanitizeText,
} from '@/utils/output-sanitizer';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT_MS = 15_000;
const CDP_SESSION_KEY = 'javascript';
// Upper bound on the elements one evaluation may stamp; fast snapshots cap at 250
// actions and a standard index tree beyond a few hundred is not a ref target.
const REF_BRIDGE_MAX = 500;
// Best-effort removal must not extend a call whose evaluation already finished.
const CLEANUP_TIMEOUT_MS = 1_000;

// Each evaluation gets its own stamp attribute and binds the helper to it; the
// binding is declared here so `MCP_INPAGE_HELPERS` stays self-contained.
export const MCP_INPAGE_HELPERS = `let __browserpawRefAttr = '';
const mcp = (() => {
  // Snapshot indexes live in the extension's isolated world, which page-world code
  // cannot read. While an evaluation runs, the background stamps the elements behind
  // the indexes the code mentions with an attribute private to that evaluation and
  // binds the helper to it, so a numeric ref resolves through the DOM instead of the
  // isolated caches. Overlapping evaluations cannot see each other's stamps.
  const fromRefAttr = (id) => {
    if (typeof __browserpawRefAttr !== 'string' || !__browserpawRefAttr) return undefined;
    let el = null;
    try {
      el = document.querySelector('[' + __browserpawRefAttr + '="' + id + '"]');
    } catch {
      return undefined;
    }
    if (el && el.isConnected !== false) return el;
    try {
      const searchShadow = (root) => {
        const walker = document.createTreeWalker(root, 1 /* NodeFilter.SHOW_ELEMENT */);
        let curr = walker.nextNode();
        while (curr) {
          if (curr.shadowRoot) {
            try {
              const found = curr.shadowRoot.querySelector('[' + __browserpawRefAttr + '="' + id + '"]');
              if (found && found.isConnected !== false) return found;
            } catch {}
            const deeper = searchShadow(curr.shadowRoot);
            if (deeper) return deeper;
          }
          curr = walker.nextNode();
        }
        return null;
      };
      const foundInShadow = searchShadow(document);
      if (foundInShadow) return foundInShadow;
    } catch {}
    return undefined;
  };

  const parseTargetIndex = (val) => {
    if (typeof val === 'number') return Number.isSafeInteger(val) && val > 0 ? val : null;
    if (typeof val === 'string') {
      const m = val.trim().match(/^(?:ref_|e)?(\\d+)$/i);
      if (m) {
        const n = parseInt(m[1], 10);
        return Number.isSafeInteger(n) && n > 0 ? n : null;
      }
    }
    return null;
  };

  // Robust :has-text evaluator supporting:
  // 1. Quotes with escaped characters: :has-text("Submit 'Now'")
  // 2. Regular expressions: :has-text(/失效|无货/)
  // 3. Comma-separated selectors: button:has-text("A"), button:has-text("B")
  // 4. Non-terminal pseudo-selectors: tr:has-text("Order #123") button
  // 5. Chained filters: div:has-text("A"):has-text("B")
  // 6. Innermost element matching for single element queries
  const splitTopLevelCommas = (selector) => {
    const parts = [];
    let current = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let parenDepth = 0;

    for (let i = 0; i < selector.length; i++) {
      const ch = selector[i];
      const prev = i > 0 ? selector[i - 1] : '';

      if (ch === "'" && !inDoubleQuote && prev !== '\\\\') {
        inSingleQuote = !inSingleQuote;
        current += ch;
      } else if (ch === '"' && !inSingleQuote && prev !== '\\\\') {
        inDoubleQuote = !inDoubleQuote;
        current += ch;
      } else if (ch === '(' && !inSingleQuote && !inDoubleQuote) {
        parenDepth++;
        current += ch;
      } else if (ch === ')' && !inSingleQuote && !inDoubleQuote) {
        if (parenDepth > 0) parenDepth--;
        current += ch;
      } else if (ch === ',' && !inSingleQuote && !inDoubleQuote && parenDepth === 0) {
        if (current.trim()) parts.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
  };

  const extractFirstHasText = (sel) => {
    const idx = sel.indexOf(':has-text(');
    if (idx === -1) return null;

    const prefix = sel.slice(0, idx).trim() || '*';
    const afterOpen = sel.slice(idx + ':has-text('.length);

    let inSingle = false;
    let inDouble = false;
    let closeIdx = -1;

    for (let i = 0; i < afterOpen.length; i++) {
      const ch = afterOpen[i];
      const prev = i > 0 ? afterOpen[i - 1] : '';
      if (ch === "'" && !inDouble && prev !== '\\\\') {
        inSingle = !inSingle;
      } else if (ch === '"' && !inSingle && prev !== '\\\\') {
        inDouble = !inDouble;
      } else if (ch === ')' && !inSingle && !inDouble) {
        closeIdx = i;
        break;
      }
    }

    if (closeIdx === -1) return null;

    const rawArg = afterOpen.slice(0, closeIdx).trim();
    const suffix = afterOpen.slice(closeIdx + 1);

    let pattern = rawArg;
    const regexMatch = /^\\/(.+)\\/([gimsuy]*)$/.exec(rawArg);
    if (regexMatch) {
      try {
        pattern = new RegExp(regexMatch[1], regexMatch[2]);
      } catch {
        pattern = rawArg;
      }
    } else if (
      (rawArg.startsWith('"') && rawArg.endsWith('"')) ||
      (rawArg.startsWith("'") && rawArg.endsWith("'"))
    ) {
      pattern = rawArg.slice(1, -1).replace(/\\\\(["'])/g, '$1');
    }

    return { prefix, pattern, suffix };
  };

  const elementMatchesPattern = (el, pattern) => {
    const text = el.innerText || el.textContent || '';
    if (pattern instanceof RegExp) {
      return pattern.test(text);
    }
    return text.includes(pattern);
  };

  const queryHasTextSingleSelector = (root, selector, single) => {
    const parsed = extractFirstHasText(selector);
    if (!parsed) {
      // extractFirstHasText found no closing paren, so this selector still
      // carries :has-text(. The native engine rejects it and the patched
      // prototypes would just recurse back here, so bail out instead.
      if (selector.includes(':has-text(')) return [];
      try {
        return single
          ? (root.querySelector(selector) ? [root.querySelector(selector)] : [])
          : Array.from(root.querySelectorAll(selector));
      } catch {
        return [];
      }
    }

    const { prefix, pattern, suffix } = parsed;
    let baseCandidates;
    try {
      baseCandidates = Array.from(root.querySelectorAll(prefix));
    } catch {
      baseCandidates = [];
    }

    const matchedPrefix = baseCandidates.filter((el) => elementMatchesPattern(el, pattern));

    const trimmedSuffix = suffix.trim();
    if (!trimmedSuffix) {
      if (single) {
        if (matchedPrefix.length === 0) return [];
        // Innermost match: element that does not contain another matched candidate
        const innermost = matchedPrefix.find(
          (el) => !matchedPrefix.some((other) => other !== el && el.contains(other)),
        );
        return [innermost || matchedPrefix[0]];
      }
      return matchedPrefix;
    }

    // Process suffix
    const results = [];
    const seen = new Set();

    for (const parent of matchedPrefix) {
      let childMatches;
      if (trimmedSuffix.startsWith(':has-text(')) {
        childMatches = queryHasTextSingleSelector(parent, '*' + trimmedSuffix, single);
      } else {
        const isCombinator = /^[>+~]/.test(trimmedSuffix);
        const childSel = isCombinator ? \`:scope \${trimmedSuffix}\` : trimmedSuffix;
        if (childSel.includes(':has-text(')) {
          childMatches = queryHasTextSingleSelector(parent, childSel, single);
        } else {
          try {
            childMatches = single
              ? (parent.querySelector(childSel) ? [parent.querySelector(childSel)] : [])
              : Array.from(parent.querySelectorAll(childSel));
          } catch {
            childMatches = [];
          }
        }
      }

      for (const m of childMatches) {
        if (!seen.has(m)) {
          seen.add(m);
          results.push(m);
          if (single) return results;
        }
      }
    }

    return results;
  };

  const queryWithHasText = (root, selector, single = false) => {
    if (typeof selector !== 'string') return single ? null : [];
    if (!selector.includes(':has-text(')) {
      try {
        return single ? root.querySelector(selector) : Array.from(root.querySelectorAll(selector));
      } catch {
        return single ? null : [];
      }
    }

    const parts = splitTopLevelCommas(selector);
    if (parts.length === 1) {
      const res = queryHasTextSingleSelector(root, parts[0], single);
      return single ? res[0] || null : res;
    }

    const combined = [];
    const seen = new Set();
    for (const part of parts) {
      const res = queryHasTextSingleSelector(root, part, single);
      for (const el of res) {
        if (!seen.has(el)) {
          seen.add(el);
          combined.push(el);
          if (single) return el;
        }
      }
    }
    return single ? combined[0] || null : combined;
  };

  // Every evaluation owns exactly one hold on the shared prototype patch so
  // overlapping evaluations never restore the prototypes out from under each
  // other; the last holder restores the captured originals.
  let hasTextPolyfillHeld = false;

  // Ownership token. The marker lives on the page's globalThis, where a page
  // may define a similarly shaped value of its own; only an object carrying
  // this registry symbol is BrowserPaw state that may be adopted or deleted.
  const POLYFILL_TOKEN = Symbol.for('browserpaw:has-text-polyfill:v1');
  const isOwnedPolyfill = (value) =>
    !!value &&
    typeof value === 'object' &&
    value[POLYFILL_TOKEN] === true &&
    typeof value.count === 'number' &&
    typeof value.docQS === 'function';

  const restoreHasTextPolyfill = () => {
    if (!hasTextPolyfillHeld) return;
    hasTextPolyfillHeld = false;
    const installed = globalThis.__mcpHasTextPolyfill;
    if (!isOwnedPolyfill(installed)) return;
    installed.count -= 1;
    if (installed.count > 0) return;
    Document.prototype.querySelector = installed.docQS;
    Document.prototype.querySelectorAll = installed.docQSA;
    Element.prototype.querySelector = installed.elQS;
    Element.prototype.querySelectorAll = installed.elQSA;
    delete globalThis.__mcpHasTextPolyfill;
  };

  const installHasTextPolyfill = () => {
    if (typeof Document === 'undefined' || hasTextPolyfillHeld) return;
    // Any marker that already exists belongs either to another evaluation
    // (ours, shared through its reference count) or to the page. A foreign
    // value is never overwritten or mutated, and no prototype patch is
    // installed over it.
    if ('__mcpHasTextPolyfill' in globalThis) {
      const installed = globalThis.__mcpHasTextPolyfill;
      if (isOwnedPolyfill(installed)) {
        installed.count += 1;
        hasTextPolyfillHeld = true;
      }
      return;
    }
    try {
      const origDocQS = Document.prototype.querySelector;
      const origDocQSA = Document.prototype.querySelectorAll;
      const origElQS = Element.prototype.querySelector;
      const origElQSA = Element.prototype.querySelectorAll;

      const wrap = (orig, single) =>
        function (sel) {
          if (typeof sel === 'string' && sel.includes(':has-text(')) {
            return queryWithHasText(this, sel, single);
          }
          return orig.call(this, sel);
        };

      // Publish the state before patching so a partial failure still restores
      // whatever was already replaced.
      globalThis.__mcpHasTextPolyfill = {
        [POLYFILL_TOKEN]: true,
        docQS: origDocQS,
        docQSA: origDocQSA,
        elQS: origElQS,
        elQSA: origElQSA,
        count: 1,
      };
      hasTextPolyfillHeld = true;

      Document.prototype.querySelector = wrap(origDocQS, true);
      Document.prototype.querySelectorAll = wrap(origDocQSA, false);
      Element.prototype.querySelector = wrap(origElQS, true);
      Element.prototype.querySelectorAll = wrap(origElQSA, false);
    } catch {
      restoreHasTextPolyfill();
    }
  };

  installHasTextPolyfill();

  const resolve = (t) => {
    const targetIdx = parseTargetIndex(t);
    if (targetIdx !== null) {
      return fromRefAttr(targetIdx) || null;
    }
    if (typeof t === 'number') {
      return null;
    }
    if (typeof t === 'string') {
      const trimmed = t.trim();
      if (/^(?:ref_|e)?\\d+$/i.test(trimmed)) {
        return null;
      }
      if (trimmed.startsWith('#')) {
        const byId = document.getElementById(trimmed.slice(1));
        if (byId) return byId;
      }
      if (t.includes(':has-text(')) {
        return queryWithHasText(document, t, true);
      }
      try {
        return document.querySelector(t);
      } catch {
        return null;
      }
    }
    return t instanceof Element ? t : null;
  };

  const isVisible = (t) => {
    const el = resolve(t);
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      parseFloat(style.opacity || '1') <= 0
    ) {
      return false;
    }
    const r = el.getBoundingClientRect();
    const hasSize =
      (r && r.width > 0 && r.height > 0) ||
      (typeof el.offsetWidth === 'number' && el.offsetWidth > 0 && el.offsetHeight > 0);
    return hasSize;
  };

  return {
    get: resolve,
    run: async (fn) => {
      if (typeof fn !== 'function') return fn;
      return await fn(mcp);
    },
    query: (selector, textPattern) => {
      if (textPattern !== undefined) {
        let els;
        if (typeof selector === 'string' && selector.includes(':has-text(')) {
          els = queryWithHasText(document, selector, false);
        } else {
          try {
            els = Array.from(document.querySelectorAll(selector));
          } catch {
            els = [];
          }
        }
        const matched = els.find((el) => {
          const txt = el.innerText || el.textContent || '';
          return textPattern instanceof RegExp
            ? textPattern.test(txt)
            : txt.includes(String(textPattern));
        });
        return matched || null;
      }
      return resolve(selector);
    },
    queryAll: (selector, textPattern) => {
      let els;
      if (typeof selector === 'string' && selector.includes(':has-text(')) {
        els = queryWithHasText(document, selector, false);
      } else {
        try {
          els = Array.from(document.querySelectorAll(selector));
        } catch {
          els = [];
        }
      }
      if (textPattern !== undefined) {
        return els.filter((el) => {
          const txt = el.innerText || el.textContent || '';
          return textPattern instanceof RegExp
            ? textPattern.test(txt)
            : txt.includes(String(textPattern));
        });
      }
      return els;
    },
    findByText: (textOrRegex, selector = '*') => {
      let els;
      if (typeof selector === 'string' && selector.includes(':has-text(')) {
        els = queryWithHasText(document, selector, false);
      } else {
        try {
          els = Array.from(document.querySelectorAll(selector));
        } catch {
          els = [];
        }
      }
      const matched = els.find((el) => {
        const txt = el.innerText || el.textContent || '';
        return textOrRegex instanceof RegExp
          ? textOrRegex.test(txt)
          : txt.includes(String(textOrRegex));
      });
      return matched || null;
    },
    findAllByText: (textOrRegex, selector = '*') => {
      let els;
      if (typeof selector === 'string' && selector.includes(':has-text(')) {
        els = queryWithHasText(document, selector, false);
      } else {
        try {
          els = Array.from(document.querySelectorAll(selector));
        } catch {
          els = [];
        }
      }
      return els.filter((el) => {
        const txt = el.innerText || el.textContent || '';
        return textOrRegex instanceof RegExp
          ? textOrRegex.test(txt)
          : txt.includes(String(textOrRegex));
      });
    },
    isVisible,
    click: async (t, options) => {
      if (options?.waitFor) {
        const timeout = typeof options.waitFor === 'number' ? options.waitFor : 5000;
        await mcp.waitFor(t, timeout);
      }
      const el = resolve(t);
      if (!el) throw new Error('Element not found: ' + t);
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const init = {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        button: 0,
      };
      el.dispatchEvent(new MouseEvent('mousemove', { ...init, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      if (typeof el.click === 'function') {
        el.click();
      } else {
        el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
      }
      if (options?.double) {
        el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1, detail: 2 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0, detail: 2 }));
        if (typeof el.click === 'function') {
          el.click();
        } else {
          el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0, detail: 2 }));
        }
        el.dispatchEvent(new MouseEvent('dblclick', { ...init, buttons: 0, detail: 2 }));
      }
      return true;
    },
    fill: async (t, text, clearFirst = true) => {
      const el = resolve(t);
      if (!el) throw new Error('Element not found: ' + t);
      if (typeof el.focus === 'function') el.focus();
      if ('value' in el) {
        const val = String(text ?? '');
        const isInput = typeof HTMLInputElement !== 'undefined' && el instanceof HTMLInputElement;
        const isTextArea = typeof HTMLTextAreaElement !== 'undefined' && el instanceof HTMLTextAreaElement;
        const proto = isInput
          ? (typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null)
          : isTextArea
            ? (typeof HTMLTextAreaElement !== 'undefined' ? HTMLTextAreaElement.prototype : null)
            : Object.getPrototypeOf(el);
        const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
        if (clearFirst) {
          if (nativeSetter) nativeSetter.call(el, '');
          else el.value = '';
        }
        if (nativeSetter) {
          nativeSetter.call(el, val);
        } else {
          el.value = val;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        if (clearFirst) el.innerText = '';
        el.innerText = String(text ?? '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    },
    check: async (t, checked = true) => {
      const el = resolve(t);
      if (!el) throw new Error('Element not found: ' + t);
      if ('checked' in el && el.checked !== checked) {
        const proto = typeof HTMLInputElement !== 'undefined' ? HTMLInputElement.prototype : null;
        const nativeSetter = proto ? Object.getOwnPropertyDescriptor(proto, 'checked')?.set : null;
        if (nativeSetter) {
          nativeSetter.call(el, checked);
        } else {
          el.checked = checked;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    },
    press: async (key, t) => {
      const el = t ? resolve(t) : document.activeElement || document.body;
      if (!el) throw new Error('Target not found for press');
      const eventInit = { key, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', eventInit));
      el.dispatchEvent(new KeyboardEvent('keypress', eventInit));
      el.dispatchEvent(new KeyboardEvent('keyup', eventInit));
      return true;
    },
    scrollIntoView: (t, align = 'center') => {
      const el = resolve(t);
      if (!el) return false;
      el.scrollIntoView({ block: align, inline: align, behavior: 'auto' });
      return true;
    },
    extract: (t, prop = 'text') => {
      const el = resolve(t);
      if (!el) return null;
      if (prop === 'text') return el.innerText || el.textContent || '';
      if (prop === 'value') return el.value ?? '';
      return el.getAttribute?.(prop) ?? el[prop] ?? null;
    },
    waitFor: async (t, msOrOpts = 5000, intervalMs = 100) => {
      let ms = 5000;
      let interval = 100;
      let requireVisible = false;
      if (typeof msOrOpts === 'number') {
        ms = msOrOpts;
        interval = typeof intervalMs === 'number' ? intervalMs : 100;
      } else if (msOrOpts && typeof msOrOpts === 'object') {
        ms = typeof msOrOpts.timeout === 'number' ? msOrOpts.timeout : 5000;
        interval = typeof msOrOpts.interval === 'number' ? msOrOpts.interval : 100;
        requireVisible = Boolean(msOrOpts.visible);
      }
      const start = Date.now();
      while (Date.now() - start < ms) {
        if (typeof t === 'function') {
          try {
            const res = await t();
            if (res) return res;
          } catch {}
        } else {
          const el = resolve(t);
          if (el && el.isConnected) {
            if (!requireVisible || isVisible(el)) return el;
          }
        }
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error(
        'Timeout (' +
          ms +
          'ms) waiting for: ' +
          (typeof t === 'function' ? 'predicate function' : t),
      );
    },
    waitForText: async (textOrRegex, selector = '*', msOrOpts = 5000, intervalMs = 100) => {
      let ms = 5000;
      let interval = 100;
      if (typeof msOrOpts === 'number') {
        ms = msOrOpts;
        interval = typeof intervalMs === 'number' ? intervalMs : 100;
      } else if (msOrOpts && typeof msOrOpts === 'object') {
        ms = typeof msOrOpts.timeout === 'number' ? msOrOpts.timeout : 5000;
        interval = typeof msOrOpts.interval === 'number' ? msOrOpts.interval : 100;
      }
      const start = Date.now();
      while (Date.now() - start < ms) {
        const el = mcp.findByText(textOrRegex, selector);
        if (el && el.isConnected) return el;
        await new Promise((r) => setTimeout(r, interval));
      }
      throw new Error('Timeout (' + ms + 'ms) waiting for text: ' + textOrRegex);
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch: (url, opts) => window.fetch(url, opts),
    installHasTextPolyfill,
    restoreHasTextPolyfill,
  };
})();
`;

// ============================================================================
// Types
// ============================================================================

type ExecutionEngine = 'cdp' | 'scripting';

type ErrorKind =
  | 'debugger_conflict'
  | 'timeout'
  | 'syntax_error'
  | 'runtime_error'
  | 'cdp_error'
  | 'scripting_error';

interface JavaScriptToolParams {
  code?: string;
  script?: string;
  tabId?: number;
  frameId?: number;
  contextId?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

interface ExecutionError {
  kind: ErrorKind;
  message: string;
  details?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

interface ExecutionMetrics {
  elapsedMs: number;
}

interface JavaScriptToolResult {
  success: boolean;
  tabId: number;
  engine: ExecutionEngine;
  status?: 'unknown';
  outcome?: 'unknown';
  retry?: false;
  result?: string;
  truncated?: boolean;
  redacted?: boolean;
  warnings?: string[];
  error?: ExecutionError;
  metrics?: ExecutionMetrics;
}

interface ExecutionOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

// Discriminated union for execution results
type ExecutionSuccess = {
  ok: true;
  engine: ExecutionEngine;
  output: string;
  truncated: boolean;
  redacted: boolean;
};

type ExecutionFailure = {
  ok: false;
  engine: ExecutionEngine;
  error: ExecutionError;
  status?: 'unknown';
  outcome?: 'unknown';
  retry?: false;
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

function markOutcomeUnknown(result: ExecutionFailure): ExecutionFailure {
  const message = result.error.message;
  return {
    ...result,
    status: 'unknown',
    outcome: 'unknown',
    retry: false,
    error: {
      ...result.error,
      message: /outcome unknown/i.test(message)
        ? message
        : `JavaScript outcome unknown; do not replay: ${message}`,
    },
  };
}

// ============================================================================
// Timeout Error
// ============================================================================

class TimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(timeoutMs));
    }, timeoutMs);

    promise
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(timer));
  });
}

function isTimeoutError(error: unknown): error is TimeoutError {
  return error instanceof Error && error.name === 'TimeoutError';
}

function isDebuggerConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Debugger is already attached|Another debugger is already attached|Cannot attach to this target/i.test(
    message,
  );
}

/**
 * Detect if user code is a single expression, correctly handling trailing semicolons,
 * single-line comments, and multi-line comments. Returns the expression string to return,
 * or null if code contains declarations or multi-statement blocks.
 */
export function detectSingleExpression(code: string): string | null {
  const rawTrimmed = code.trim();
  if (!rawTrimmed || rawTrimmed.startsWith('return ') || rawTrimmed === 'return') {
    return null;
  }

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  const isEvalBlocked = (err: any) =>
    err instanceof EvalError ||
    /eval|unsafe-eval|CSP|call to Function/i.test(String(err?.message || ''));
  const isStatement = (s: string) =>
    /^(?:const|let|var|function|class|if|for|while|do|switch|try|throw|return|break|continue|debugger|import|export)\b/.test(
      s,
    );

  // 1. Direct check after stripping trailing semicolons
  const direct = rawTrimmed.replace(/;+$/, '').trim();
  try {
    new AsyncFunction('return (\n' + direct + '\n);');
    return direct;
  } catch (err: any) {
    if (isEvalBlocked(err) && !isStatement(direct) && !direct.includes(';')) {
      return direct;
    }
  }

  // 2. Clean comments and semicolons
  const cleaned = direct
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
    .replace(/;+$/, '')
    .trim();

  if (cleaned && cleaned !== direct) {
    try {
      new AsyncFunction('return (\n' + cleaned + '\n);');
      return cleaned;
    } catch (err: any) {
      if (isEvalBlocked(err) && !isStatement(cleaned) && !cleaned.includes(';')) {
        return cleaned;
      }
    }
  }

  return null;
}

/**
 * Wrap user code in an async IIFE to support top-level await and return statements.
 * Automatically adds a return statement if user code is a single expression.
 */
export function wrapUserCode(code: string, refAttr = ''): string {
  if (!code.trim()) {
    // No helpers are injected for empty code, so there is nothing to scope.
    return `(async () => {\n${code}\n})()`;
  }
  const expr = detectSingleExpression(code);
  if (expr !== null) {
    return wrapInScopedEvaluation(`return (\n${expr}\n);\n`, refAttr);
  }
  const trimmed = code.trim();
  const declMatch = /^\s*(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=([\s\S]+)$/.exec(
    trimmed,
  );
  if (declMatch) {
    const varName = declMatch[1];
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    try {
      new AsyncFunction(`${trimmed}\nreturn ${varName};`);
      return wrapInScopedEvaluation(`${trimmed}\nreturn ${varName};\n`, refAttr);
    } catch {}
  }
  return wrapInScopedEvaluation(`${code}\n`, refAttr);
}

/**
 * Wrap the injected helpers + user code in try/finally so the MAIN-world
 * prototype patches installed by the helpers are always removed again when
 * the evaluation ends, including when user code throws. The helpers run in
 * the same function scope as the user code, so `mcp` stays a local binding:
 * page-owned globals such as `__mcp` are neither read nor written.
 *
 * `refAttr` is this evaluation's snapshot stamp; the helper resolves numeric
 * refs only through it, so overlapping evaluations cannot cross-resolve.
 */
function wrapInScopedEvaluation(body: string, refAttr = ''): string {
  return `(async () => {\n${MCP_INPAGE_HELPERS}__browserpawRefAttr = ${JSON.stringify(refAttr)};\ntry {\n${body}\n} finally {\ntry {\nmcp.restoreHasTextPolyfill();\n} catch {}\n}\n})()`;
}

// ============================================================================
// CDP Execution
// ============================================================================

interface CDPRemoteObject {
  type?: string;
  subtype?: string;
  value?: unknown;
  unserializableValue?: string;
  description?: string;
}

interface CDPExceptionDetails {
  text?: string;
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  exception?: {
    className?: string;
    description?: string;
    value?: string;
  };
}

interface CDPEvaluateResult {
  result?: CDPRemoteObject;
  exceptionDetails?: CDPExceptionDetails;
}

function extractReturnValue(remoteObject?: CDPRemoteObject): unknown {
  if (!remoteObject) return undefined;

  if ('value' in remoteObject) return remoteObject.value;
  if ('unserializableValue' in remoteObject) return remoteObject.unserializableValue;
  if (typeof remoteObject.description === 'string') return remoteObject.description;

  return undefined;
}

function parseExceptionDetails(details: CDPExceptionDetails): ExecutionError {
  const exceptionClassName = details.exception?.className ?? '';
  const exceptionDescription = details.exception?.description ?? '';
  const exceptionValue = details.exception?.value ?? '';
  const text = details.text ?? '';

  // Determine the raw error message
  const rawMessage =
    exceptionDescription || exceptionValue || text || 'JavaScript execution failed';

  // Sanitize the message
  const message = sanitizeText(rawMessage).text;

  // Classify the error kind
  const isSyntaxError = exceptionClassName === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

  return {
    kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
    message,
    details: {
      url: details.url,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
    },
  };
}

async function executeInFrameMainWorld(
  tabId: number,
  frameId: number,
  expression: string,
  deadline: number,
  execution: { dispatched: boolean },
): Promise<CDPEvaluateResult> {
  const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!frame?.documentId) throw new Error(`Frame ${frameId} has no active document`);
  if (isRestrictedChromeUrl(frame.url)) {
    throw new ExpectedPageRestrictionError(restrictedUrlErrorMessage(frame.url));
  }
  const target = { tabId, documentIds: [frame.documentId] };
  const marker = 'data-bp-evaluate-' + crypto.randomUUID();
  const cleanup = () =>
    withTimeout(
      chrome.scripting.executeScript({
        target,
        func: (attr: string) => document.documentElement.removeAttribute(attr),
        args: [marker],
      }),
      CLEANUP_TIMEOUT_MS,
    ).catch(() => {});
  let finished = false;
  let remote: { sessionId?: string; objectId: string } | undefined;
  try {
    const stamp = chrome.scripting.executeScript({
      target,
      func: (attr: string) => document.documentElement.setAttribute(attr, '1'),
      args: [marker],
    });
    void stamp
      .then(() => {
        if (finished) void cleanup();
      })
      .catch(() => {});
    await withTimeout(stamp, Math.max(1, deadline - performance.now()));
    const children = await cdpSessionManager.ensureFrameSessions(tabId);
    for (const sid of [undefined, ...children.map((child) => child.sessionId)]) {
      await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.getDocument', {
        depth: 0,
        pierce: true,
      });
      const search = await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.performSearch', {
        query: `[${marker}="1"]`,
      });
      try {
        if (!search.resultCount) continue;
        if (search.resultCount !== 1 || remote)
          throw new Error('Ambiguous frame document identity');
        const found = await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.getSearchResults', {
          searchId: search.searchId,
          fromIndex: 0,
          toIndex: 1,
        });
        const resolved = await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.resolveNode', {
          nodeId: found.nodeIds?.[0],
        });
        if (!resolved.object?.objectId) throw new Error('Frame document is no longer attached');
        remote = { sessionId: sid, objectId: resolved.object.objectId };
      } finally {
        await cdpSessionManager.sendFrameCommand(tabId, sid, 'DOM.discardSearchResults', {
          searchId: search.searchId,
        });
      }
    }
    if (!remote) throw new Error(`Frame ${frameId} is not in this tab's confirmed sessions`);
    const active = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (active?.documentId !== frame.documentId)
      throw new Error('Frame navigated before JavaScript execution');
    if (performance.now() >= deadline) throw new TimeoutError(0);
    // ResolveNode's default realm belongs to this document, preserving page globals in MAIN.
    execution.dispatched = true;
    const response = await cdpSessionManager.sendFrameCommand<CDPEvaluateResult>(
      tabId,
      remote.sessionId,
      'Runtime.callFunctionOn',
      {
        objectId: remote.objectId,
        functionDeclaration: `function(){ return ${expression}; }`,
        returnByValue: true,
        awaitPromise: true,
      },
      Math.max(1, deadline - performance.now()),
    );
    if (!response?.result && !response?.exceptionDetails)
      throw new Error('Frame JavaScript outcome unknown: missing result; do not replay code');
    return response;
  } finally {
    finished = true;
    if (remote)
      await cdpSessionManager
        .sendFrameCommand(
          tabId,
          remote.sessionId,
          'Runtime.releaseObject',
          { objectId: remote.objectId },
          CLEANUP_TIMEOUT_MS,
        )
        .catch(() => {});
    await cleanup();
  }
}

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
  contextId?: number,
  refAttr = '',
  frameId?: number,
): Promise<ExecutionResult> {
  const execution = { dispatched: false };
  const deadline = performance.now() + options.timeoutMs;
  try {
    // Restricted pages (chrome://, web store, cloud metadata) are just as
    // reachable through Runtime.evaluate as through the scripting fallback,
    // so the guard has to run on the primary path too.
    await assertTabInjectable(tabId);

    const expression = wrapUserCode(code, refAttr);

    const response = await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        if (frameId !== undefined)
          return executeInFrameMainWorld(tabId, frameId, expression, deadline, execution);
        const evalParams: Record<string, any> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
          includeCommandLineAPI: true,
          // CDP internal timeout (ms), dual protection with outer withTimeout
          timeout: options.timeoutMs,
        };
        if (typeof contextId === 'number') {
          evalParams.contextId = contextId;
        }
        execution.dispatched = true;
        return (await cdpSessionManager.sendCommand(
          tabId,
          'Runtime.evaluate',
          evalParams,
        )) as CDPEvaluateResult;
      }),
      // Outer timeout slightly longer to give CDP margin for timeout response
      options.timeoutMs + 1000,
    );

    if (!response?.result && !response?.exceptionDetails) {
      throw new Error('JavaScript outcome unknown: missing result; do not replay code');
    }

    // Check for exception
    if (response?.exceptionDetails) {
      return {
        ok: false,
        engine: 'cdp',
        error: parseExceptionDetails(response.exceptionDetails),
      };
    }

    // Extract and sanitize the result
    const value = extractReturnValue(response?.result);
    const sanitized = sanitizeAndLimitOutput(value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'cdp',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  } catch (error) {
    if (isTimeoutError(error)) {
      const failure: ExecutionFailure = {
        ok: false,
        engine: 'cdp',
        error: {
          kind: 'timeout',
          message: error.message,
        },
      };
      return execution.dispatched ? markOutcomeUnknown(failure) : failure;
    }

    if (!execution.dispatched && isDebuggerConflictError(error)) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'debugger_conflict', message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    const failure: ExecutionFailure = {
      ok: false,
      engine: 'cdp',
      error: { kind: 'cdp_error', message },
    };
    return execution.dispatched ? markOutcomeUnknown(failure) : failure;
  }
}

// ============================================================================
// chrome.scripting.executeScript Fallback
// ============================================================================

interface ScriptingExecutionResult {
  ok: boolean;
  value?: unknown;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
  };
}

async function executeViaScripting(
  tabId: number,
  code: string,
  options: ExecutionOptions,
  refAttr = '',
  frameId?: number,
): Promise<ExecutionResult> {
  const execution = { dispatched: false };
  const innerExecute = async (): Promise<ExecutionResult> => {
    await assertTabInjectable(tabId);
    execution.dispatched = true;
    const target: chrome.scripting.InjectionTarget =
      typeof frameId === 'number' && frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId };
    const results = await chrome.scripting.executeScript({
      target,
      world: 'MAIN',
      func: async (
        userCode: string,
        inpageHelpers?: string,
        refAttrName?: string,
      ): Promise<ScriptingExecutionResult> => {
        try {
          // Use AsyncFunction constructor to support top-level await
          const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
          let codeToRun = userCode;
          const rawTrimmed = userCode.trim();
          if (rawTrimmed && !rawTrimmed.startsWith('return ') && rawTrimmed !== 'return') {
            const direct = rawTrimmed.replace(/;+$/, '').trim();
            let validExpr: string | null = null;
            try {
              new AsyncFunction(`return (\n${direct}\n);`);
              validExpr = direct;
            } catch {}
            if (!validExpr) {
              let cleaned = direct;
              let changed = true;
              while (changed) {
                const prev = cleaned;
                cleaned = cleaned
                  .replace(/\/\/[^\r\n]*$/, '')
                  .replace(/\/\*[\s\S]*?\*\/\s*$/, '')
                  .trim()
                  .replace(/;+$/, '')
                  .trim();
                changed = cleaned !== prev;
              }
              if (cleaned && cleaned !== direct) {
                try {
                  new AsyncFunction(`return (\n${cleaned}\n);`);
                  validExpr = cleaned;
                } catch {}
              }
            }
            if (validExpr !== null) {
              codeToRun = `return (\n${validExpr}\n);`;
            } else {
              const declMatch =
                /^\s*(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*([\s\S]+?);?\s*$/.exec(
                  rawTrimmed,
                );
              if (declMatch && !declMatch[2].includes(';\n') && !declMatch[2].includes(';\r\n')) {
                codeToRun = `${userCode}\nreturn ${declMatch[1]};`;
              }
            }
          }
          // Helpers share the generated function scope with the user code, so
          // `mcp` is a local binding and the teardown never touches page globals.
          // The ref binding is assigned here rather than passed through user code.
          const fn = new AsyncFunction(
            `${inpageHelpers || ''}\n__browserpawRefAttr = ${JSON.stringify(refAttrName || '')};\ntry {\n${codeToRun}\n} finally {\ntry {\nmcp.restoreHasTextPolyfill();\n} catch {}\n}`,
          );
          const value = await fn();
          return { ok: true, value };
        } catch (err: unknown) {
          const error = err as Error;
          return {
            ok: false,
            error: {
              name: error?.name ?? undefined,
              message: error?.message ?? String(err),
              stack: error?.stack ?? undefined,
            },
          };
        }
      },
      args: [code, MCP_INPAGE_HELPERS, refAttr],
    });

    // Extract the first result
    const firstFrame = results?.[0];
    const result = (firstFrame as { result?: ScriptingExecutionResult })?.result;

    if (!result || typeof result !== 'object') {
      return markOutcomeUnknown({
        ok: false,
        engine: 'scripting',
        error: { kind: 'scripting_error', message: 'No result returned from executeScript' },
      });
    }

    if (!result.ok) {
      const rawMessage = result.error?.message ?? 'JavaScript execution failed';
      const rawStack = result.error?.stack;

      const message = sanitizeText(rawMessage).text;
      const sanitizedStack = rawStack ? sanitizeText(rawStack).text : undefined;

      const isSyntaxError = result.error?.name === 'SyntaxError' || /SyntaxError/i.test(rawMessage);

      return {
        ok: false,
        engine: 'scripting',
        error: {
          kind: isSyntaxError ? 'syntax_error' : 'runtime_error',
          message: sanitizedStack ? `${message}\n${sanitizedStack}` : message,
        },
      };
    }

    // Sanitize the successful result
    const sanitized = sanitizeAndLimitOutput(result.value, { maxBytes: options.maxOutputBytes });

    return {
      ok: true,
      engine: 'scripting',
      output: sanitized.text,
      truncated: sanitized.truncated,
      redacted: sanitized.redacted,
    };
  };

  try {
    return await withTimeout(innerExecute(), options.timeoutMs);
  } catch (error) {
    if (isTimeoutError(error)) {
      const failure: ExecutionFailure = {
        ok: false,
        engine: 'scripting',
        error: { kind: 'timeout', message: error.message },
      };
      return execution.dispatched ? markOutcomeUnknown(failure) : failure;
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    const failure: ExecutionFailure = {
      ok: false,
      engine: 'scripting',
      error: { kind: 'scripting_error', message },
    };
    return execution.dispatched ? markOutcomeUnknown(failure) : failure;
  }
}

// ============================================================================
// Snapshot Index Bridge
// ============================================================================

/**
 * Snapshot indexes live only in the extension's isolated world, but the helper
 * runs in the page's MAIN world (CDP Runtime.evaluate and the scripting fallback
 * both target it), which cannot read them. Before evaluating, stamp the elements
 * behind the numeric literals in the code with a per-evaluation random attribute;
 * the evaluation is bound to that attribute, so the helper resolves refs only
 * through its own stamps.
 *
 * `deadline` is the absolute end of the whole call: the stamping pass may only
 * consume what is left of it, so bridge setup and evaluation share one budget.
 * Returns the attribute the evaluation should bind to (empty when no element was
 * stamped) and the cleanup that removes the stamps, or a no-op.
 *
 * Only literals are bridged: a ref computed at runtime from a prior tool result
 * never appears in the code, and no DOM bridge can predict it.
 *
 * Both injections are bounded: a renderer blocked by a native dialog never acks,
 * and an unbounded await would hang the call before its own timeout applies.
 */
async function bridgeSnapshotIndexes(
  tabId: number,
  code: string,
  deadline: number,
  frameId?: number,
): Promise<{ refAttr: string; cleanup: () => Promise<void> }> {
  const noBridge = async () => {};
  if (!/\bmcp\b/.test(code)) return { refAttr: '', cleanup: noBridge };
  const indexes = [...new Set((code.match(/\d+/g) ?? []).map((raw) => Number.parseInt(raw, 10)))]
    .filter((n) => Number.isSafeInteger(n) && n > 0)
    .slice(0, REF_BRIDGE_MAX);
  if (indexes.length === 0) return { refAttr: '', cleanup: noBridge };

  const target: chrome.scripting.InjectionTarget =
    typeof frameId === 'number' && frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId };

  const attr = 'data-browserpaw-ref-' + Math.random().toString(36).slice(2, 10);
  const cleanup = async () => {
    // Cleanup runs in a finally path: a closed or restricted tab must not turn the
    // tool's real result into a cleanup error.
    try {
      await withTimeout(
        chrome.scripting.executeScript({
          target,
          func: (a: string) => {
            // The stamping pass keeps the exact elements it marked (some may sit in
            // closed shadow roots a query could never reach); remove those. A page
            // reload or extension reload between the passes loses that list, so fall
            // back to the light DOM.
            const g = globalThis as any;
            const stamps: Map<string, Element[]> | undefined = g.__browserpawRefStamps;
            const marked = stamps?.get(a);
            if (marked && stamps) {
              for (const el of marked) el.removeAttribute(a);
              stamps.delete(a);
            } else {
              for (const el of document.querySelectorAll('[' + a + ']')) el.removeAttribute(a);
              try {
                const walker = document.createTreeWalker(document, 1 /* NodeFilter.SHOW_ELEMENT */);
                let curr = walker.nextNode();
                while (curr) {
                  const shadowRoot = (curr as Element).shadowRoot;
                  if (shadowRoot) {
                    for (const el of shadowRoot.querySelectorAll('[' + a + ']')) {
                      el.removeAttribute(a);
                    }
                  }
                  curr = walker.nextNode();
                }
              } catch {}
            }
          },
          args: [attr],
        }),
        CLEANUP_TIMEOUT_MS,
      );
    } catch {}
  };

  try {
    await withTimeout(
      chrome.scripting.executeScript({
        target,
        func: (a: string, ids: number[]) => {
          // Isolated world: the snapshot maps are reachable here, not from the page.
          const g = globalThis as any;
          const isoMap = g[Symbol.for('__browser_use_isolated_index_map__')];
          const deref = (e: any) => (e && typeof e.deref === 'function' ? e.deref() : e);
          const marked: Element[] = [];
          for (const id of ids) {
            const raw = isoMap?.get(id);
            const el = deref(raw);
            if (el instanceof Element && el.isConnected && el.ownerDocument === document) {
              el.setAttribute(a, String(id));
              marked.push(el);
            }
          }
          if (marked.length > 0) {
            // Keep the exact elements for cleanup: shadow roots (closed ones
            // especially) are not reachable from the page-level query.
            g.__browserpawRefStamps = g.__browserpawRefStamps || new Map();
            g.__browserpawRefStamps.set(a, marked);
          }
          return marked.length;
        },
        args: [attr, indexes],
      }),
      Math.max(1, deadline - performance.now()),
    );
  } catch {
    // Blocked renderer, restricted or closing tab: no bridge, and the evaluation
    // path reports its own timeout or error.
    await cleanup();
    return { refAttr: '', cleanup: noBridge };
  }
  return { refAttr: attr, cleanup };
}

// ============================================================================
// Tool Implementation
// ============================================================================

class JavaScriptTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.JAVASCRIPT;

  async execute(args: JavaScriptToolParams): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      // Validate required parameter (supports code or script alias)
      const rawCode = args?.code ?? args?.script;
      const code = typeof rawCode === 'string' ? rawCode.trim() : '';
      if (!code) {
        return createErrorResponse('Parameter [code] is required');
      }

      if (args.frameId !== undefined && (!Number.isSafeInteger(args.frameId) || args.frameId < 0)) {
        return createErrorResponse('frameId must be a non-negative safe integer');
      }
      if (args.frameId !== undefined && args.contextId !== undefined) {
        return createErrorResponse('Specify frameId or contextId, not both');
      }

      // Resolve target tab
      const tab = await this.resolveTargetTab(args.tabId);
      if (!tab) {
        return createErrorResponse(
          typeof args.tabId === 'number' ? `Tab not found: ${args.tabId}` : 'No active tab found',
        );
      }

      if (!tab.id) {
        return createErrorResponse('Tab has no ID');
      }
      const tabId = tab.id;

      // Normalize options
      const options: ExecutionOptions = {
        timeoutMs: normalizePositiveInt(args.timeoutMs, DEFAULT_TIMEOUT_MS),
        maxOutputBytes: normalizePositiveInt(args.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      };
      // One deadline for the whole call: bridge setup and evaluation share it, so
      // `timeoutMs` bounds the call even when the renderer blocks one of the steps.
      const deadline = performance.now() + options.timeoutMs;

      const targetFrameId =
        typeof args.frameId === 'number' && args.frameId > 0 ? args.frameId : undefined;

      const warnings: string[] = [];

      // The helper runs in the page world, so snapshot refs need a DOM bridge for
      // the duration of the evaluation; it is removed on every exit path.
      const { refAttr, cleanup: clearRefBridge } = await bridgeSnapshotIndexes(
        tabId,
        code,
        deadline,
        targetFrameId,
      );
      const remainingOptions = (): ExecutionOptions => ({
        ...options,
        timeoutMs: Math.max(1, Math.round(deadline - performance.now())),
      });
      try {
        // Try CDP execution first
        const cdpResult = await executeViaCdp(
          tabId,
          code,
          remainingOptions(),
          args.contextId,
          refAttr,
          targetFrameId,
        );

        if (cdpResult.ok) {
          return this.buildSuccessResponse(tabId, cdpResult, startTime);
        }

        // If not a debugger conflict, return the CDP error
        if (cdpResult.error.kind !== 'debugger_conflict') {
          return this.buildErrorResponse(tabId, cdpResult, startTime);
        }

        // Debugger conflict - fallback to scripting API
        warnings.push(
          'Debugger is busy (DevTools or another extension attached). Falling back to chrome.scripting.executeScript (runs in MAIN world).',
        );

        const scriptingResult = await executeViaScripting(
          tabId,
          code,
          remainingOptions(),
          refAttr,
          targetFrameId,
        );

        if (scriptingResult.ok) {
          return this.buildSuccessResponse(tabId, scriptingResult, startTime, warnings);
        }

        return this.buildErrorResponse(tabId, scriptingResult, startTime, warnings);
      } finally {
        await clearRefBridge();
      }
    } catch (error) {
      logUnexpectedToolError('JavaScriptTool.execute error:', error);
      return createErrorResponse(
        `JavaScript tool error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab | null> {
    if (typeof tabId === 'number') {
      return this.tryGetTab(tabId);
    }
    try {
      return await this.getActiveTabOrThrow();
    } catch {
      return null;
    }
  }

  private buildSuccessResponse(
    tabId: number,
    result: ExecutionSuccess,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: true,
      tabId,
      engine: result.engine,
      result: result.output,
      truncated: result.truncated || undefined,
      redacted: result.redacted || undefined,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: false,
    };
  }

  private buildErrorResponse(
    tabId: number,
    result: ExecutionFailure,
    startTime: number,
    warnings?: string[],
  ): ToolResult {
    const payload: JavaScriptToolResult = {
      success: false,
      tabId,
      engine: result.engine,
      status: result.status,
      outcome: result.outcome,
      retry: result.retry,
      error: result.error,
      warnings: warnings?.length ? warnings : undefined,
      metrics: { elapsedMs: Math.round(performance.now() - startTime) },
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      isError: true,
    };
  }
}

export const javascriptTool = new JavaScriptTool();
