// keyboard-helper.js
// This script is injected into the page to handle keyboard event simulation

if (window.__KEYBOARD_HELPER_INITIALIZED__) {
  // Already initialized, skip
} else {
  window.__KEYBOARD_HELPER_INITIALIZED__ = true;

  // A map for special keys to their KeyboardEvent properties
  // Key names should be lowercase for matching
  const SPECIAL_KEY_MAP = {
    enter: { key: 'Enter', code: 'Enter', keyCode: 13 },
    tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
    esc: { key: 'Escape', code: 'Escape', keyCode: 27 },
    escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
    del: { key: 'Delete', code: 'Delete', keyCode: 46 },
    up: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    down: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    left: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    home: { key: 'Home', code: 'Home', keyCode: 36 },
    end: { key: 'End', code: 'End', keyCode: 35 },
    pageup: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
    pagedown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
    insert: { key: 'Insert', code: 'Insert', keyCode: 45 },
    '+': { key: '+', code: 'Equal', keyCode: 187 },
    plus: { key: '+', code: 'Equal', keyCode: 187 },
    ',': { key: ',', code: 'Comma', keyCode: 188 },
    comma: { key: ',', code: 'Comma', keyCode: 188 },
    // Function keys
    ...Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [
        `f${i + 1}`,
        { key: `F${i + 1}`, code: `F${i + 1}`, keyCode: 112 + i },
      ]),
    ),
  };

  const MODIFIER_KEYS = {
    ctrl: 'ctrlKey',
    control: 'ctrlKey',
    alt: 'altKey',
    shift: 'shiftKey',
    meta: 'metaKey',
    command: 'metaKey',
    cmd: 'metaKey',
  };

  const SHIFTED_DIGITS = ')!@#$%^&*(';

  /**
   * Parses a key string (e.g., "Ctrl+Shift+A", "Enter") into a main key and modifiers.
   * @param {string} keyString - String representation of a single key press (can include modifiers).
   * @returns { {key: string, code: string, keyCode: number, charCode?: number, modifiers: {ctrlKey:boolean, altKey:boolean, shiftKey:boolean, metaKey:boolean}} | null }
   *          Returns null if the keyString is invalid or represents only modifiers.
   */
  function parseSingleKeyCombination(keyString) {
    const rawTrimmed = keyString.trim();
    const modifiers = {
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
    };

    if (rawTrimmed === '+') {
      return { ...SPECIAL_KEY_MAP['+'], modifiers };
    }
    if (rawTrimmed === ',') {
      return { ...SPECIAL_KEY_MAP[','], modifiers };
    }

    let mainKeyPart = null;
    if (rawTrimmed.endsWith('++')) {
      const modPrefix = rawTrimmed.slice(0, -2);
      const modParts = modPrefix
        .split('+')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      let allMods = true;
      for (const m of modParts) {
        if (MODIFIER_KEYS[m]) {
          modifiers[MODIFIER_KEYS[m]] = true;
        } else {
          allMods = false;
          break;
        }
      }
      if (allMods && modParts.length > 0) {
        mainKeyPart = '+';
      }
    }

    let parts = [];
    if (mainKeyPart === null) {
      parts = rawTrimmed.split('+').map((part) => part.trim().toLowerCase());
      for (const part of parts) {
        if (MODIFIER_KEYS[part]) {
          modifiers[MODIFIER_KEYS[part]] = true;
        } else if (mainKeyPart === null) {
          // First non-modifier is the main key
          mainKeyPart = part;
        } else {
          // Invalid format: multiple main keys in a single combination (e.g., "Ctrl+A+B")
          console.error(`Invalid key combination string: ${keyString}. Multiple main keys found.`);
          return null;
        }
      }
    }

    if (!mainKeyPart) {
      // This case could happen if the keyString is something like "Ctrl+" or just "Ctrl"
      // If the intent was to press JUST 'Control', the input should be 'Control' not 'Control+'
      // Let's check if mainKeyPart is actually a modifier name used as a main key
      if (parts.length === 1 && MODIFIER_KEYS[parts[0]]) {
        mainKeyPart = parts[0]; // e.g. user wants to press "Control" key itself
        // For "Control" key itself, key: "Control", code: "ControlLeft" (or Right)
        if (mainKeyPart === 'ctrl' || mainKeyPart === 'control')
          return { key: 'Control', code: 'ControlLeft', keyCode: 17, modifiers };
        if (mainKeyPart === 'alt') return { key: 'Alt', code: 'AltLeft', keyCode: 18, modifiers };
        if (mainKeyPart === 'shift')
          return { key: 'Shift', code: 'ShiftLeft', keyCode: 16, modifiers };
        if (mainKeyPart === 'meta' || mainKeyPart === 'command' || mainKeyPart === 'cmd')
          return { key: 'Meta', code: 'MetaLeft', keyCode: 91, modifiers };
      } else {
        console.error(`Invalid key combination string: ${keyString}. No main key specified.`);
        return null;
      }
    }

    const specialKey = SPECIAL_KEY_MAP[mainKeyPart];
    if (specialKey) {
      return { ...specialKey, modifiers };
    }

    // For single characters or other unmapped keys
    if (mainKeyPart.length === 1) {
      const isLetter = /^[a-z]$/i.test(mainKeyPart);
      const isDigit = /^[0-9]$/.test(mainKeyPart);
      const charCode = mainKeyPart.charCodeAt(0);
      let keyChar = mainKeyPart;
      if (modifiers.shiftKey) {
        if (isLetter) keyChar = mainKeyPart.toUpperCase();
        else if (isDigit) keyChar = SHIFTED_DIGITS[Number(mainKeyPart)];
        else return null; // Shifted punctuation requires a physical layout.
      }

      return {
        key: keyChar,
        code: isLetter ? `Key${mainKeyPart.toUpperCase()}` : isDigit ? `Digit${mainKeyPart}` : '',
        keyCode: charCode,
        charCode: keyChar.charCodeAt(0),
        modifiers,
      };
    }

    console.error(`Unknown key: ${mainKeyPart} in string "${keyString}"`);
    return null; // Or handle as an error
  }

  /**
   * Simulates a single key press (keydown, (keypress), keyup) for a parsed key.
   * @param { {key: string, code: string, keyCode: number, charCode?: number, modifiers: object} } parsedKeyInfo
   * @param {Element} element - Target element.
   * @returns {{success: boolean, error?: string}}
   */
  function dispatchKeyEvents(parsedKeyInfo, element) {
    if (!parsedKeyInfo) return { success: false, error: 'Invalid key info provided for dispatch.' };

    const { key, code, keyCode, charCode, modifiers } = parsedKeyInfo;

    const eventOptions = {
      key: key,
      code: code,
      bubbles: true,
      cancelable: true,
      composed: true, // Important for shadow DOM
      view:
        typeof window !== 'undefined' &&
        window &&
        typeof window.Window === 'function' &&
        window instanceof window.Window
          ? window
          : undefined,
      ...modifiers, // ctrlKey, altKey, shiftKey, metaKey
      // keyCode/which are deprecated but often set for compatibility
      keyCode: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
      which: keyCode || (key.length === 1 ? key.charCodeAt(0) : 0),
    };

    try {
      const kdRes = element.dispatchEvent(new KeyboardEvent('keydown', eventOptions));

      // keypress is deprecated, but simulate if it's a character key or Enter
      // Only dispatch if keydown was not cancelled and it's a character producing key
      if (kdRes && (key.length === 1 || key === 'Enter' || key === ' ')) {
        const keypressOptions = { ...eventOptions };
        if (charCode) keypressOptions.charCode = charCode;
        element.dispatchEvent(new KeyboardEvent('keypress', keypressOptions));
      }

      element.dispatchEvent(new KeyboardEvent('keyup', eventOptions));
      return { success: true };
    } catch (error) {
      console.error(`Error dispatching key events for "${key}":`, error);
      return {
        success: false,
        error: `Error dispatching key events for "${key}": ${error.message}`,
      };
    }
  }

  /**
   * Simulate keyboard events on an element or document
   * @param {string} keysSequenceString - String representation of key(s) (e.g., "Enter", "Ctrl+C, A, B")
   * @param {Element} targetElement - Element to dispatch events on (optional)
   * @param {number} delay - Delay between key sequences in milliseconds (optional)
   * @returns {Promise<Object>} - Result of the keyboard operation
   */
  function splitKeySequence(str) {
    const trimmed = (str || '').trim();
    if (!trimmed) return [];
    if (trimmed === ',') return [','];

    const results = [];
    let current = '';

    for (let i = 0; i < trimmed.length; i++) {
      const char = trimmed[i];
      if (char === ',') {
        const trimmedCurrent = current.trim();
        const lastNonSpace = trimmedCurrent.slice(-1);
        if (lastNonSpace === '+' && !trimmedCurrent.endsWith('++')) {
          current += char;
        } else if (!trimmedCurrent) {
          results.push(',');
          current = '';
        } else {
          results.push(trimmedCurrent);
          current = '';
        }
      } else {
        current += char;
      }
    }

    if (current.trim()) {
      results.push(current.trim());
    }

    return results.filter(Boolean);
  }

  async function simulateKeyboard(keysSequenceString, targetElement = null, delay = 0) {
    try {
      let active = document.activeElement;
      const seen = new Set();
      while (
        active &&
        !seen.has(active) &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)
      ) {
        seen.add(active);
        let root = active.shadowRoot;
        try {
          root = chrome.dom?.openOrClosedShadowRoot?.(active) || root;
        } catch {}
        const inner = root?.activeElement;
        if (!inner || inner === active) break;
        active = inner;
      }
      const element = targetElement || active || document.body;

      if (element !== active && typeof element.focus === 'function') {
        element.focus();
        await new Promise((resolve) => setTimeout(resolve, 50)); // Small delay for focus
      }

      const keyCombinations = splitKeySequence(keysSequenceString);
      const parsedCombinations = keyCombinations.map((comboString) => ({
        comboString,
        parsedKeyInfo: parseSingleKeyCombination(comboString),
      }));
      const invalidCombination = parsedCombinations.find((item) => !item.parsedKeyInfo);
      const targetInfo = {
        tagName: element.tagName,
        id: element.id,
        className: element.className,
        type: element.type, // if applicable e.g. for input
      };

      if (invalidCombination) {
        return {
          success: false,
          status: 'blocked',
          retry: true,
          dispatched: false,
          error: `Invalid key string or combination: ${invalidCombination.comboString}`,
          message: 'Keyboard sequence rejected before dispatch',
          results: parsedCombinations.map(({ comboString, parsedKeyInfo }) => ({
            keyCombination: comboString,
            success: false,
            dispatched: false,
            error: parsedKeyInfo
              ? `Not dispatched because sequence contains invalid key: ${invalidCombination.comboString}`
              : `Invalid key string or combination: ${comboString}`,
          })),
          targetElement: targetInfo,
        };
      }

      const operationResults = [];

      for (let i = 0; i < parsedCombinations.length; i++) {
        const { comboString, parsedKeyInfo } = parsedCombinations[i];
        const dispatchResult = dispatchKeyEvents(parsedKeyInfo, element);
        operationResults.push({
          keyCombination: comboString,
          ...dispatchResult,
        });

        if (dispatchResult.error) {
          // Optionally, decide if sequence should stop on first error
          // For now, we continue but log the error in results
          console.warn(
            `Failed to simulate key combination "${comboString}": ${dispatchResult.error}`,
          );
        }

        if (delay > 0 && i < parsedCombinations.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      // Check if all individual operations were successful
      const overallSuccess = operationResults.every((r) => r.success);

      return {
        success: overallSuccess,
        dispatched: true,
        message: overallSuccess
          ? `Keyboard events simulated successfully: ${keysSequenceString}`
          : `Some keyboard events failed for: ${keysSequenceString}`,
        results: operationResults, // Detailed results for each key combination
        targetElement: targetInfo,
      };
    } catch (error) {
      console.error('Error in simulateKeyboard:', error);
      return {
        success: false,
        error: `Error simulating keyboard events: ${error.message}`,
        results: [],
      };
    }
  }

  // Listener for messages from the extension
  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (request.action === 'simulateKeyboard') {
      let targetEl = null;
      if (request.selector) {
        targetEl = document.querySelector(request.selector);
        if (!targetEl) {
          sendResponse({
            success: false,
            error: `Element with selector "${request.selector}" not found`,
            results: [],
          });
          return true; // Keep channel open for async response
        }
      }

      simulateKeyboard(request.keys, targetEl, request.delay)
        .then(sendResponse)
        .catch((error) => {
          // This catch is for unexpected errors in simulateKeyboard promise chain itself
          console.error('Unexpected error in simulateKeyboard promise chain:', error);
          sendResponse({
            success: false,
            error: `Unexpected error during keyboard simulation: ${error.message}`,
            results: [],
          });
        });
      return true; // Indicates async response is expected
    } else if (
      request.action === 'chrome_keyboard_ping' ||
      String(request.action || '').startsWith('mcp_ping_')
    ) {
      sendResponse({ status: 'pong', initialized: true }); // Respond that it's initialized
      return false; // Synchronous response
    }
    // Not our message, or no async response needed
    return false;
  });
}
