import {
  derefElement,
  getIsolatedIndexMap,
  indexElement,
  querySelectorAllDeep,
} from '../dom-indexer';

export interface PerceptiveSignature {
  question?: string;
  progress?: string;
  stepCurrent?: number;
  stepTotal?: number;
  activeInputs: Array<{
    index?: number;
    tagName: string;
    type?: string;
    name?: string;
    placeholder?: string;
    ariaLabel?: string;
    value?: string;
  }>;
  alerts: string[];
  url: string;
  title: string;
}

/**
 * Extracts key semantic perception signature from the active viewport:
 * - Active question headings (h1-h4, [role="heading"], .question-text)
 * - Step progress indicator (e.g. "2 of 15", "Step 3", "2 / 15")
 * - Currently visible active inputs/controls
 * - Active validation alerts and error banners
 */
export function inPageDetectPerceptiveSignature(): PerceptiveSignature {
  const win = window;
  const doc = document;
  const vh = win.innerHeight || 800;
  const vw = win.innerWidth || 1280;

  function isVisibleInViewport(el: Element): boolean {
    if (!el || !(el instanceof Element)) return false;
    let style: CSSStyleDeclaration | null = null;
    try {
      style = win.getComputedStyle(el);
    } catch {}
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      parseFloat(style?.opacity || '1') <= 0 ||
      style?.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true' ||
      (typeof el.closest === 'function' && el.closest('[aria-hidden="true"], [inert]') !== null)
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
  }

  // 1. Detect question headings in active viewport
  let question: string | undefined;
  const headingSelectors = [
    'h1, h2, h3, h4',
    '[role="heading"]',
    '.question-text',
    '[data-qa*="question" i]',
    '[data-qa*="title" i]',
    '[class*="question" i]',
    '[class*="title" i]',
    '[class*="header" i]',
    'legend',
  ].join(', ');

  const headings = Array.from(doc.querySelectorAll(headingSelectors)).filter(isVisibleInViewport);
  headings.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);

  for (const h of headings) {
    const text = (h.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length >= 3 && text.length <= 300) {
      question = text;
      break;
    }
  }

  // 2. Detect progress indicators (e.g. "2 of 15", "Step 3 of 10", "3 / 10", "20%")
  let progress: string | undefined;
  let stepCurrent: number | undefined;
  let stepTotal: number | undefined;

  const progressBars = Array.from(doc.querySelectorAll('[role="progressbar"]')).filter(
    isVisibleInViewport,
  );
  for (const pb of progressBars) {
    const valNow = pb.getAttribute('aria-valuenow');
    const valMax = pb.getAttribute('aria-valuemax');
    const ariaText = pb.getAttribute('aria-valuetext') || pb.getAttribute('aria-label');
    if (valNow && valMax) {
      stepCurrent = parseInt(valNow, 10);
      stepTotal = parseInt(valMax, 10);
      progress = `${stepCurrent} / ${stepTotal}`;
      break;
    } else if (ariaText) {
      const match = /\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(ariaText);
      if (match) {
        stepCurrent = parseInt(match[1], 10);
        stepTotal = parseInt(match[2], 10);
        progress = `${stepCurrent} / ${stepTotal}`;
        break;
      }
    }
  }

  if (!progress) {
    const progressCandidateSelectors = [
      '[class*="progress" i]',
      '[class*="step" i]',
      '[data-qa*="progress" i]',
      '[data-qa*="step" i]',
      'span, div, p',
    ].join(', ');
    const candidates = Array.from(doc.querySelectorAll(progressCandidateSelectors)).filter(
      isVisibleInViewport,
    );
    for (const c of candidates) {
      if (c.children.length > 2) continue;
      const t = (c.textContent || '').trim();
      if (t.length > 40) continue;
      const match = /\b(\d+)\s*(?:of|\/)\s*(\d+)\b/i.exec(t);
      if (match) {
        stepCurrent = parseInt(match[1], 10);
        stepTotal = parseInt(match[2], 10);
        progress = `${stepCurrent} / ${stepTotal}`;
        break;
      }
      const stepMatch = /\bstep\s*(\d+)\b/i.exec(t);
      if (stepMatch) {
        stepCurrent = parseInt(stepMatch[1], 10);
        progress = t;
        break;
      }
      const zhMatch = /第\s*(\d+)\s*(?:题|步)(?:\s*(?:共|\/)\s*(\d+)\s*(?:题|步)?)?/i.exec(t);
      if (zhMatch) {
        stepCurrent = parseInt(zhMatch[1], 10);
        if (zhMatch[2]) stepTotal = parseInt(zhMatch[2], 10);
        progress = t;
        break;
      }
    }
  }

  // 3. Detect active form inputs in active viewport
  const isolatedMap = getIsolatedIndexMap();
  const indexLookup = new Map<Element, number>();
  for (const [idx, entry] of isolatedMap.entries()) {
    const target = derefElement(entry);
    if (target) indexLookup.set(target, idx);
  }

  const activeInputs: PerceptiveSignature['activeInputs'] = [];
  const inputElements = Array.from(
    doc.querySelectorAll(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], [role="textbox"]',
    ),
  ).filter(isVisibleInViewport);

  for (const inp of inputElements) {
    const tag = inp.tagName.toLowerCase();
    const type = (inp as HTMLInputElement).type?.toLowerCase();
    const name = inp.getAttribute('name') || undefined;
    const placeholder = inp.getAttribute('placeholder') || undefined;
    const ariaLabel = inp.getAttribute('aria-label') || undefined;
    const value =
      inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement
        ? inp.value
        : (inp as HTMLElement).innerText?.trim() || undefined;

    let inpIndex = indexLookup.get(inp);
    if (typeof inpIndex !== 'number') {
      inpIndex = indexElement(inp);
      indexLookup.set(inp, inpIndex);
    }

    activeInputs.push({
      index: inpIndex,
      tagName: tag,
      type,
      name,
      placeholder,
      ariaLabel,
      value: value ? value.slice(0, 80) : undefined,
    });
  }

  // 4. Detect alerts and errors in active viewport
  const alerts: string[] = [];
  const alertElements = Array.from(
    doc.querySelectorAll(
      '[role="alert"], [role="status"], .error-message, [class*="error" i], [class*="invalid" i]',
    ),
  ).filter(isVisibleInViewport);

  for (const a of alertElements) {
    const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
    if (text.length >= 3 && text.length <= 200 && !alerts.includes(text)) {
      alerts.push(text);
    }
  }

  return {
    question,
    progress,
    stepCurrent,
    stepTotal,
    activeInputs,
    alerts,
    url: win.location.href,
    title: doc.title || '',
  };
}

export interface ChoiceCandidateItem {
  index: number;
  tagName: string;
  role?: string;
  text: string;
  ariaLabel?: string;
  value?: string;
}

/**
 * Scans viewport for interactive choice/option elements (buttons, radio buttons, options, tiles, links).
 * Automatically indexes unindexed elements in isolatedMap to enable physical click dispatch.
 */
export function inPageQueryChoiceCandidates(): ChoiceCandidateItem[] {
  const win = window;
  const doc = document;
  const vh = win.innerHeight || 800;
  const vw = win.innerWidth || 1280;

  function isVisibleInViewport(el: Element): boolean {
    if (!el || !(el instanceof Element)) return false;
    let style: CSSStyleDeclaration | null = null;
    try {
      style = win.getComputedStyle(el);
    } catch {}
    if (
      style?.display === 'none' ||
      style?.visibility === 'hidden' ||
      parseFloat(style?.opacity || '1') <= 0 ||
      style?.pointerEvents === 'none' ||
      el.hasAttribute('inert') ||
      (el as any).inert === true ||
      el.getAttribute('aria-hidden') === 'true' ||
      (typeof el.closest === 'function' && el.closest('[aria-hidden="true"], [inert]') !== null)
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return rect.top < vh && rect.bottom > 0 && rect.left < vw && rect.right > 0;
  }

  const isolatedMap = getIsolatedIndexMap();
  const indexLookup = new Map<Element, number>();
  for (const [idx, entry] of isolatedMap.entries()) {
    const target = derefElement(entry);
    if (target) indexLookup.set(target, idx);
  }

  const selector =
    'button, [role="button"], [role="radio"], [role="option"], label, input[type="radio"], input[type="checkbox"], [role="checkbox"], a, li[role="treeitem"]';
  let elements: Element[];
  try {
    elements = querySelectorAllDeep(selector, doc).filter(isVisibleInViewport);
  } catch {
    elements = Array.from(doc.querySelectorAll(selector)).filter(isVisibleInViewport);
  }

  const results: ChoiceCandidateItem[] = [];
  for (const el of elements) {
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const ariaLabel = el.getAttribute('aria-label') || undefined;
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLButtonElement ? el.value : undefined;
    const role = el.getAttribute('role') || undefined;
    const tagName = el.tagName.toLowerCase();

    if (!text && !ariaLabel && !value) continue;

    let idx = indexLookup.get(el);
    if (typeof idx !== 'number') {
      idx = indexElement(el);
      indexLookup.set(el, idx);
    }

    results.push({
      index: idx,
      tagName,
      role,
      text: text || ariaLabel || value || '',
      ariaLabel,
      value,
    });
  }

  return results;
}

/**
 * Compares two perceptive signatures and generates a structured delta.
 */
export function computePerceptiveDelta(
  pre: PerceptiveSignature | null | undefined,
  post: PerceptiveSignature | null | undefined,
):
  | {
      advanced: boolean;
      questionChanged: boolean;
      progressChanged: boolean;
      previousQuestion?: string;
      currentQuestion?: string;
      previousProgress?: string;
      progress?: string;
      activeInputs: PerceptiveSignature['activeInputs'];
      errorMessage?: string;
      urlChanged: boolean;
    }
  | undefined {
  if (!post && !pre) return undefined;
  if (!post && pre) {
    return {
      advanced: false,
      questionChanged: false,
      progressChanged: false,
      previousQuestion: pre.question,
      currentQuestion: undefined,
      previousProgress: pre.progress,
      progress: undefined,
      activeInputs: [],
      urlChanged: false,
    };
  }
  if (post && !pre) {
    return {
      advanced: false,
      questionChanged: false,
      progressChanged: false,
      currentQuestion: post.question,
      progress: post.progress,
      activeInputs: post.activeInputs || [],
      errorMessage: post.alerts && post.alerts.length > 0 ? post.alerts.join('; ') : undefined,
      urlChanged: false,
    };
  }

  const p1 = pre!;
  const p2 = post!;

  const questionChanged = Boolean(
    (p1.question && p2.question && p1.question !== p2.question) ||
    (!p1.question && p2.question) ||
    (p1.question && !p2.question),
  );
  const progressChanged = Boolean(
    (p1.progress && p2.progress && p1.progress !== p2.progress) ||
    (!p1.progress && p2.progress) ||
    (p1.progress && !p2.progress),
  );
  const inputsDisappeared = Boolean(
    p1.activeInputs &&
    p1.activeInputs.length > 0 &&
    (!p2.activeInputs || p2.activeInputs.length === 0),
  );
  const stepAdvanced =
    (typeof p2.stepCurrent === 'number' &&
      typeof p1.stepCurrent === 'number' &&
      p2.stepCurrent > p1.stepCurrent) ||
    (typeof p2.stepCurrent === 'number' && p1.stepCurrent === undefined) ||
    progressChanged ||
    questionChanged ||
    inputsDisappeared;
  const urlChanged = Boolean(p1.url && p2.url && p1.url !== p2.url);
  const advanced = Boolean(stepAdvanced || urlChanged);

  return {
    advanced,
    questionChanged,
    progressChanged,
    previousQuestion: p1.question,
    currentQuestion: p2.question,
    previousProgress: p1.progress,
    progress: p2.progress,
    activeInputs: p2.activeInputs || [],
    errorMessage: p2.alerts && p2.alerts.length > 0 ? p2.alerts.join('; ') : undefined,
    urlChanged,
  };
}

/**
 * Extract clean hierarchical markdown from document.
 * Deeply traverses paragraphs and containers to preserve links, bold, code, and structural elements.
 */
