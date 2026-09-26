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
import { assertTabInjectable } from '@/utils/restricted-url';
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

export const MCP_INPAGE_HELPERS = `const mcp = (() => {
  const getMap = () => (
    (typeof globalThis !== 'undefined' && (
      globalThis[Symbol.for('__browser_use_isolated_index_map__')] ||
      globalThis[Symbol.for('BROWSERPAW_ISOLATED_INDEX_MAP')] ||
      globalThis[Symbol.for('BROWSERCLAW_ISOLATED_INDEX_MAP')] ||
      globalThis.__MCP_INDEX_MAP__
    )) || new Map()
  );
  const deref = (e) => (e && typeof e.deref === 'function' ? e.deref() : e);

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

  // Polyfill :has-text support on Document & Element prototypes so document.querySelector('...:has-text(...)') works natively
  if (typeof Document !== 'undefined' && !Document.prototype.__mcpHasTextPatched) {
    try {
      const origDocQS = Document.prototype.querySelector;
      const origDocQSA = Document.prototype.querySelectorAll;
      const origElQS = Element.prototype.querySelector;
      const origElQSA = Element.prototype.querySelectorAll;

      Document.prototype.querySelector = function (sel) {
        if (typeof sel === 'string' && sel.includes(':has-text(')) {
          return queryWithHasText(this, sel, true);
        }
        return origDocQS.call(this, sel);
      };
      Document.prototype.querySelectorAll = function (sel) {
        if (typeof sel === 'string' && sel.includes(':has-text(')) {
          return queryWithHasText(this, sel, false);
        }
        return origDocQSA.call(this, sel);
      };
      Element.prototype.querySelector = function (sel) {
        if (typeof sel === 'string' && sel.includes(':has-text(')) {
          return queryWithHasText(this, sel, true);
        }
        return origElQS.call(this, sel);
      };
      Element.prototype.querySelectorAll = function (sel) {
        if (typeof sel === 'string' && sel.includes(':has-text(')) {
          return queryWithHasText(this, sel, false);
        }
        return origElQSA.call(this, sel);
      };
      Document.prototype.__mcpHasTextPatched = true;
    } catch {}
  }

  const resolve = (t) => {
    if (typeof t === 'number') {
      const fromMap = deref(getMap().get(t));
      if (fromMap && fromMap.isConnected !== false) return fromMap;
      const fpMap =
        typeof globalThis !== 'undefined' &&
        globalThis[Symbol.for('__browser_use_index_fingerprint_map__')];
      if (fpMap && fpMap.has(t)) {
        const fp = fpMap.get(t);
        if (fp?.id) {
          const byId = document.getElementById(fp.id);
          if (byId) return byId;
        }
        if (fp?.testId) {
          const byTest = document.querySelector('[data-testid="' + fp.testId + '"]');
          if (byTest) return byTest;
        }
        if (fp?.ariaLabel) {
          const byAria = document.querySelector(
            (fp.tag || '') + '[aria-label="' + fp.ariaLabel + '"]',
          );
          if (byAria) return byAria;
        }
        if (fp?.name) {
          const byName = document.querySelector((fp.tag || '') + '[name="' + fp.name + '"]');
          if (byName) return byName;
        }
        if (fp?.placeholder) {
          const byPl = document.querySelector(
            (fp.tag || '') + '[placeholder="' + fp.placeholder + '"]',
          );
          if (byPl) return byPl;
        }
      }
      return document.querySelector(\`[data-mcp-idx="\${t}"]\`);
    }
    if (typeof t === 'string') {
      const trimmed = t.trim();
      // Only treat as numeric index / ref if it is purely digits or ref_digits
      if (/^(?:ref_)?\\d+$/.test(trimmed)) {
        const p = parseInt(trimmed.replace(/^ref_/, ''), 10);
        if (!isNaN(p)) {
          const fromMap = deref(getMap().get(p));
          if (fromMap && fromMap.isConnected !== false) return fromMap;
          const fpMap =
            typeof globalThis !== 'undefined' &&
            globalThis[Symbol.for('__browser_use_index_fingerprint_map__')];
          if (fpMap && fpMap.has(p)) {
            const fp = fpMap.get(p);
            if (fp?.id) {
              const byId = document.getElementById(fp.id);
              if (byId) return byId;
            }
            if (fp?.testId) {
              const byTest = document.querySelector('[data-testid="' + fp.testId + '"]');
              if (byTest) return byTest;
            }
            if (fp?.ariaLabel) {
              const byAria = document.querySelector(
                (fp.tag || '') + '[aria-label="' + fp.ariaLabel + '"]',
              );
              if (byAria) return byAria;
            }
            if (fp?.name) {
              const byName = document.querySelector((fp.tag || '') + '[name="' + fp.name + '"]');
              if (byName) return byName;
            }
            if (fp?.placeholder) {
              const byPl = document.querySelector(
                (fp.tag || '') + '[placeholder="' + fp.placeholder + '"]',
              );
              if (byPl) return byPl;
            }
          }
          const fromAttr = document.querySelector(\`[data-mcp-idx="\${p}"]\`);
          if (fromAttr) return fromAttr;
        }
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
};

type ExecutionResult = ExecutionSuccess | ExecutionFailure;

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
export function wrapUserCode(code: string): string {
  if (!code.trim()) {
    return `(async () => {\n${code}\n})()`;
  }
  const expr = detectSingleExpression(code);
  if (expr !== null) {
    return `(async () => {\n${MCP_INPAGE_HELPERS}return (\n${expr}\n);\n})()`;
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
      return `(async () => {\n${MCP_INPAGE_HELPERS}${trimmed}\nreturn ${varName};\n})()`;
    } catch {}
  }
  return `(async () => {\n${MCP_INPAGE_HELPERS}${code}\n})()`;
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

async function executeViaCdp(
  tabId: number,
  code: string,
  options: ExecutionOptions,
  contextId?: number,
): Promise<ExecutionResult> {
  try {
    const expression = wrapUserCode(code);

    const response = await withTimeout(
      cdpSessionManager.withSession(tabId, CDP_SESSION_KEY, async () => {
        const evalParams: Record<string, any> = {
          expression,
          returnByValue: true,
          awaitPromise: true,
          includeCommandLineAPI: true,
          // CDP 内置超时（毫秒），与外层 withTimeout 双重保障
          timeout: options.timeoutMs,
        };
        if (typeof contextId === 'number') {
          evalParams.contextId = contextId;
        }
        return (await cdpSessionManager.sendCommand(
          tabId,
          'Runtime.evaluate',
          evalParams,
        )) as CDPEvaluateResult;
      }),
      // 外层超时稍长，给 CDP 一点余量处理超时响应
      options.timeoutMs + 1000,
    );

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
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'timeout', message: error.message },
      };
    }

    if (isDebuggerConflictError(error)) {
      const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
      return {
        ok: false,
        engine: 'cdp',
        error: { kind: 'debugger_conflict', message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'cdp',
      error: { kind: 'cdp_error', message },
    };
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
): Promise<ExecutionResult> {
  const innerExecute = async (): Promise<ExecutionResult> => {
    await assertTabInjectable(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (userCode: string, inpageHelpers?: string): Promise<ScriptingExecutionResult> => {
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
          const fn = new AsyncFunction((inpageHelpers || '') + codeToRun);
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
      args: [code, MCP_INPAGE_HELPERS],
    });

    // Extract the first result
    const firstFrame = results?.[0];
    const result = (firstFrame as { result?: ScriptingExecutionResult })?.result;

    if (!result || typeof result !== 'object') {
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'scripting_error', message: 'No result returned from executeScript' },
      };
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
      return {
        ok: false,
        engine: 'scripting',
        error: { kind: 'timeout', message: error.message },
      };
    }

    const message = sanitizeText(error instanceof Error ? error.message : String(error)).text;
    return {
      ok: false,
      engine: 'scripting',
      error: { kind: 'scripting_error', message },
    };
  }
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

      const warnings: string[] = [];

      // Try CDP execution first
      const cdpResult = await executeViaCdp(tabId, code, options, args.contextId);

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

      const scriptingResult = await executeViaScripting(tabId, code, options);

      if (scriptingResult.ok) {
        return this.buildSuccessResponse(tabId, scriptingResult, startTime, warnings);
      }

      return this.buildErrorResponse(tabId, scriptingResult, startTime, warnings);
    } catch (error) {
      console.error('JavaScriptTool.execute error:', error);
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
