/**
 * Screenshot helper content script
 * Handles page preparation, scrolling, element positioning, and GoFullPage-grade
 * StyleStack fixed/sticky element management, warmup, and dynamic height tracking.
 */

// NOTE: no init-guard here. The isolated world persists across extension
// reloads while the old listener's runtime binding dies with the old context;
// skipping re-registration leaves only a dead listener that never answers
// chrome.tabs.sendMessage, hanging the tool forever. Always register fresh -
// the alive listener resolves the message channel.

// StyleStack: safely record and restore inline styles, classes, and injected stylesheets
const StyleStack = {
  _stack: [],
  _fixedStack: [],
  _styleSheets: [],
  _sliceStyleSheets: [],

  // Record beforeCss and apply inline styles with !important
  add(el, styles) {
    if (!el || !el.style) return;
    const beforeCss = el.style.cssText;
    for (const [prop, val] of Object.entries(styles)) {
      const kebab = prop.replace(/([a-zA-Z])(?=[A-Z])/g, '$1-').toLowerCase();
      try {
        el.style.setProperty(kebab, val, 'important');
      } catch {
        el.style[prop] = val;
      }
    }
    this._stack.push({ el, before: beforeCss });
  },

  addFixed(el, styles, options = {}) {
    if (!el || !el.style) return;
    const beforeCss = el.style.cssText;
    const hadOriginalId =
      typeof el.hasAttribute === 'function' ? el.hasAttribute('id') : Boolean(el.id);
    const originalId = hadOriginalId ? el.getAttribute('id') : null;
    const addedId = options.addedId || false;
    for (const [prop, val] of Object.entries(styles)) {
      const kebab = prop.replace(/([a-zA-Z])(?=[A-Z])/g, '$1-').toLowerCase();
      try {
        el.style.setProperty(kebab, val, 'important');
      } catch {
        el.style[prop] = val;
      }
    }
    this._fixedStack.push({ el, before: beforeCss, addedId, hadOriginalId, originalId });
  },

  addStyleSheet(css) {
    const styleEl = document.createElement('style');
    styleEl.type = 'text/css';
    styleEl.appendChild(document.createTextNode(css));
    const parent = document.head || document.documentElement || document.body;
    if (parent) {
      parent.appendChild(styleEl);
      this._styleSheets.push(styleEl);
    }
  },

  addSliceStyleSheet(css) {
    const styleEl = document.createElement('style');
    styleEl.type = 'text/css';
    styleEl.appendChild(document.createTextNode(css));
    const parent = document.head || document.documentElement || document.body;
    if (parent) {
      parent.appendChild(styleEl);
      this._sliceStyleSheets.push(styleEl);
    }
  },

  // Pop all fixed slice modifications (restores elements before applying next slice rules)
  popAllFixed() {
    while (this._fixedStack.length > 0) {
      const item = this._fixedStack.pop();
      if (item && item.el) {
        item.el.style.cssText = item.before;
        if (item.addedId) {
          if (item.hadOriginalId && item.originalId !== null) {
            item.el.setAttribute('id', item.originalId);
          } else {
            item.el.removeAttribute('id');
          }
        }
      }
    }
    while (this._sliceStyleSheets.length > 0) {
      const sheet = this._sliceStyleSheets.pop();
      if (sheet && sheet.parentNode) {
        sheet.parentNode.removeChild(sheet);
      }
    }
  },

  // 100% complete rollback of all DOM style mutations and added stylesheets
  popAll() {
    this.popAllFixed();
    while (this._stack.length > 0) {
      const item = this._stack.pop();
      if (item && item.el) {
        item.el.style.cssText = item.before;
      }
    }
    while (this._styleSheets.length > 0) {
      const sheet = this._styleSheets.pop();
      if (sheet && sheet.parentNode) {
        sheet.parentNode.removeChild(sheet);
      }
    }
  },
};

// Expose on window for debugging / test inspection
if (typeof window !== 'undefined') {
  window.__mcpStyleStack = StyleStack;
}

let originalOverflowStyle = '';
let hiddenFixedElements = [];

/**
 * Categorize fixed, sticky, header, and floating footer elements
 */
function categorizeFixedAndStickyElements() {
  const headers = [];
  const footers = [];
  const stickies = [];
  const otherFixed = [];

  const viewportHeight = window.innerHeight;
  const viewportWidth = window.innerWidth;

  document.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'LINK') return;
    if (el.id && (el.id.startsWith('chrome-mcp-') || el.id.startsWith('__mcp_'))) return;

    if (el.offsetWidth <= 1 && el.offsetHeight <= 1) return;

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    if (style.position === 'sticky') {
      stickies.push(el);
    } else if (style.position === 'fixed') {
      const rect = el.getBoundingClientRect();
      // Skip elements completely outside viewport
      if (
        rect.bottom <= 0 ||
        rect.right <= 0 ||
        rect.top >= viewportHeight ||
        rect.left >= viewportWidth
      ) {
        return;
      }
      // Fixed header: docked at top
      if (rect.top <= 45 && rect.height < viewportHeight * 0.5) {
        headers.push(el);
      }
      // Fixed bottom banner / floating footer: docked at bottom
      else if (rect.bottom >= viewportHeight - 45 && rect.height < viewportHeight * 0.5) {
        footers.push(el);
      } else {
        otherFixed.push(el);
      }
    }
  });

  return { headers, footers, stickies, otherFixed };
}

/**
 * Configure DOM visibility for the current capture slice.
 * - Screen 1 (stepIndex 0): Headers visible, bottom banners hidden (unless also last step).
 * - Screen 2+ (stepIndex > 0): Headers hidden (visibility: hidden) to prevent duplicate banners.
 * - Stickies: converted to relative to prevent repetitive sticking across slices.
 * - Last slice (isLastStep true): Bottom banners visible once at the bottom of the page.
 */
function prepareSlice(stepIndex, isLastStep) {
  StyleStack.popAllFixed();

  const { headers, footers, stickies, otherFixed } = categorizeFixedAndStickyElements();

  if (stepIndex > 0) {
    // Screen 2+: Hide fixed headers to prevent duplication across slices
    headers.forEach((el) => {
      StyleStack.addFixed(el, { visibility: 'hidden', overflow: 'hidden' });
    });

    // Stickies: convert to relative coordinates and inject stylesheet rule with !important
    stickies.forEach((el, idx) => {
      let addedId = false;
      if (!el.id) {
        el.id = `__mcp_sticky_${Date.now()}_${idx}`;
        addedId = true;
      }
      StyleStack.addFixed(
        el,
        {
          position: 'relative',
          top: 'auto',
          left: 'auto',
          right: 'auto',
          bottom: 'auto',
        },
        { addedId },
      );
    });
    if (stickies.length > 0 && typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      const stickySelectors = stickies.map((el) => `#${CSS.escape(el.id)}`).join(', ');
      StyleStack.addSliceStyleSheet(
        `${stickySelectors} { position: relative !important; left: auto !important; right: auto !important; top: auto !important; bottom: auto !important; }`,
      );
    }

    // Other fixed elements (floating buttons, widgets): hide on subsequent slices
    otherFixed.forEach((el) => {
      StyleStack.addFixed(el, { visibility: 'hidden' });
    });
  }

  if (!isLastStep) {
    // Prior to the last slice: hide floating bottom banners so they only appear at the bottom
    footers.forEach((el) => {
      StyleStack.addFixed(el, { visibility: 'hidden', overflow: 'hidden' });
    });
  }
}

/**
 * Backward compatibility helpers
 */
function hideFixedElements() {
  prepareSlice(1, false);
}

function showFixedElements() {
  StyleStack.popAllFixed();
}

/**
 * Measure full page dimensions accurately
 */
function getDocumentDimensions() {
  const body = document.body;
  const html = document.documentElement;
  const totalWidth = Math.max(
    body ? body.scrollWidth : 0,
    body ? body.offsetWidth : 0,
    html ? html.clientWidth : 0,
    html ? html.scrollWidth : 0,
    html ? html.offsetWidth : 0,
  );
  const totalHeight = Math.max(
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
    html ? html.clientHeight : 0,
    html ? html.scrollHeight : 0,
    html ? html.offsetHeight : 0,
  );
  return {
    totalWidth: totalWidth || window.innerWidth,
    totalHeight: totalHeight || window.innerHeight,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio || 1,
    currentScrollX: window.scrollX,
    currentScrollY: window.scrollY,
  };
}

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  // Respond to ping message
  if (
    request.action === 'chrome_screenshot_ping' ||
    String(request.action || '').startsWith('mcp_ping_')
  ) {
    sendResponse({ status: 'pong' });
    return false; // Synchronous response
  }

  // Prepare page for capture
  else if (request.action === 'preparePageForCapture') {
    originalOverflowStyle = document.documentElement.style.overflow;
    // GoFullPage industrial scrollbar hiding via non-destructive CSS stylesheet
    // Avoids setting overflow: hidden on html/body which could freeze programmatic window.scrollTo
    StyleStack.addStyleSheet(
      'html::-webkit-scrollbar, body::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }\n' +
        'html, body { scrollbar-width: none !important; -ms-overflow-style: none !important; }',
    );
    if (request.options?.fullPage) {
      prepareSlice(0, false);
    }
    // Give styles a moment to apply
    setTimeout(() => {
      sendResponse({ success: true });
    }, 50);
    return true; // Async response
  }

  // Prepare specific slice for full-page capture
  else if (request.action === 'prepareSlice') {
    prepareSlice(request.stepIndex || 0, Boolean(request.isLastStep));
    setTimeout(() => {
      sendResponse({ success: true });
    }, 30);
    return true; // Async response
  }

  // Pop slice-specific fixed styles between slices
  else if (request.action === 'popSliceFixed') {
    StyleStack.popAllFixed();
    sendResponse({ success: true });
    return false;
  }

  // Page warmup: rapid scroll down and back up to trigger IntersectionObserver, lazy loading, and skeletons
  else if (request.action === 'warmupPage') {
    const dims = getDocumentDimensions();
    const maxScrollY = Math.max(0, dims.totalHeight - window.innerHeight);

    if (maxScrollY > 0) {
      window.scrollTo({ left: 0, top: maxScrollY, behavior: 'instant' });
    }

    setTimeout(() => {
      // GoFullPage standard: scroll cleanly back to (0, 0) ready for slice 0
      window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
      setTimeout(() => {
        const settledDims = getDocumentDimensions();
        sendResponse({
          success: true,
          totalWidth: settledDims.totalWidth,
          totalHeight: settledDims.totalHeight,
        });
      }, 80);
    }, 80);
    return true; // Async response
  }

  // Get page details
  else if (request.action === 'getPageDetails') {
    sendResponse(getDocumentDimensions());
    return false;
  }

  // Get element details
  else if (request.action === 'getElementDetails') {
    const element = document.querySelector(request.selector);
    if (element) {
      element.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' });
      setTimeout(() => {
        const rect = element.getBoundingClientRect();
        sendResponse({
          rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
          devicePixelRatio: window.devicePixelRatio || 1,
        });
      }, 200);
      return true;
    } else {
      sendResponse({ error: `Element with selector "${request.selector}" not found.` });
      return false;
    }
  }

  // Scroll page with dynamic height change detection
  else if (request.action === 'scrollPage') {
    window.scrollTo({ left: request.x, top: request.y, behavior: 'instant' });
    setTimeout(() => {
      const dims = getDocumentDimensions();
      sendResponse({
        success: true,
        newScrollX: window.scrollX,
        newScrollY: window.scrollY,
        totalHeight: dims.totalHeight,
        totalWidth: dims.totalWidth,
      });
    }, request.scrollDelay || 300);
    return true;
  }

  // Reset page after capture: 100% restore original styles and DOM via StyleStack.popAll()
  else if (request.action === 'resetPageAfterCapture') {
    document.documentElement.style.overflow = originalOverflowStyle;
    StyleStack.popAll();
    if (typeof request.scrollX !== 'undefined' && typeof request.scrollY !== 'undefined') {
      window.scrollTo({ left: request.scrollX, top: request.scrollY, behavior: 'instant' });
    }
    sendResponse({ success: true });
    return false;
  }

  return false;
});
