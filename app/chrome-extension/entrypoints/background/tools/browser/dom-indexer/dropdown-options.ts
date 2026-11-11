import { findIndexedElement } from '../dom-indexer';

export interface DropdownOptionItem {
  text: string;
  value: string;
  index: number;
  selected: boolean;
}

export interface DropdownOptionsResult {
  success: boolean;
  type: 'select' | 'aria' | 'custom';
  id?: string;
  name?: string;
  options: DropdownOptionItem[];
  error?: string;
}

/**
 * In-page dropdown options extractor.
 * Supports native <select>, ARIA comboboxes/menus, and common custom UI dropdowns.
 * Lives here (not get-dropdown-options.ts) so the bundled inpage-engine script
 * can register it for file-based injection.
 */
export async function inPageExtractDropdownOptions(
  targetIndex?: number,
  targetSelector?: string,
): Promise<DropdownOptionsResult> {
  let element: Element | null = null;
  if (typeof targetIndex === 'number' && targetIndex > 0) {
    element = findIndexedElement(targetIndex);
  }
  if (!element && targetSelector) {
    element = document.querySelector(targetSelector);
  }

  if (!element) {
    return {
      success: false,
      type: 'select',
      options: [],
      error: `Element not found for index: ${targetIndex} or selector: ${targetSelector}`,
    };
  }

  const tagName = element.tagName.toLowerCase();

  // 1. Native <select> element (or container wrapping a <select>)
  const selectEl =
    tagName === 'select' ? (element as HTMLSelectElement) : element.querySelector('select');
  if (selectEl) {
    const options: DropdownOptionItem[] = Array.from(selectEl.options).map((opt, idx) => ({
      text: opt.text.trim(),
      value: opt.value,
      index: idx,
      selected: opt.selected,
    }));

    return {
      success: true,
      type: 'select',
      id: selectEl.id || undefined,
      name: selectEl.name || undefined,
      options,
    };
  }

  // 2. ARIA combobox / listbox / menu
  const role = element.getAttribute('role')?.toLowerCase();
  const ariaControls = element.getAttribute('aria-controls');
  const ariaOwns = element.getAttribute('aria-owns');

  if (role === 'combobox' || role === 'listbox' || role === 'menu' || ariaControls || ariaOwns) {
    // If it's a closed combobox, try opening it and wait for React/Vue portal mount
    if (role === 'combobox' && element.getAttribute('aria-expanded') !== 'true') {
      try {
        (element as HTMLElement).focus?.();
        try {
          element.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
          );
        } catch {}
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        (element as HTMLElement).click?.();
        // Micro-wait (50-100ms) for framework dropdown/portal to mount
        await new Promise((resolve) => setTimeout(resolve, 80));
      } catch {}
    }

    let searchRoot: Element = element;
    if (ariaControls) {
      const controlledEl = document.getElementById(ariaControls);
      if (controlledEl) searchRoot = controlledEl;
    } else if (ariaOwns) {
      const ownedEl = document.getElementById(ariaOwns);
      if (ownedEl) searchRoot = ownedEl;
    }

    let items = searchRoot.querySelectorAll('[role="option"], [role="menuitem"]');
    // If empty, search document-level active popups/listboxes (common in React/Vue portals)
    if (items.length === 0) {
      // Small sleep in case portal is mounting asynchronously
      await new Promise((resolve) => setTimeout(resolve, 60));
      const portalRoot = document.querySelector(
        '[role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], [data-floating-ui-portal], .ant-select-dropdown, .el-select-dropdown, .MuiMenu-paper, [class*="select-dropdown"], [class*="dropdown-menu"]',
      );
      if (portalRoot) {
        items = portalRoot.querySelectorAll(
          '[role="option"], [role="menuitem"], [role="treeitem"], [data-radix-collection-item], [data-combobox-option], .ant-select-item-option, .el-select-dropdown__item, .MuiMenuItem-root, .v-list-item, [class*="option" i], [class*="select-item" i]',
        );
      }
    }

    const options: DropdownOptionItem[] = [];

    items.forEach((item, idx) => {
      const text = item.textContent?.trim() || '';
      if (text) {
        options.push({
          text,
          value: item.getAttribute('data-value') || item.getAttribute('value') || text,
          index: idx,
          selected:
            item.getAttribute('aria-selected') === 'true' ||
            item.getAttribute('aria-checked') === 'true' ||
            item.getAttribute('data-state') === 'checked' ||
            item.getAttribute('data-state') === 'selected' ||
            item.classList.contains('selected') ||
            item.classList.contains('is-selected') ||
            item.classList.contains('active') ||
            item.classList.contains('Mui-selected') ||
            item.classList.contains('ant-select-item-option-selected') ||
            /(selected|active|checked)/i.test(
              typeof item.className === 'string' ? item.className : '',
            ),
        });
      }
    });

    if (options.length > 0) {
      return {
        success: true,
        type: 'aria',
        id: element.id || undefined,
        name: element.getAttribute('aria-label') || undefined,
        options,
      };
    }
  }

  // 3. Custom dropdowns (Semantic UI, Bootstrap, Tailwind, etc.)
  const customItems = element.querySelectorAll('.item, .option, li[data-value], [data-value]');
  if (customItems.length > 0) {
    const options: DropdownOptionItem[] = [];
    customItems.forEach((item, idx) => {
      const text = item.textContent?.trim() || '';
      if (text) {
        options.push({
          text,
          value: item.getAttribute('data-value') || text,
          index: idx,
          selected:
            item.getAttribute('aria-selected') === 'true' ||
            item.getAttribute('aria-checked') === 'true' ||
            item.getAttribute('data-state') === 'checked' ||
            item.getAttribute('data-state') === 'selected' ||
            item.classList.contains('selected') ||
            item.classList.contains('is-selected') ||
            item.classList.contains('active') ||
            /(selected|active|checked)/i.test(
              typeof item.className === 'string' ? item.className : '',
            ),
        });
      }
    });

    if (options.length > 0) {
      return {
        success: true,
        type: 'custom',
        id: element.id || undefined,
        name: element.getAttribute('aria-label') || undefined,
        options,
      };
    }
  }

  return {
    success: false,
    type: 'select',
    options: [],
    error: `Target element <${tagName}> is neither a native select nor an ARIA/custom dropdown menu`,
  };
}
