import type { ScrollInfo } from 'chrome-mcp-shared';
import {
  composedContains,
  getIsolatedIndexMap,
  indexElement,
  querySelectorDeep,
  findIndexedElement,
  getDeepActiveElement,
  parseElementIndex,
  derefElement,
  computeInteractionScope,
  detectEditorSemantics,
  buildScopedScrollInfo,
} from '../dom-indexer';

export function cleanAndNormalizeText(str: string): string {
  return str
    .replace(/[\u200B-\u200D\uFEFF]/g, '') // strip zero-width characters (Draft.js/Lexical artifacts)
    .replace(/\u00A0/g, ' ') // non-breaking space to normal space
    .replace(/\r\n|\r/g, '\n') // newline normalization
    .replace(/[ \t]+/g, ' ') // collapse horizontal spaces
    .trim();
}

/**
 * Focus Guard: strictly verifies that document.activeElement is indeed the target element.
 * Traverses shadow roots if present. If the target element was clicked but did not acquire focus,
 * attempts programmatic focus fallback. If activeElement is a previously focused element, returns isFocused: false
 * to prevent misdirected text typing and concatenation.
 */
export function inPageVerifyActiveElement(
  refOrIndex?: number | string,
  selector?: string,
): {
  success: boolean;
  isFocused: boolean;
  targetTag?: string;
  activeTag?: string;
  activeId?: string;
  activeName?: string;
  error?: string;
} {
  let targetEl: Element | null = null;
  // If a CSS selector is provided, prioritize it for dynamic SPAs where indices drift
  if (selector) {
    try {
      targetEl = document.querySelector(selector);
    } catch {}
  }
  if (!targetEl && refOrIndex !== undefined && refOrIndex !== null && refOrIndex !== '') {
    targetEl = findIndexedElement(refOrIndex);
  }
  if (!targetEl && typeof refOrIndex === 'string') {
    try {
      targetEl = document.querySelector(refOrIndex);
    } catch {}
  }

  if (!targetEl) {
    return {
      success: false,
      isFocused: false,
      error: `Target element [${refOrIndex ?? selector}] not found in DOM during active element verification`,
    };
  }

  let active = getDeepActiveElement();

  // Check if active matches targetEl or is contained within targetEl (e.g. contenteditable or custom input inside wrapper)
  let isFocused = composedContains(targetEl, active);

  // If focus failed via mouse click, attempt programmatic focus fallback
  if (!isFocused && typeof (targetEl as HTMLElement).focus === 'function') {
    try {
      (targetEl as HTMLElement).focus({ preventScroll: true });
      active = getDeepActiveElement();
      isFocused = composedContains(targetEl, active);
    } catch {}
  }

  // If still not focused and targetEl is a composite container wrapping an input/textarea/contenteditable
  if (!isFocused && typeof targetEl.querySelector === 'function') {
    const innerFocusable = querySelectorDeep(
      'input:not([type="hidden"]), textarea, [contenteditable="true"]',
      targetEl,
    ) as HTMLElement | null;
    if (innerFocusable && typeof innerFocusable.focus === 'function') {
      try {
        innerFocusable.focus({ preventScroll: true });
        active = getDeepActiveElement();
        isFocused =
          active === targetEl || active === innerFocusable || composedContains(targetEl, active);
      } catch {}
    }
  }

  const targetTag = targetEl.tagName.toLowerCase();
  const activeTag = active?.tagName?.toLowerCase() || 'none';
  const activeId = (active as HTMLElement)?.id || undefined;
  const activeName = (active as HTMLInputElement)?.name || undefined;

  if (!isFocused) {
    const activeDesc = `<${activeTag}${activeId ? '#' + activeId : ''}${activeName ? '[name="' + activeName + '"]' : ''}>`;
    return {
      success: false,
      isFocused: false,
      targetTag,
      activeTag,
      activeId,
      activeName,
      error: `Focus verification failed: target element [${refOrIndex ?? selector}] (<${targetTag}>) is not active. document.activeElement is ${activeDesc}. Target element could not be focused.`,
    };
  }

  return {
    success: true,
    isFocused: true,
    targetTag,
    activeTag,
    activeId,
    activeName,
  };
}

/**
 * Chained Snapshot Helper: extracts lightweight active element & modal state
 * for instant post-action feedback without requiring a full DOM re-scan.
 */
export function inPageGetActiveElementSummary(): {
  tagName?: string;
  id?: string;
  role?: string;
  type?: string;
  isInput?: boolean;
  value?: string;
  text?: string;
  hasActiveModal?: boolean;
  activeModal?: string;
  focusTrapped?: boolean;
  modalIsolated?: boolean;
  isConfirmationTrap?: boolean;
  scrollInfo?: ScrollInfo;
} {
  try {
    const el = getDeepActiveElement();
    const scope = computeInteractionScope(window);
    const hasActiveModal = scope.focusTrapped;
    const scrollInfo = buildScopedScrollInfo(scope.roots, window, {
      modalActive: scope.focusTrapped,
      containers: scope.scrollContainers,
    });
    const modalState = {
      hasActiveModal,
      activeModal: scope.activeModal,
      focusTrapped: scope.focusTrapped,
      modalIsolated: scope.modalIsolated,
      isConfirmationTrap: scope.isConfirmationTrap,
      scrollInfo,
    };

    if (!el || el === document.body || el === document.documentElement) {
      return modalState;
    }

    const targetEl = el as HTMLElement;
    const tagName = targetEl.tagName.toLowerCase();
    const id = targetEl.id || undefined;
    const role = targetEl.getAttribute('role') || undefined;
    const type = targetEl.getAttribute('type') || undefined;
    const isInput =
      ['input', 'textarea', 'select'].includes(tagName) ||
      targetEl.getAttribute('contenteditable') === 'true';
    const value =
      isInput &&
      !['password', 'file', 'hidden'].includes((type || '').toLowerCase()) &&
      'value' in targetEl
        ? String((targetEl as any).value ?? '').slice(0, 60)
        : undefined;
    const text = targetEl.textContent?.trim()?.slice(0, 60) || undefined;

    return {
      tagName,
      id,
      role,
      type,
      isInput,
      value,
      text,
      ...modalState,
    };
  } catch {
    return {};
  }
}

/**
 * Selects an option on custom div[role="combobox"] / [role="listbox"] elements:
 * 1. Clicks trigger to open dropdown if closed (aria-expanded != true).
 * 2. Locates candidate options via aria-controls, aria-owns, dropdown portals, or child elements.
 * 3. Matches option by exact text/value, word boundary, prefix, or substring.
 * 4. Clicks the matching option and dispatches input/change events.
 */
export async function inPageSelectCustomCombobox(
  refOrIndex?: number | string,
  selector?: string,
  valueToSelect?: string,
): Promise<{
  success: boolean;
  committed: boolean;
  selectedText?: string;
  selectedValue?: string;
  diagnostics?: string;
  error?: string;
}> {
  let element: Element | null = null;
  if (selector) {
    try {
      element = document.querySelector(selector);
    } catch {}
  }
  if (!element && refOrIndex !== undefined && refOrIndex !== null && refOrIndex !== '') {
    element = findIndexedElement(refOrIndex);
  }
  if (!element && typeof refOrIndex === 'string') {
    try {
      element = document.querySelector(refOrIndex);
    } catch {}
  }

  if (!element) {
    return {
      success: false,
      committed: false,
      error: `Combobox target [${refOrIndex ?? selector}] not found in active DOM`,
    };
  }

  const targetVal = String(valueToSelect ?? '').trim();

  // 1. Native <select> or container wrapping a <select>
  const selectEl =
    element.tagName.toLowerCase() === 'select'
      ? (element as HTMLSelectElement)
      : element.querySelector('select');
  if (selectEl) {
    let matched = false;
    let matchedText = '';
    let matchedValue = '';
    const normTarget = targetVal.toLowerCase();

    for (const opt of Array.from(selectEl.options)) {
      const oText = opt.text.trim().toLowerCase();
      const oVal = opt.value.trim().toLowerCase();
      if (oText === normTarget || oVal === normTarget) {
        matched = true;
        matchedText = opt.text.trim();
        matchedValue = opt.value;
        break;
      }
    }
    if (!matched) {
      for (const opt of Array.from(selectEl.options)) {
        const oText = opt.text.trim().toLowerCase();
        if (oText.startsWith(normTarget) || oText.includes(normTarget)) {
          matched = true;
          matchedText = opt.text.trim();
          matchedValue = opt.value;
          break;
        }
      }
    }
    if (!matched) {
      matchedText = targetVal;
      matchedValue = targetVal;
      matched = true;
    }

    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
    if (nativeSetter) {
      nativeSetter.call(selectEl, matchedValue);
    } else {
      selectEl.value = matchedValue;
    }

    selectEl.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    selectEl.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

    return {
      success: true,
      committed: true,
      selectedText: matchedText,
      selectedValue: matchedValue,
    };
  }

  // 2. Custom ARIA Combobox / Listbox
  // Click combobox to open dropdown if not expanded
  const isExpanded = element.getAttribute('aria-expanded') === 'true';
  if (!isExpanded) {
    try {
      if (typeof (element as HTMLElement).focus === 'function') {
        (element as HTMLElement).focus({ preventScroll: true });
      }
      try {
        element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      } catch {}
      element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      (element as HTMLElement).click?.();
      // Allow framework portal / dropdown menu to mount
      await new Promise((r) => setTimeout(r, 80));
    } catch {}
  }

  // Search candidate options in:
  // a) aria-controls or aria-owns container (with ShadowRoot support)
  const ariaControls = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
  const searchRoots: Element[] = [element];
  if (ariaControls) {
    const rootNode = typeof element.getRootNode === 'function' ? element.getRootNode() : null;
    const controlled =
      (rootNode as ShadowRoot | Document)?.getElementById?.(ariaControls) ||
      document.getElementById(ariaControls);
    if (controlled) searchRoots.push(controlled);
  }

  // b) Document portals / overlays
  const portalSelector =
    '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], .ant-select-dropdown, .el-select-dropdown, .MuiMenu-paper, [class*="select-dropdown" i], [class*="dropdown-menu" i]';
  const portals = Array.from(document.querySelectorAll(portalSelector));
  searchRoots.push(...portals);

  // Collect option elements
  const optionSelector =
    '[role="option"], [role="menuitem"], [role="treeitem"], [data-radix-collection-item], [data-combobox-option], .ant-select-item-option, .el-select-dropdown__item, .MuiMenuItem-root, .v-list-item, li[data-value], [class*="option" i], [class*="select-item" i]';

  const candidates: Element[] = [];
  for (const root of searchRoots) {
    const found = Array.from(root.querySelectorAll(optionSelector));
    for (const f of found) {
      if (!candidates.includes(f)) candidates.push(f);
    }
  }

  // Fallback: document-wide option query if none found in candidate roots
  if (candidates.length === 0) {
    const docOptions = Array.from(document.querySelectorAll(optionSelector));
    candidates.push(...docOptions);
  }

  // Filter out hidden options (e.g. in closed submenus or offscreen inactive portals)
  const visibleCandidates = candidates.filter((el) => {
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false;
    if (
      typeof el.closest === 'function' &&
      el.closest('[hidden], [aria-hidden="true"], [style*="display: none"]')
    ) {
      return false;
    }
    return true;
  });
  const activeCandidates = visibleCandidates.length > 0 ? visibleCandidates : candidates;

  if (activeCandidates.length === 0) {
    return {
      success: false,
      committed: false,
      error: `Custom combobox opened, but no [role="option"] elements found in DOM or portals.`,
    };
  }

  // Match best candidate option
  const normTarget = targetVal.toLowerCase();
  let matchedOption: Element | null = null;

  // Pass 1: exact text or value
  for (const opt of activeCandidates) {
    const text = (opt.textContent || '').trim().toLowerCase();
    const val = (opt.getAttribute('data-value') || opt.getAttribute('value') || '')
      .trim()
      .toLowerCase();
    if (text === normTarget || (val && val === normTarget)) {
      matchedOption = opt;
      break;
    }
  }

  // Pass 2: exact word boundary match
  if (!matchedOption) {
    const safeWord = normTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(^|\\b|\\s)${safeWord}(\\b|\\s|$)`, 'i');
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim();
      if (wordRegex.test(text)) {
        matchedOption = opt;
        break;
      }
    }
  }

  // Pass 3: startsWith
  if (!matchedOption) {
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim().toLowerCase();
      if (text.startsWith(normTarget)) {
        matchedOption = opt;
        break;
      }
    }
  }

  // Pass 4: includes
  if (!matchedOption) {
    for (const opt of activeCandidates) {
      const text = (opt.textContent || '').trim().toLowerCase();
      if (text.includes(normTarget)) {
        matchedOption = opt;
        break;
      }
    }
  }

  if (!matchedOption) {
    const availableTexts = activeCandidates
      .map((c) => c.textContent?.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(', ');
    return {
      success: false,
      committed: false,
      error: `No matching option found for "${targetVal}" in combobox. Available options: [${availableTexts}]`,
    };
  }

  // Click the matched option
  try {
    if (typeof (matchedOption as HTMLElement).focus === 'function') {
      (matchedOption as HTMLElement).focus({ preventScroll: true });
    }
    try {
      matchedOption.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
      );
    } catch {}
    matchedOption.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    matchedOption.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    matchedOption.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    (matchedOption as HTMLElement).click?.();
  } catch {}

  // Trigger input and change on the combobox trigger element as well
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

  // Settle pause
  await new Promise((r) => setTimeout(r, 50));

  const selectedText = matchedOption.textContent?.trim() || targetVal;
  const selectedValue =
    matchedOption.getAttribute('data-value') || matchedOption.getAttribute('value') || selectedText;

  return {
    success: true,
    committed: true,
    selectedText,
    selectedValue,
  };
}

/**
 * Verifies whether input text was truly committed into framework reactive state (React/Draft.js/Lexical).
 * Inspects element value/text and checks for nearby submit/tweet/post buttons disabled state.
 */
export function inPageVerifyInputCommitment(
  refOrIndex: number | string,
  expectedText: string,
): {
  committed: boolean;
  currentValue: string;
  expectedValue: string;
  length: number;
  tagName: string;
  isComposer?: boolean;
  submitButtonState?: {
    found: boolean;
    disabled?: boolean;
    text?: string;
    index?: number;
  };
  diagnostics?: string;
} {
  const parsed = parseElementIndex(refOrIndex);
  if (!parsed) {
    return {
      committed: false,
      currentValue: '',
      expectedValue: expectedText,
      length: 0,
      tagName: 'unknown',
      diagnostics: `Invalid index or ref format: `,
    };
  }
  const index = parsed.numericIndex;

  const el = findIndexedElement(refOrIndex);
  if (!el || !(el instanceof Element)) {
    return {
      committed: false,
      currentValue: '',
      expectedValue: expectedText,
      length: 0,
      tagName: 'unknown',
      diagnostics: `Element [${index}] not found during commitment verification`,
    };
  }

  const semantics = detectEditorSemantics(el);
  let currentValue = '';

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    currentValue = el.value || '';
  } else {
    const editTarget =
      (el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true'
        ? (el as HTMLElement)
        : (el.querySelector?.('[contenteditable="true"]') as HTMLElement) || (el as HTMLElement);
    const rawText =
      typeof editTarget.innerText === 'string' && editTarget.innerText.length > 0
        ? editTarget.innerText
        : editTarget.innerHTML
          ? editTarget.innerHTML
              .replace(/<br\s*\/?>/gi, '\n')
              .replace(/<\/div><div>/gi, '\n')
              .replace(/<\/p><p>/gi, '\n')
              .replace(/<[^>]+>/g, '')
          : editTarget.textContent || '';
    currentValue = rawText.trim();
  }

  // Only a native form owner and a real submitter establish submit-button
  // identity. Nearby icons, role=button elements and class-name guesses are not
  // proof that an element is the field's submit control.
  let submitButtonState: { found: boolean; disabled?: boolean; text?: string; index?: number } = {
    found: false,
  };
  try {
    const formOwner =
      (el as HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement).form ||
      el.closest('form');
    const submitButtons = formOwner
      ? Array.from(formOwner.elements).filter((candidate): candidate is Element => {
          if (candidate instanceof HTMLButtonElement) return candidate.type === 'submit';
          return (
            candidate instanceof HTMLInputElement &&
            (candidate.type === 'submit' || candidate.type === 'image')
          );
        })
      : [];
    // Multiple submitters make the next action ambiguous. Report no submit
    // identity instead of selecting the first one.
    const candidateBtn = submitButtons.length === 1 ? submitButtons[0] : undefined;

    if (candidateBtn) {
      const disabled =
        (candidateBtn as HTMLButtonElement).disabled === true ||
        candidateBtn.getAttribute('aria-disabled') === 'true' ||
        candidateBtn.classList.contains('disabled') ||
        (candidateBtn as HTMLElement).style.pointerEvents === 'none';

      let candidateBtnIndex: number | undefined;
      try {
        const isolatedMap = getIsolatedIndexMap();
        // Pass 1: exact match
        for (const [idx, entry] of isolatedMap.entries()) {
          const target = derefElement(entry);
          if (target === candidateBtn) {
            candidateBtnIndex = idx;
            break;
          }
        }
        // Pass 2: wrapper match
        if (candidateBtnIndex === undefined) {
          for (const [idx, entry] of isolatedMap.entries()) {
            const target = derefElement(entry);
            if (target && candidateBtn.contains(target)) {
              candidateBtnIndex = idx;
              break;
            }
          }
        }
        // Pass 3: allocate new index if still unindexed
        if (candidateBtnIndex === undefined) {
          candidateBtnIndex = indexElement(candidateBtn);
        }
      } catch {}
      submitButtonState = {
        found: true,
        disabled,
        text: (candidateBtn.textContent || (candidateBtn as HTMLInputElement).value || '').trim(),
        ...(typeof candidateBtnIndex === 'number' ? { index: candidateBtnIndex } : {}),
      };
    }
  } catch {}

  // Checkbox and radio inputs
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
    const isTruthy =
      expectedText === 'true' ||
      expectedText === '1' ||
      expectedText === 'checked' ||
      expectedText === 'on' ||
      (expectedText !== 'false' &&
        expectedText !== '0' &&
        expectedText !== 'off' &&
        Boolean(expectedText));
    const isChecked = el.checked;
    const committed = isChecked === isTruthy;
    return {
      committed,
      currentValue: String(isChecked),
      expectedValue: String(isTruthy),
      length: String(isChecked).length,
      tagName: el.tagName.toLowerCase(),
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Checkbox checked state (${isChecked}) did not match expected (${isTruthy})`,
    };
  }

  // Select dropdowns
  if (el instanceof HTMLSelectElement) {
    const selectedText = el.selectedOptions?.[0]?.text?.trim() || '';
    const committed =
      el.value === expectedText ||
      selectedText === expectedText.trim() ||
      selectedText.includes(expectedText.trim());
    return {
      committed,
      currentValue: el.value,
      expectedValue: expectedText,
      length: el.value.length,
      tagName: 'select',
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Select value ("${el.value}") did not match expected ("${expectedText}")`,
    };
  }

  // Native editable comboboxes are verified by their value, not option text.
  if (
    !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    (el.getAttribute('role') === 'combobox' ||
      el.getAttribute('role') === 'listbox' ||
      el.getAttribute('aria-haspopup') === 'listbox')
  ) {
    const activeDescendant = el.getAttribute('aria-activedescendant');
    let selectedOptionText = '';
    if (activeDescendant) {
      const descEl = el.ownerDocument.getElementById(activeDescendant);
      if (descEl) selectedOptionText = descEl.textContent?.trim() || '';
    }
    const innerInput = el.querySelector('input');
    const innerVal = innerInput?.value || '';
    const currentText = el.textContent?.trim() || '';
    const ariaVal = el.getAttribute('aria-valuenow') || '';
    const dataVal = el.getAttribute('data-value') || el.getAttribute('value') || '';

    // Check for aria-selected option
    const ariaControls = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let ariaSelectedText = '';
    const rootNode = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
    const controlled = ariaControls
      ? (rootNode as ShadowRoot | Document)?.getElementById?.(ariaControls) ||
        el.ownerDocument.getElementById(ariaControls) ||
        document.getElementById(ariaControls)
      : null;
    const selectedEl =
      el.querySelector('[aria-selected="true"], [data-selected="true"]') ||
      controlled?.querySelector('[aria-selected="true"], [data-selected="true"]');
    if (selectedEl) {
      ariaSelectedText =
        selectedEl.textContent?.trim() || selectedEl.getAttribute('data-value') || '';
    }

    const normExp = cleanAndNormalizeText(expectedText).toLowerCase();
    const safeWord = normExp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const wordRegex = new RegExp(`(^|\\b|\\s)${safeWord}(\\b|\\s|$)`, 'i');

    const committed = Boolean(
      (selectedOptionText && cleanAndNormalizeText(selectedOptionText).toLowerCase() === normExp) ||
      (ariaSelectedText && cleanAndNormalizeText(ariaSelectedText).toLowerCase() === normExp) ||
      (ariaVal && cleanAndNormalizeText(ariaVal).toLowerCase() === normExp) ||
      (dataVal && cleanAndNormalizeText(dataVal).toLowerCase() === normExp) ||
      (innerVal && cleanAndNormalizeText(innerVal).toLowerCase() === normExp) ||
      (currentText && cleanAndNormalizeText(currentText).toLowerCase() === normExp) ||
      (currentText && wordRegex.test(cleanAndNormalizeText(currentText))),
    );

    const displayVal =
      selectedOptionText || ariaSelectedText || innerVal || currentText || ariaVal || dataVal;
    return {
      committed,
      currentValue: displayVal,
      expectedValue: expectedText,
      length: displayVal.length,
      tagName: el.tagName.toLowerCase(),
      isComposer: false,
      submitButtonState: submitButtonState.found ? submitButtonState : undefined,
      diagnostics: committed
        ? undefined
        : `Combobox value ("${displayVal.slice(0, 50)}") did not match expected ("${expectedText}")`,
    };
  }

  function cleanAndNormalize(str: string): string {
    return cleanAndNormalizeText(str);
  }

  const normExpected = cleanAndNormalize(expectedText);
  const normCurrent = cleanAndNormalize(currentValue);

  let committed = false;
  if (!normExpected) {
    // If clearing, committed means length is 0
    committed = normCurrent.length === 0;
  } else {
    // Check if input element has maxlength constraint
    const maxLen =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
        ? el.maxLength > 0
          ? el.maxLength
          : -1
        : -1;
    const cappedExpected =
      maxLen > 0 && normExpected.length > maxLen ? normExpected.slice(0, maxLen) : normExpected;

    // Strictly committed if current value strictly matches expected text (or matches capped by maxlength)
    // Eliminates permissive normCurrent.includes(cappedExpected) which allowed concatenated multi-field values to falsely pass.
    const isStrictMatch =
      normCurrent.length > 0 &&
      (normCurrent === cappedExpected ||
        (maxLen > 0 && normCurrent === normExpected.slice(0, maxLen)));

    // Clean replacement / exact prefix matching (Requirement 2)
    // Supports phone number formatting (e.g. '(123) 456-7890' vs '1234567890'),
    // stripped formatting (e.g. '1234567890' vs '123-456-7890'),
    // and static currency/country formatting prefixes (e.g. '+1 ', '$ ', '¥ ')
    let isCleanMatch = false;
    if (!isStrictMatch && normCurrent.length > 0 && normExpected.length > 0) {
      const isPhoneOrNumber =
        (el instanceof HTMLInputElement && (el.type === 'tel' || el.type === 'number')) ||
        /phone|tel|mobile|zip|postal/i.test((el as HTMLInputElement).name || '') ||
        /phone|tel|mobile|zip|postal/i.test((el as HTMLInputElement).id || '');

      const digitsCurrent = normCurrent.replace(/\D/g, '');
      const digitsExpected = normExpected.replace(/\D/g, '');

      if (isPhoneOrNumber && digitsCurrent.length >= 7 && digitsCurrent === digitsExpected) {
        // Formatted phone or postal code match
        isCleanMatch = true;
      } else if (normCurrent.replace(/[\s().-]/g, '') === normExpected.replace(/[\s().-]/g, '')) {
        // Punctuation/spacing formatting difference
        isCleanMatch = true;
      } else if (normCurrent.endsWith(cappedExpected)) {
        // Static prefix check: prefix must only be non-alphanumeric formatting symbols (e.g. '+1 ', '$', '¥', '#')
        const prefix = normCurrent.slice(0, normCurrent.length - cappedExpected.length);
        if (prefix.length <= 4 && /^[$€£¥\s+#/:-]+$/.test(prefix)) {
          isCleanMatch = true;
        }
      }
    }

    committed = isStrictMatch || isCleanMatch;
  }

  let diagnostics: string | undefined;
  if (!committed) {
    diagnostics = `Element value ("${normCurrent.slice(0, 50)}") did not reflect expected input ("${normExpected.slice(0, 50)}").`;
  }

  return {
    committed,
    currentValue,
    expectedValue: expectedText,
    length: currentValue.length,
    tagName: el.tagName.toLowerCase(),
    isComposer: semantics.isComposer || semantics.isEditor,
    submitButtonState: submitButtonState.found ? submitButtonState : undefined,
    diagnostics,
  };
}
