import { tabFaviconManager } from './tab-favicon';
import { createErrorResponse, type ToolCallContext, ToolResult } from '@/common/tool-handler';
import { throwIfAborted, waitWithAbort } from '@/utils/action-abort';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { executeInPage } from './in-page-engine';
import { resolveTargetLocation } from './unified-locator';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { formatAgentCursorAction, setAgentCursorNote } from './agent-cursor';
import { withActionReceipt, attachActionReceipt } from '@/utils/action-receipt';
import {
  DialogOpenedError,
  createDialogInterruptResponse,
  isCdpOutcomeUncertainError,
  raceCdp,
} from '@/utils/race-cdp';
import {
  createInteractionErrorResponse,
  makeInteractionOutcome,
} from '@/utils/interaction-outcome';
import { logUnexpectedToolError } from '@/utils/restricted-url';

function createUnknownOutcomeResponse(error: unknown, acknowledgedEvents?: number): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: false,
          status: 'unknown',
          retry: false,
          requestDispatched: true,
          ...(acknowledgedEvents !== undefined
            ? { dispatched: acknowledgedEvents > 0, acknowledgedEvents }
            : {}),
          interaction: makeInteractionOutcome(
            'unknown',
            'not_requested',
            'keyboard_dispatch_unknown',
            acknowledgedEvents && acknowledgedEvents > 0 ? acknowledgedEvents : undefined,
          ),
          error: `Keyboard CDP outcome unknown: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      },
    ],
    isError: true,
  };
}

function blockedKeyboardError(message: string, reason: string): ToolResult {
  return createInteractionErrorResponse(
    message,
    makeInteractionOutcome('not_dispatched', 'not_requested', reason, 0),
    { status: 'blocked', requestDispatched: false },
  );
}

function withKeyboardInteraction(result: ToolResult): ToolResult {
  const block = result.content?.at(-1);
  if (block?.type !== 'text') return result;
  let payload: any;
  try {
    payload = JSON.parse(block.text);
  } catch {
    return result;
  }
  if (!payload || typeof payload !== 'object' || payload.interaction) return result;

  const acknowledged = Number(payload.acknowledgedEvents || 0);
  const execution: 'not_dispatched' | 'dispatched' | 'unknown' =
    payload.status === 'unknown'
      ? 'unknown'
      : !result.isError && payload.success === true
        ? 'dispatched'
        : payload.requestDispatched === true ||
            payload.dispatched === true ||
            acknowledged > 0 ||
            payload.status === 'timeout'
          ? 'unknown'
          : 'not_dispatched';
  block.text = JSON.stringify({
    ...payload,
    interaction: makeInteractionOutcome(
      execution,
      'not_requested',
      keyboardExecutionReason(payload, execution),
      execution === 'not_dispatched'
        ? 0
        : acknowledged > 0
          ? acknowledged
          : execution === 'dispatched'
            ? 1
            : undefined,
    ),
  });
  return result;
}

function keyboardExecutionReason(
  payload: any,
  execution: 'not_dispatched' | 'dispatched' | 'unknown',
) {
  if (typeof payload.reason === 'string') return payload.reason;
  if (execution === 'unknown') return 'keyboard_dispatch_unknown';
  if (execution === 'not_dispatched' && typeof payload.error === 'string') {
    return 'keyboard_preparation_failed';
  }
  return undefined;
}

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
  'control',
  'ctrl',
  'alt',
  'shift',
  'meta',
  'cmd',
  'command',
  '+',
  'plus',
  ',',
  'comma',
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

interface CdpKeyDef {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

const CDP_KEY_DEFINITIONS: Record<string, CdpKeyDef> = {
  enter: {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  },
  return: {
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    text: '\r',
    unmodifiedText: '\r',
  },
  tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  del: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  insert: { key: 'Insert', code: 'Insert', windowsVirtualKeyCode: 45 },
  '+': { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+', unmodifiedText: '+' },
  plus: { key: '+', code: 'Equal', windowsVirtualKeyCode: 187, text: '+', unmodifiedText: '+' },
  ',': { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: ',', unmodifiedText: ',' },
  comma: { key: ',', code: 'Comma', windowsVirtualKeyCode: 188, text: ',', unmodifiedText: ',' },
  ctrl: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  command: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  cmd: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  'arrow up': { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  'arrow down': { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  'arrow left': { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  'arrow right': { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  end: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  'page up': { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
  'page down': { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 },
};

for (let i = 1; i <= 12; i++) {
  CDP_KEY_DEFINITIONS[`f${i}`] = {
    key: `F${i}`,
    code: `F${i}`,
    windowsVirtualKeyCode: 111 + i,
  };
}

const SHIFTED_DIGITS = ')!@#$%^&*(';

function characterKeyDefinition(token: string, modifiers: number): CdpKeyDef | null {
  const chars = Array.from(token);
  const codePoint = chars[0]?.codePointAt(0) ?? 0;
  if (chars.length !== 1 || codePoint < 0x20 || codePoint === 0x7f) return null;

  // Shortcut modifiers must not carry text, or the browser inserts the shortcut letter.
  const commandModifiers = (modifiers & (1 | 2 | 4)) !== 0;
  const shifted = (modifiers & 8) !== 0;
  if (/^[a-z]$/i.test(token)) {
    const upper = token.toUpperCase();
    const key = shifted ? upper : token;
    const text = commandModifiers ? undefined : key;
    return {
      key,
      code: `Key${upper}`,
      windowsVirtualKeyCode: upper.charCodeAt(0),
      text,
      unmodifiedText: shifted ? upper : token,
    };
  }

  if (/^[0-9]$/.test(token)) {
    const key = shifted ? SHIFTED_DIGITS[Number(token)] : token;
    const text = commandModifiers ? undefined : key;
    return {
      key,
      code: `Digit${token}`,
      windowsVirtualKeyCode: 48 + Number(token),
      text,
      unmodifiedText: key,
    };
  }

  // No keyboard-layout guess for punctuation/Unicode: text-only dispatch is safe with code/VK 0.
  if (shifted) return null;
  const text = commandModifiers ? undefined : token;
  return {
    key: token,
    code: '',
    windowsVirtualKeyCode: 0,
    text,
    unmodifiedText: token,
  };
}

function cdpKeyDefinition(token: string, modifiers: number): CdpKeyDef | undefined {
  return CDP_KEY_DEFINITIONS[keyToken(token)] ?? characterKeyDefinition(token, modifiers);
}

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

export function splitKeySequence(str: string): string[] {
  const trimmed = (str || '').trim();
  if (!trimmed) return [];
  if (trimmed === ',') return [','];

  const results: string[] = [];
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

export function parseCdpTargetCombinations(
  rawKeys: string,
): Array<{ def: CdpKeyDef; modifiers: number }> {
  const trimmed = rawKeys.trim();
  if (!trimmed) return [];

  // Check direct single key definition first (e.g. "Page Down", "Arrow Down", "Enter")
  const singleDef = cdpKeyDefinition(trimmed, 0);
  if (singleDef) {
    return [{ def: singleDef, modifiers: 0 }];
  }

  // Normalize key sequence (collapses "Page Down" -> "PageDown", space-separated sequence -> comma-separated)
  const normalized = normalizeKeySequence(trimmed);
  const normalizedSingleDef = cdpKeyDefinition(normalized, 0);
  if (normalizedSingleDef) {
    return [{ def: normalizedSingleDef, modifiers: 0 }];
  }

  let tokens = splitKeySequence(normalized);
  if (tokens.length === 1 && !CDP_KEY_DEFINITIONS[keyToken(tokens[0])] && /\s+/.test(tokens[0])) {
    tokens = tokens[0].split(/\s+/).filter(Boolean);
  }

  const targets: Array<{ def: CdpKeyDef; modifiers: number }> = [];
  for (const token of tokens) {
    if (!token) continue;
    if (token === '+' || token === ',') {
      const def = CDP_KEY_DEFINITIONS[token];
      if (def) {
        targets.push({ def, modifiers: 0 });
        continue;
      }
    }

    let modMask = 0;
    let mainKey: string | null = null;

    if (token.endsWith('++')) {
      const modPrefix = token.slice(0, -2);
      const modParts = modPrefix
        .split('+')
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      let allMods = true;
      for (const m of modParts) {
        if (m === 'ctrl' || m === 'control') modMask |= 2;
        else if (m === 'alt') modMask |= 1;
        else if (m === 'shift') modMask |= 8;
        else if (m === 'meta' || m === 'command' || m === 'cmd') modMask |= 4;
        else {
          allMods = false;
          break;
        }
      }
      if (allMods && modParts.length > 0) {
        mainKey = '+';
      }
    }

    if (mainKey === null) {
      const parts = token.split('+').map((p) => p.trim());
      for (const p of parts) {
        const lower = p.toLowerCase();
        if (lower === 'ctrl' || lower === 'control') modMask |= 2;
        else if (lower === 'alt') modMask |= 1;
        else if (lower === 'shift') modMask |= 8;
        else if (lower === 'meta' || lower === 'command' || lower === 'cmd') modMask |= 4;
        else if (mainKey === null) mainKey = p;
        else return [];
      }
      if (!mainKey && parts.length === 1) {
        mainKey = parts[0];
      }
    }

    if (!mainKey) return [];
    const def = cdpKeyDefinition(mainKey, modMask);
    if (!def) return [];
    targets.push({ def, modifiers: modMask });
  }

  return targets;
}

interface KeyboardToolParams {
  keys: string; // Required: string representing keys or key combinations to simulate (e.g., "Enter", "Ctrl+C")
  index?: number; // Optional: 1-based element index from chrome_read_dom to focus before typing
  selector?: string; // Optional: CSS selector or XPath for target element to send keyboard events to
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  text?: string;
  role?: string;
  label?: string;
  exact?: boolean;
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
  async execute(args: KeyboardToolParams, context?: ToolCallContext): Promise<ToolResult> {
    const { keys, selector, selectorType = 'css', delay = TIMEOUTS.KEYBOARD_DELAY } = args;

    if (!keys) {
      return blockedKeyboardError(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Keys parameter must be provided',
        'missing_keys',
      );
    }

    const run = async (): Promise<ToolResult> => {
      throwIfAborted(context?.signal, 'before keyboard');
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return blockedKeyboardError(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
          'no_active_tab',
        );
      }
      tabFaviconManager.markTabActive(tab.id);
      let cursorTarget:
        | {
            tagName?: string;
            text?: string;
            role?: string;
            inputType?: string;
            attributes?: Record<string, string>;
          }
        | undefined;

      if (args.text || args.role || args.label) {
        const located = await resolveTargetLocation(tab.id, {
          text: args.text,
          role: args.role,
          label: args.label,
          exact: args.exact,
          frameId: args.frameId,
          operation: 'press',
          taskId: context?.taskId,
          signal: context?.signal,
          deadlineAt: (args as any)?.deadlineAt ?? (args as any)?.deadline,
        });
        if (!located.success) {
          return createErrorResponse(
            located.error ||
              `Failed to resolve keyboard target. ${ERROR_MESSAGES.INVALID_PARAMETERS}`,
          );
        }
        if (typeof located.index !== 'number') {
          return createErrorResponse('Keyboard target resolved without a stable element index');
        }
        args.index = located.index;
        if (typeof located.frameId === 'number') {
          args.frameId = located.frameId;
        }
        cursorTarget = {
          tagName: located.tagName,
          text: located.text,
          role: located.role,
          inputType: located.inputType,
          attributes: located.attributes,
        };
      }

      // Step 1: Target Focus & Resolution (Common for index and selector)
      if (typeof args.index === 'number' && args.index > 0) {
        const focusRes = await executeInPage(
          typeof args.frameId === 'number'
            ? { tabId: tab.id, frameIds: [args.frameId] }
            : { tabId: tab.id },
          'inPageFocusIndex',
          [args.index],
        );
        let focusTarget = focusRes?.[0]?.result;
        if (!focusTarget?.success && args.frameId === undefined) {
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
        if (focusTarget.focused === false) {
          return createErrorResponse(
            `Index [${args.index}] resolved to <${focusTarget.tagName}> but could not take focus; refusing to type into an unknown element. Focus it explicitly (${resolveToolName('interact_index')}) or pass a selector.`,
          );
        }
        if (!cursorTarget && focusTarget.tagName) {
          cursorTarget = { tagName: focusTarget.tagName };
        }
      }

      let finalSelector = selector;
      let refForFocus: string | undefined = undefined;
      const targetFrameId = args.frameId ?? 0;
      const frameIds = [targetFrameId];

      if (selector) {
        // Ensure accessibility-tree-helper is loaded for selector/XPath resolution and focus
        await this.injectContentScript(
          tab.id,
          ['inject-scripts/accessibility-tree-helper.js'],
          false,
          'ISOLATED',
          false,
          frameIds,
        );

        try {
          const ensured = await this.sendMessageToTab(
            tab.id,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: selectorType === 'xpath',
            },
            targetFrameId,
          );
          if (!ensured || !ensured.success || !ensured.ref) {
            return createErrorResponse(
              `Failed to resolve selector: ${ensured?.error || 'unknown error'}`,
            );
          }
          refForFocus = ensured.ref;

          if (selectorType === 'xpath') {
            finalSelector = undefined;
            const resolved = await this.sendMessageToTab(
              tab.id,
              {
                action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
                ref: ensured.ref,
              },
              targetFrameId,
            );
            if (resolved && resolved.success && resolved.selector) {
              finalSelector = resolved.selector;
            }
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving selector: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (refForFocus) {
          const focusResult = await this.sendMessageToTab(
            tab.id,
            {
              action: 'focusByRef',
              ref: refForFocus,
            },
            targetFrameId,
          );
          if (!focusResult || !focusResult.success) {
            return createErrorResponse(
              `Failed to focus element: ${focusResult?.error || 'unknown error'}`,
            );
          }
        }
      } else if (typeof args.index !== 'number' || args.index <= 0) {
        // Modal Focus Trap: if a modal blocker is active, pull focus into the modal so Tab/Enter don't hit background DOM
        await executeInPage({ tabId: tab.id, frameIds }, 'inPageEnsureModalFocus', []).catch(
          () => {},
        );
      }

      // Step 2: Native edit chords (Ctrl+A, Ctrl+X, Ctrl+C, Ctrl+V) dispatched via CDP
      // Preserves explicit modifier semantics: 'cmd'/'meta' -> 4 (Meta), 'ctrl'/'control' -> 2 (Ctrl).
      const editChordMatch = /^(ctrl|control|meta|cmd)\+([acxv])$/i.exec(String(keys).trim());
      if (editChordMatch) {
        const modStr = editChordMatch[1].toLowerCase();
        const kind = editChordMatch[2].toLowerCase();
        const chordDef = NATIVE_EDIT_CHORDS[kind];
        if (chordDef) {
          try {
            throwIfAborted(context?.signal, 'before keyboard edit chord');
            await setAgentCursorNote(tab.id, chordDef.note);
            // Strict modifier semantics: Meta (4) for cmd/meta; Ctrl (2) for ctrl/control
            const modifierMask = modStr === 'cmd' || modStr === 'meta' ? 4 : 2;

            await cdpSessionManager.withSession(tab.id, 'keyboard-edit-chord', async () => {
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'rawKeyDown',
                key: chordDef.key,
                code: chordDef.code,
                windowsVirtualKeyCode: chordDef.vk,
                nativeVirtualKeyCode: chordDef.vk,
                modifiers: modifierMask,
                commands: [chordDef.command],
              });
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: chordDef.key,
                code: chordDef.code,
                windowsVirtualKeyCode: chordDef.vk,
                nativeVirtualKeyCode: chordDef.vk,
                modifiers: modifierMask,
              });
            });

            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    message: `Dispatched native edit chord: ${keys.trim()} (${chordDef.command})`,
                    method: 'cdp_native_edit_chord',
                    chord: keys.trim(),
                    command: chordDef.command,
                  }),
                },
              ],
              isError: false,
            };
          } catch (error) {
            if (error instanceof DialogOpenedError) {
              throw error;
            }
            if (isCdpOutcomeUncertainError(error)) {
              return createUnknownOutcomeResponse(error);
            }
            return createErrorResponse(
              `Edit chord operation failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      // Step 3: Literal text input typed through CDP Input.insertText
      if (isLiteralText(keys)) {
        try {
          throwIfAborted(context?.signal, 'before keyboard text insert');
          const typeNote = cursorTarget
            ? formatAgentCursorAction('Typing', cursorTarget)
            : 'Typing';
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
          if (typeErr instanceof DialogOpenedError) {
            throw typeErr;
          }
          if (isCdpOutcomeUncertainError(typeErr)) {
            return createUnknownOutcomeResponse(typeErr);
          }
          return createErrorResponse(
            `Failed to type literal text: ${typeErr instanceof Error ? typeErr.message : String(typeErr)}`,
          );
        }
      }

      // Step 4: Fully parsed keys go directly to native CDP. The synthetic helper is
      // only for inputs the CDP parser does not own, and never receives a CDP replay.
      const targetCombos = parseCdpTargetCombinations(keys.trim());
      if (targetCombos.length > 0) {
        let acknowledgedEvents = 0;
        try {
          throwIfAborted(context?.signal, 'before keyboard key event');
          await cdpSessionManager.withSession(tab.id, 'keyboard', async () => {
            for (const combo of targetCombos) {
              throwIfAborted(context?.signal, 'before dispatching key event');
              const def = combo.def;
              const suppressText = (combo.modifiers & (1 | 2 | 4)) !== 0;
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'keyDown',
                key: def.key,
                code: def.code,
                text: suppressText ? undefined : def.text,
                unmodifiedText: def.unmodifiedText,
                windowsVirtualKeyCode: def.windowsVirtualKeyCode,
                nativeVirtualKeyCode: def.windowsVirtualKeyCode,
                modifiers: combo.modifiers || undefined,
              });
              acknowledgedEvents++;
              await cdpSessionManager.sendCommand(tab.id!, 'Input.dispatchKeyEvent', {
                type: 'keyUp',
                key: def.key,
                code: def.code,
                windowsVirtualKeyCode: def.windowsVirtualKeyCode,
                nativeVirtualKeyCode: def.windowsVirtualKeyCode,
                modifiers: combo.modifiers || undefined,
              });
              acknowledgedEvents++;
              if (targetCombos.length > 1) {
                await waitWithAbort(
                  Math.min(50, Math.max(10, delay)),
                  context?.signal,
                  'during keyboard delay',
                );
              }
            }
          });
          const keyNames = targetCombos.map((c) => c.def.key).join(', ');
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: `Dispatched native CDP key(s): ${keyNames}`,
                  method: 'cdp_dispatch_key_event',
                  isTrusted: true,
                  keys: keyNames,
                }),
              },
            ],
            isError: false,
          };
        } catch (cdpErr) {
          if (cdpErr instanceof DialogOpenedError) {
            throw cdpErr;
          }
          if (acknowledgedEvents > 0 || isCdpOutcomeUncertainError(cdpErr)) {
            return createUnknownOutcomeResponse(
              cdpErr,
              acknowledgedEvents > 0 ? acknowledgedEvents : undefined,
            );
          }
          return createErrorResponse(
            `Keyboard CDP dispatch failed: ${
              cdpErr instanceof Error ? cdpErr.message : String(cdpErr)
            }`,
          );
        }
      }

      // Helper-only path: one message, no synthetic-to-CDP fallback.
      await this.injectContentScript(
        tab.id,
        ['inject-scripts/keyboard-helper.js'],
        false,
        'ISOLATED',
        false,
        frameIds,
      );

      // Send keyboard simulation message to content script
      let result: any;
      try {
        throwIfAborted(context?.signal, 'before keyboard helper simulate');
        result = await this.sendMessageToTab(
          tab.id,
          {
            action: TOOL_MESSAGE_TYPES.SIMULATE_KEYBOARD,
            keys: normalizeKeySequence(keys),
            selector: finalSelector,
            delay,
          },
          targetFrameId,
        );
      } catch (messageError) {
        if (messageError instanceof DialogOpenedError) {
          throw messageError;
        }
        return createUnknownOutcomeResponse(messageError);
      }

      if (result?.dispatched === false) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: false,
                status: 'blocked',
                retry: true,
                dispatched: false,
                error: result.error || 'Keyboard helper rejected the sequence before dispatching',
              }),
            },
          ],
          isError: true,
        };
      }

      if (!result) {
        return createUnknownOutcomeResponse(
          new Error('Keyboard helper response missing after send'),
        );
      }

      if (result.error || result.success !== true) {
        if (result?.error) {
          return createUnknownOutcomeResponse(
            new Error(`Keyboard simulation outcome unknown: ${result.error}`),
          );
        }
        if (result?.success === false) {
          return createUnknownOutcomeResponse(
            new Error('Keyboard simulation reported a failed key combination'),
          );
        }
        return createUnknownOutcomeResponse(
          new Error('Keyboard simulation timed out or failed to receive a correlated response'),
        );
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
    };

    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return blockedKeyboardError(
          ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID',
          'no_active_tab',
        );
      }
      return withKeyboardInteraction(await withActionReceipt(tab.id, run));
    } catch (error) {
      if (error instanceof DialogOpenedError) {
        return createDialogInterruptResponse(error);
      }
      logUnexpectedToolError('Error in keyboard operation:', error);
      if (isCdpOutcomeUncertainError(error)) {
        return attachActionReceipt(createUnknownOutcomeResponse(error), (error as any)?.receipt);
      }
      return attachActionReceipt(
        createInteractionErrorResponse(
          `Error simulating keyboard events: ${error instanceof Error ? error.message : String(error)}`,
          makeInteractionOutcome(
            'not_dispatched',
            'not_requested',
            'keyboard_preparation_failed',
            0,
          ),
          { status: 'blocked', requestDispatched: false },
        ),
        (error as any)?.receipt,
      );
    }
  }
}

const NATIVE_EDIT_CHORDS: Record<
  string,
  { key: string; code: string; vk: number; command: string; note: string }
> = {
  a: { key: 'a', code: 'KeyA', vk: 65, command: 'SelectAll', note: 'Selecting all' },
  c: { key: 'c', code: 'KeyC', vk: 67, command: 'Copy', note: 'Copying to clipboard' },
  x: { key: 'x', code: 'KeyX', vk: 88, command: 'Cut', note: 'Cutting to clipboard' },
  v: { key: 'v', code: 'KeyV', vk: 86, command: 'Paste', note: 'Pasting clipboard' },
};

export const keyboardTool = new KeyboardTool();

/**
 * Dispatch OS-adaptive native SelectAll command through CDP.
 * Modeled after Browser-Harness (BH: src/browser_harness/helpers.py:221-248) and
 * JEV (jev_ultrafast/browser.py:170-180).
 */
export async function dispatchNativeSelectAll(tabId: number, timeoutMs?: number): Promise<void> {
  const isMac =
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPod|iPad/i.test(navigator.platform || navigator.userAgent);
  const modifierMask = isMac ? 4 : 2; // Meta (Mac: 4) vs Ctrl (Win/Linux: 2)

  await cdpSessionManager.withSession(tabId, 'keyboard-select-all', async () => {
    await raceCdp(
      tabId,
      'Input.dispatchKeyEvent',
      {
        type: 'rawKeyDown',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: modifierMask,
        commands: ['SelectAll'],
      },
      timeoutMs,
    );
    await raceCdp(
      tabId,
      'Input.dispatchKeyEvent',
      {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65,
        nativeVirtualKeyCode: 65,
        modifiers: modifierMask,
      },
      timeoutMs,
    );
  });
}
