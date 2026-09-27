import { tabFaviconManager } from './tab-favicon';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { executeInPage } from './in-page-engine';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { setAgentCursorNote } from './agent-cursor';

/**
 * Keys that the content-script simulator understands as a single named key.
 * Kept in sync with inject-scripts/keyboard-helper.js SPECIAL_KEY_MAP.
 */
const NAMED_KEYS = new Set([
  'enter',
  'return',
  'tab',
  'esc',
  'escape',
  'space',
  'backspace',
  'delete',
  'del',
  'up',
  'arrowup',
  'down',
  'arrowdown',
  'left',
  'arrowleft',
  'right',
  'arrowright',
  'home',
  'end',
  'pageup',
  'pagedown',
  'insert',
  // Two-word spellings ("Page Down", "Arrow Up") are keys, not prose.
  'page up',
  'page down',
  'arrow up',
  'arrow down',
  'arrow left',
  'arrow right',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
]);

/** Normalize a token for key-name lookup: lowercase and collapse inner whitespace. */
function keyToken(token: string): string {
  return token.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * True when `keys` is prose meant to be typed (e.g. "AGENT-OK", "Hello World")
 * rather than a key or chord. The content-script parser splits on ',' / '+' and
 * rejects any multi-character token, so such input used to fail outright with
 * "Invalid key string or combination" even though the tool schema advertises it.
 */
export function isLiteralText(keys: string): boolean {
  const raw = keys.trim();
  if (!raw || raw.length <= 1) return false;
  if (raw.includes(',') || raw.includes('+')) return false;
  // Space-separated key sequences ("ArrowDown ArrowDown Enter") are keys, not prose.
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => NAMED_KEYS.has(keyToken(t)))) return false;
  // "Page Down" is a single key written with a space, not two tokens of prose.
  if (NAMED_KEYS.has(keyToken(raw))) return false;
  return !NAMED_KEYS.has(raw.toLowerCase());
}

/** Two-word key spellings mapped to the single token the helper understands. */
const TWO_WORD_KEYS: Record<string, string> = {
  'page up': 'PageUp',
  'page down': 'PageDown',
  'arrow up': 'ArrowUp',
  'arrow down': 'ArrowDown',
  'arrow left': 'ArrowLeft',
  'arrow right': 'ArrowRight',
};

/**
 * The content-script simulator separates key combinations with ','; accept the
 * space-separated form too so "ArrowDown ArrowDown Enter" works like it does
 * on chrome_computer, and collapse two-word spellings such as "Page Down".
 */
export function normalizeKeySequence(keys: string): string {
  const raw = keys.trim();
  if (raw.includes(',') || raw.includes('+')) return raw;
  const whole = TWO_WORD_KEYS[keyToken(raw)];
  if (whole) return whole;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => NAMED_KEYS.has(keyToken(t)) || t.includes('+'))) {
    return tokens.map((t) => TWO_WORD_KEYS[keyToken(t)] ?? t).join(',');
  }
  return raw;
}

interface KeyboardToolParams {
  keys: string; // Required: string representing keys or key combinations to simulate (e.g., "Enter", "Ctrl+C")
  index?: number; // Optional: 1-based element index from chrome_read_dom to focus before typing
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  delay?: number; // Optional: delay between keystrokes in milliseconds
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  frameId?: number; // target frame id for iframe support
  sessionId?: string; // session affinity identifier
  sessionContext?: string;
}

/**
 * Tool for simulating keyboard input on web pages
 */
class KeyboardTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.KEYBOARD;

  /**
   * Execute keyboard operation
   */
  async execute(args: KeyboardToolParams): Promise<ToolResult> {
    const { keys, selector, selectorType = 'css', delay = TIMEOUTS.KEYBOARD_DELAY } = args;

    console.log(`Starting keyboard operation with options:`, args);

    if (!keys) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
      );
    }

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      tabFaviconManager.markTabActive(tab.id);

      // If 1-based index is specified, scroll element into view and focus before typing.
      // Uses the dedicated focus entrypoint: the old path routed through
      // inPageInteractIndex(index,'click'), which fired the target's click handlers
      // and left focus on document.activeElement, so keys went to the wrong element.
      if (typeof args.index === 'number' && args.index > 0) {
        const focusRes = await executeInPage({ tabId: tab.id }, 'inPageFocusIndex', [args.index]);
        let focusTarget = focusRes?.[0]?.result;
        if (!focusTarget?.success) {
          const frameResults = await executeInPage(
            { tabId: tab.id, allFrames: true },
            'inPageFocusIndex',
            [args.index],
          );
          const match = frameResults.find((r) => r.result?.success);
          if (match) {
            focusTarget = match.result;
            if (match.frameId !== undefined) {
              args.frameId = match.frameId;
            }
          }
        }
        if (!focusTarget?.success) {
          return createErrorResponse(
            focusTarget?.error ||
              `Failed to resolve index [${args.index}] for ${resolveToolName('keyboard')}. Call ${resolveToolName('read_dom')} to refresh the index tree.`,
          );
        }
        // The element may exist yet still refuse focus (disabled, inert, or an
        // SVG node). Reporting success then would type into whatever currently
        // holds focus — potentially the address bar or an unrelated search box.
        if (focusTarget.focused === false) {
          return createErrorResponse(
            `Index [${args.index}] resolved to <${focusTarget.tagName}> but could not take focus; refusing to type into an unknown element. Focus it explicitly (${resolveToolName('interact_index')}) or pass a selector.`,
          );
        }
      }

      // Clipboard chords (Ctrl+C / Ctrl+V) require the real system clipboard; synthetic
      // KeyboardEvents cannot trigger browser edit commands, so route them natively.
      const clipboardChord = /^(?:ctrl|control|meta|cmd)\+([cvxa])$/i.exec(String(keys).trim());
      if (clipboardChord) {
        const kind = clipboardChord[1].toLowerCase();
        try {
          await setAgentCursorNote(
            tab.id,
            kind === 'c' ? 'Copying to clipboard' : 'Pasting clipboard',
          );
          await this.injectContentScript(tab.id, ['inject-scripts/keyboard-helper.js']);
          const resp = await this.sendMessageToTab(tab.id, {
            action:
              kind === 'c'
                ? 'clipboardCopy'
                : kind === 'x'
                  ? 'clipboardCut'
                  : kind === 'a'
                    ? 'selectAll'
                    : 'clipboardPaste',
          });
          if (!resp || resp.success !== true) {
            return createErrorResponse(
              `Clipboard ${kind === 'c' ? 'copy' : 'paste'} failed: ${resp?.error || 'unknown error'}`,
            );
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message:
                    kind === 'c'
                      ? `Copied ${resp.copied} char(s) to system clipboard`
                      : `Pasted ${resp.pasted} char(s) from system clipboard`,
                  targetElement: resp.targetElement,
                  text: resp.text,
                }),
              },
            ],
            isError: false,
          };
        } catch (error) {
          return createErrorResponse(
            `Clipboard operation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Literal text (e.g. "AGENT-OK"): type it through CDP Input.insertText so the
      // page sees trusted input, instead of failing key-combination parsing.
      if (isLiteralText(keys)) {
        try {
          const typeNote = `Typing "${keys.length > 18 ? keys.slice(0, 15) + '...' : keys}"`;
          await setAgentCursorNote(tab.id, typeNote);
          await cdpSessionManager.withSession(tab.id, 'keyboard-type', async () => {
            await cdpSessionManager.sendCommand(tab.id!, 'Input.insertText', { text: keys });
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Typed ${keys.length} char(s) as literal text`,
                  method: 'cdp_insert_text',
                  isTrusted: true,
                  text: keys,
                }),
              },
            ],
            isError: false,
          };
        } catch (typeErr) {
          return createErrorResponse(
            `Failed to type literal text: ${typeErr instanceof Error ? typeErr.message : String(typeErr)}`,
          );
        }
      }

      let finalSelector = selector;
      let refForFocus: string | undefined = undefined;

      // Ensure helper is loaded for XPath or potential focus operations
      await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);

      // If selector is XPath, convert to ref then try to get CSS selector
      if (selector && selectorType === 'xpath') {
        try {
          // First convert XPath to ref
          const ensured = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
            selector,
            isXPath: true,
          });
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${ensured?.error || 'unknown error'}`,
            );
          }
          refForFocus = ensured.ref;
          // Try to resolve ref to CSS selector
          const resolved = await this.sendMessageToTab(tab.id, {
            action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
            ref: ensured.ref,
          });
          if (resolved && resolved.success && resolved.selector) {
            finalSelector = resolved.selector;
            refForFocus = undefined; // Prefer CSS selector if available
          }
          // If no CSS selector available, we'll use ref to focus below
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // If we have a ref but no CSS selector, focus the element via helper
      if (refForFocus) {
        const focusResult = await this.sendMessageToTab(tab.id, {
          action: 'focusByRef',
          ref: refForFocus,
        });
        if (focusResult && !focusResult.success) {
          return createErrorResponse(
            `Failed to focus element by ref: ${focusResult.error || 'unknown error'}`,
          );
        }
        // Clear selector so keyboard events go to the focused element
        finalSelector = undefined;
      } else if (!finalSelector) {
        // Modal Focus Trap: if a modal blocker is active, pull focus into the modal so Tab/Enter don't hit background DOM
        await executeInPage({ tabId: tab.id }, 'inPageEnsureModalFocus', []).catch(() => {});
      }

      const frameIds = typeof args.frameId === 'number' ? [args.frameId] : undefined;
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/keyboard-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIds,
      );

      // Send keyboard simulation message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
          keys: normalizeKeySequence(keys),
          selector: finalSelector,
          delay,
        },
        args.frameId,
      );

      if (!result || result.error) {
        try {
          const keyLower = keys.trim().toLowerCase();
          const isEnter = keyLower === 'enter' || keyLower === 'return';
          const isTab = keyLower === 'tab';
          const isEscape = keyLower === 'escape' || keyLower === 'esc';
          const isBackspace = keyLower === 'backspace';

          if (isEnter || isTab || isEscape || isBackspace) {
            const vk = isEnter ? 13 : isTab ? 9 : isEscape ? 27 : 8;
            const keyName = isEnter ? 'Enter' : isTab ? 'Tab' : isEscape ? 'Escape' : 'Backspace';
            await cdpSessionManager.withSession(tab.id, 'keyboard', async () => {
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: keyName,
                code: keyName,
                text: isEnter ? String.fromCharCode(13) : undefined,
                unmodifiedText: isEnter ? String.fromCharCode(13) : undefined,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
              });
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: keyName,
                code: keyName,
                windowsVirtualKeyCode: vk,
                nativeVirtualKeyCode: vk,
              });
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: 'Dispatched native CDP key ' + keyName,
                    method: 'cdp_dispatch_key_event',
                    isTrusted: true,
                    key: keyName,
                  }),
                },
              ],
              isError: false,
            };
          }
        } catch {}

        if (result?.error) {
          return createErrorResponse(result.error);
        }
        return createErrorResponse('Keyboard simulation timed out or failed to receive response');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Keyboard operation successful',
              targetElement: result.targetElement,
              results: result.results,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in keyboard operation:', error);
      return createErrorResponse(
        `Error simulating keyboard events: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const keyboardTool = new KeyboardTool();

/**
 * Dispatch OS-adaptive native SelectAll command through CDP.
 * Modeled after Browser-Harness (BH: src/browser_harness/helpers.py:221-248) and
 * JEV (jev_ultrafast/browser.py:170-180).
 */
export async function dispatchNativeSelectAll(tabId: number): Promise<void> {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
  const modifierMask = isMac ? 4 : 2; // Meta (Mac: 4) vs Ctrl (Win/Linux: 2)

  await cdpSessionManager.withSession(tabId, 'keyboard-select-all', async () => {
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: modifierMask,
      commands: ['SelectAll'],
    });
    await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      modifiers: modifierMask,
    });
  });
}
