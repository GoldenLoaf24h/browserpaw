import { getShadowRoot } from './composed-dom';

/**
 * Splits a string by a delimiter character unless enclosed in single or double quotes.
 */
export function splitByCharacterUnlessQuoted(selector: string, character: string): string[] {
  const matches = selector.match(/\\?.|^$/gs);
  if (!matches) return [selector];
  return matches.reduce(
    (p: { quote: number; sQuote: number; a: string[] }, c: string) => {
      if (c === '"' && !p.sQuote) {
        p.quote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (c === "'" && !p.quote) {
        p.sQuote ^= 1;
        p.a[p.a.length - 1] += c;
      } else if (!p.quote && !p.sQuote && c === character) {
        p.a.push('');
      } else {
        p.a[p.a.length - 1] += c;
      }
      return p;
    },
    { quote: 0, sQuote: 0, a: [''] },
  ).a;
}

/**
 * Traverse across shadow boundaries upwards to find parent element or host element.
 * Reference: Playwright (parentElementOrShadowHost) & WebdriverIO (findParentOrHost)
 */
export function parentElementOrShadowHost(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  if (!element.parentNode) return null;
  if (element.parentNode.nodeType === 11 && (element.parentNode as ShadowRoot).host) {
    return (element.parentNode as ShadowRoot).host as Element;
  }
  return null;
}

/**
 * Normalizes explicit shadow-piercing combinators ('>>>', '/deep/', and '>>') outside quotes to whitespace.
 */
function normalizeExplicitCombinators(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let result = '';

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      result += c;
    } else if (!quote && !sQuote) {
      if (
        c === '/' &&
        matches[i + 1] === 'd' &&
        matches[i + 2] === 'e' &&
        matches[i + 3] === 'e' &&
        matches[i + 4] === 'p' &&
        matches[i + 5] === '/'
      ) {
        result += ' ';
        i += 5;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>' && matches[i + 2] === '>') {
        result += ' ';
        i += 2;
        continue;
      }
      if (c === '>' && matches[i + 1] === '>') {
        result += ' ';
        i += 1;
        continue;
      }
      result += c;
    } else {
      result += c;
    }
  }
  return result;
}

function foldCombinatorsUnlessQuoted(selector: string): string {
  const matches = selector.match(/\\?.|^$/gs) || [];
  let quote = 0;
  let sQuote = 0;
  let currentUnquoted = '';
  let result = '';

  const flushUnquoted = () => {
    if (currentUnquoted) {
      const folded = currentUnquoted
        .replace(/\s*([+~])\s*/g, '$1')
        .replace(/(?<!>)\s*>\s*(?!>)/g, '>');
      result += folded;
      currentUnquoted = '';
    }
  };

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      if (!quote) flushUnquoted();
      quote ^= 1;
      result += c;
    } else if (c === "'" && !quote) {
      if (!sQuote) flushUnquoted();
      sQuote ^= 1;
      result += c;
    } else if (quote || sQuote) {
      result += c;
    } else {
      currentUnquoted += c;
    }
  }
  flushUnquoted();
  return result;
}

/**
 * Safely split a selector by delimiter (default space):
 * 1. Folds whitespace around child (>), next-sibling (+), and subsequent-sibling (~) combinators outside quotes;
 * 2. Splits using single/double quote and bracket/paren state machine so whitespace inside quotes,
 *    attribute brackets [...], and pseudo-classes (...) is preserved;
 * 3. Supports explicit piercing combinators ' >> ', '>>>', '/deep/'.
 */
export function splitSelectorSafely(selector: string, delimiter: string = ' '): string[] {
  if (!selector) return [];
  const normalized = normalizeExplicitCombinators(selector);
  const folded = foldCombinatorsUnlessQuoted(normalized);

  const matches = folded.match(/\\?.|^$/gs);
  if (!matches) return [folded.trim()].filter(Boolean);

  let quote = 0;
  let sQuote = 0;
  let brackets = 0;
  let parens = 0;
  const parts: string[] = [''];

  for (let i = 0; i < matches.length; i++) {
    const c = matches[i];
    if (c === '"' && !sQuote) {
      quote ^= 1;
      parts[parts.length - 1] += c;
    } else if (c === "'" && !quote) {
      sQuote ^= 1;
      parts[parts.length - 1] += c;
    } else if (!quote && !sQuote) {
      if (c === '[') brackets++;
      else if (c === ']' && brackets > 0) brackets--;
      else if (c === '(') parens++;
      else if (c === ')' && parens > 0) parens--;

      if (
        brackets === 0 &&
        parens === 0 &&
        (c === delimiter || (delimiter === ' ' && /\s/.test(c)))
      ) {
        parts.push('');
      } else {
        parts[parts.length - 1] += c;
      }
    } else {
      parts[parts.length - 1] += c;
    }
  }

  return parts.map((s) => s.trim()).filter(Boolean);
}

function pruneNestedQueryContexts(contexts: ParentNode[]): ParentNode[] {
  if (contexts.length <= 1) return contexts;
  const contextSet = new Set<ParentNode>(contexts);
  const pruned: ParentNode[] = [];

  for (let idx = 0; idx < contexts.length; idx++) {
    const ctx = contexts[idx];
    if (typeof Element === 'undefined' || !(ctx instanceof Element)) {
      pruned.push(ctx);
      continue;
    }
    let coveredByAncestor = false;
    let ancestor: Element | null = ctx.parentElement;
    while (ancestor) {
      if (contextSet.has(ancestor)) {
        coveredByAncestor = true;
        break;
      }
      ancestor = ancestor.parentElement;
    }
    if (!coveredByAncestor) {
      const rootNode = typeof ctx.getRootNode === 'function' ? ctx.getRootNode() : null;
      if (rootNode && rootNode !== ctx && contextSet.has(rootNode as ParentNode)) {
        coveredByAncestor = true;
      }
    }
    if (!coveredByAncestor) {
      pruned.push(ctx);
    }
  }

  return pruned;
}

/**
 * Single-segment search within a root across all open and closed ShadowRoot boundaries.
 */
function querySelectorAllDeepSingle(
  selector: string,
  root: ParentNode,
  seenResults: Set<Element> = new Set<Element>(),
  results: Element[] = [],
  visitedRoots: Set<Node> = new Set<Node>(),
): Element[] {
  const isWildcard = selector.trim() === '*';

  const pushResult = (el: Element) => {
    if (!seenResults.has(el)) {
      seenResults.add(el);
      results.push(el);
    }
  };

  const inspectSlotted = (el: Element) => {
    if (isWildcard) {
      pushResult(el);
    } else {
      try {
        if (typeof el.matches === 'function' && el.matches(selector)) {
          pushResult(el);
        }
      } catch {}
    }
    const sr = getShadowRoot(el);
    if (sr) search(sr);
    search(el);
  };

  function search(currentRoot: ParentNode) {
    if (!currentRoot || visitedRoots.has(currentRoot)) return;
    visitedRoots.add(currentRoot);

    let allEls: NodeListOf<Element>;
    try {
      allEls = currentRoot.querySelectorAll('*');
    } catch {
      return;
    }

    if (isWildcard) {
      for (let i = 0; i < allEls.length; i++) {
        pushResult(allEls[i]);
      }
    } else {
      try {
        const matches = currentRoot.querySelectorAll(selector);
        for (let i = 0; i < matches.length; i++) {
          pushResult(matches[i]);
        }
      } catch {}
    }

    for (let i = 0; i < allEls.length; i++) {
      const el = allEls[i];
      const shadow = getShadowRoot(el);
      if (shadow) {
        search(shadow);
      }
      if (
        (el.tagName === 'SLOT' || el.tagName === 'slot') &&
        typeof (el as HTMLSlotElement).assignedElements === 'function'
      ) {
        try {
          for (const assigned of (el as HTMLSlotElement).assignedElements({ flatten: true })) {
            inspectSlotted(assigned);
          }
        } catch {}
      }
    }
  }

  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      search(rootShadow);
    }
  }

  search(root);
  return results;
}

/**
 * Deep query selector that penetrates all open (and closed when supported) ShadowRoot boundaries.
 * Traverses recursively through both standard light DOM and encapsulated component shadow roots.
 * Supports explicit piercing (' >> ', '>>>', '/deep/') and composite descendant selectors
 * (e.g. 'shreddit-markdown-composer textarea') across shadow boundaries.
 */
export function querySelectorAllDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element[] {
  if (!root || !selector || typeof selector !== 'string') return [];

  const commaSeparators = splitSelectorSafely(selector, ',');
  if (commaSeparators.length > 1) {
    const hasComplexSegment = commaSeparators.some(
      (sub) => splitSelectorSafely(sub, ' ').length > 1,
    );
    if (hasComplexSegment) {
      const combined: Element[] = [];
      const seenCombined = new Set<Element>();
      for (const sub of commaSeparators) {
        const subMatches = querySelectorAllDeep(sub, root);
        for (const match of subMatches) {
          if (!seenCombined.has(match)) {
            seenCombined.add(match);
            combined.push(match);
          }
        }
      }
      return combined;
    }
    return querySelectorAllDeepSingle(selector, root);
  }

  const segments = splitSelectorSafely(selector, ' ');
  if (segments.length === 0) return [];

  if (segments.length === 1) {
    return querySelectorAllDeepSingle(segments[0], root);
  }

  let currentContexts: ParentNode[] = [root];
  if (typeof Element !== 'undefined' && root instanceof Element) {
    const rootShadow = getShadowRoot(root);
    if (rootShadow) {
      currentContexts.push(rootShadow);
    }
  }

  for (let i = 0; i < segments.length; i++) {
    const subSelector = segments[i];
    const isLast = i === segments.length - 1;
    const activeContexts = subSelector.includes(':scope')
      ? currentContexts
      : pruneNestedQueryContexts(currentContexts);
    const nextMatches: Element[] = [];
    const seenNext = new Set<Element>();
    const visitedRoots = new Set<Node>();

    for (let ctxIndex = 0; ctxIndex < activeContexts.length; ctxIndex++) {
      querySelectorAllDeepSingle(
        subSelector,
        activeContexts[ctxIndex],
        seenNext,
        nextMatches,
        visitedRoots,
      );
    }

    if (isLast) {
      return nextMatches;
    }

    const nextContexts: ParentNode[] = [];
    const seenContexts = new Set<ParentNode>();
    for (let matchIndex = 0; matchIndex < nextMatches.length; matchIndex++) {
      const match = nextMatches[matchIndex];
      if (!seenContexts.has(match)) {
        seenContexts.add(match);
        nextContexts.push(match);
      }
      const sr = getShadowRoot(match);
      if (sr && !seenContexts.has(sr)) {
        seenContexts.add(sr);
        nextContexts.push(sr);
      }
    }
    currentContexts = nextContexts;
    if (currentContexts.length === 0) return [];
  }

  return [];
}

/**
 * Deep query selector returning the first matching element across all shadow boundaries.
 */
export function querySelectorDeep(
  selector: string,
  root: ParentNode = typeof document !== 'undefined' ? document : (null as any),
): Element | null {
  const results = querySelectorAllDeep(selector, root);
  return results.length > 0 ? results[0] : null;
}
