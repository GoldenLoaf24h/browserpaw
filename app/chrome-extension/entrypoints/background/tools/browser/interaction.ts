import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { TIMEOUTS, ERROR_MESSAGES } from '@/common/constants';
import { resolveTargetLocation } from './unified-locator';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { executeInPage } from './in-page-engine';
import type { PolymorphicCoordinate } from '@/utils/coordinate-parser';
import { animateAgentCursor, animateAgentCursorClick } from './agent-cursor';

/**
 * D3 (TESTING-NOTES #19): resolveAffinityTab falls back to the user's ACTIVE
 * tab when no explicit tabId and no session binding matches. The agent never
 * knows its input landed on the page the user was viewing. Resolve the same
 * way here and surface a warning when the fallback path was taken.
 */
async function resolveAffinityWarning(
  args: { tabId?: number; sessionId?: string; sessionContext?: string },
  resolvedTabId: number,
  hadPreexistingBinding: boolean,
): Promise<string | undefined> {
  if (typeof args.tabId === 'number') return undefined;
  const sid = args.sessionId || args.sessionContext;
  // The fallback binding was established by resolveAffinityTab itself; only
  // a binding that existed BEFORE the call proves the session was intentionally
  // pinned to this tab.
  if (!hadPreexistingBinding) {
    return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
  }
  if (!sid) {
    return `input routed to active tab (tabId=${resolvedTabId}); pass explicit tabId to target another tab`;
  }
  return undefined;
}

/**
 * D1: one-shot delivery probe around a CDP input dispatch. Hidden-tab
 * throttling acks the command but drops the event, so success:true lied.
 * Arming uses the in-page engine; failures degrade to undefined (no field).
 */
async function armDeliveryProbe(tabId: number, events: string[]): Promise<boolean> {
  try {
    await executeInPage({ tabId }, 'inPageArmDeliveryProbe', [events]);
    return true;
  } catch {
    return false;
  }
}

async function readDeliveryProbe(tabId: number): Promise<boolean | undefined> {
  try {
    const probe = (await executeInPage({ tabId }, 'inPageReadDeliveryProbe', [true]))?.[0]?.result;
    return Boolean(probe?.delivered);
  } catch {
    return undefined;
  }
}

interface Coordinates {
  x: number;
  y: number;
}

interface ClickToolParams {
  selector?: string; // CSS selector or XPath for the element to click
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree (window.__mcpElementMap)
  index?: number; // Compact 1-based index from chrome_read_dom
  text?: string; // Match target element by visible text
  role?: string; // Match target element by ARIA role
  coordinate?: Coordinates | PolymorphicCoordinate; // Preferred unified coordinate parameter
  coordinates?: Coordinates | PolymorphicCoordinate; // Alias coordinates to click at (x, y relative to viewport)
  coordinateSpace?: 'viewport' | 'screenshot'; // Space of coordinate/coordinates (default: viewport)
  waitForNavigation?: boolean; // Whether to wait for navigation to complete after click
  timeout?: number; // Timeout in milliseconds for waiting for the element or navigation
  frameId?: number; // Target frame for ref/selector resolution
  double?: boolean; // Perform double click when true
  button?: 'left' | 'right' | 'middle';
  bubbles?: boolean;
  cancelable?: boolean;
  modifiers?: { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  sessionId?: string; // session affinity identifier
  sessionContext?: string;
}

/**
 * Tool for clicking elements on web pages
 */
class ClickTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.CLICK;

  /**
   * Execute click operation
   */
  async execute(args: ClickToolParams): Promise<ToolResult> {
    const coordinates = args.coordinate || args.coordinates;
    const {
      selector,
      selectorType = 'css',
      waitForNavigation = false,
      timeout = TIMEOUTS.DEFAULT_WAIT * 5,
      frameId,
      button,
      bubbles,
      cancelable,
      modifiers,
    } = args;

    console.log(`Starting click operation with options:`, args);

    const hasRef = Boolean(args.ref || args.index !== undefined);
    const hasSelector = Boolean(selector);
    const hasTextOrRole = Boolean(args.text || args.role);
    const hasCoords = Boolean(coordinates);

    if (!hasRef && !hasSelector && !hasTextOrRole && !hasCoords) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref, index, selector, text/role, or coordinate',
      );
    }

    try {
      const clickHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || (args as any).sessionContext,
      );
      // Resolve tab
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      const tabId = tab.id;

      const clickAffinityWarning = await resolveAffinityWarning(
        args,
        tabId,
        clickHadPreexistingBinding,
      );

      let finalRef = args.ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Unified locator & CDP Input click dispatch (P1-4)
      const loc = await resolveTargetLocation(tabId, {
        ref: finalRef,
        index: args.index,
        selector: finalSelector,
        selectorType,
        text: args.text,
        role: args.role,
        coordinate: coordinates,
        coordinateSpace: (args as any).coordinateSpace,
      });

      if (loc.success) {
        // Task B4: Direct single-step selection for select-option entries
        if ((loc as any).isSelectOption || loc.tagName === 'option') {
          const targetIndex = args.index ?? loc.index;
          if (targetIndex !== undefined) {
            const selectRes = (
              await executeInPage(
                loc.frameId ? { tabId, frameIds: [loc.frameId] } : { tabId },
                'inPageInteractIndex',
                [targetIndex, 'click'],
              )
            )?.[0]?.result;
            if (selectRes?.success) {
              return {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      message: 'Select option selected successfully',
                      clickMethod: 'select_option_inpage',
                      resolutionPath: loc.resolutionPath,
                      tagName: loc.tagName,
                      text: loc.text,
                      ...(loc.warning ? { warning: loc.warning } : {}),
                    }),
                  },
                ],
                isError: false,
              };
            }
          }
        }

        let isTrusted = false;
        let deliveryVerified: boolean | undefined;
        // CDP modifier bitmask (Alt=1, Ctrl=2, Meta=4, Shift=8). Without this the
        // primary CDP path silently dropped modifiers, so callers such as
        // chrome_computer left_click({modifiers:{shiftKey:true}}) produced
        // shiftKey=false on the page while the content-script fallback path worked.
        const modifierMask =
          (modifiers?.altKey ? 1 : 0) |
          (modifiers?.ctrlKey ? 2 : 0) |
          (modifiers?.metaKey ? 4 : 0) |
          (modifiers?.shiftKey ? 8 : 0);
        try {
          const probeArmed = await armDeliveryProbe(tabId, ['mousedown', 'mouseup', 'click']);
          // Animate virtual agent cursor before physical click
          const clickNote =
            (args as any).note ||
            (args as any).actionNote ||
            (args.double
              ? 'Double click'
              : button === 'right'
                ? 'Right click'
                : args.ref
                  ? `Clicking ref ${args.ref}`
                  : args.selector
                    ? `Clicking ${args.selector.slice(0, 20)}`
                    : 'Clicking');
          await animateAgentCursor(tabId, loc.x, loc.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: clickNote,
          });
          await cdpSessionManager.withSession(tabId, 'click-tool', async () => {
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: loc.x,
              y: loc.y,
              modifiers: modifierMask,
            });
            const clickCount = args.double ? 2 : 1;
            const buttonName = button || 'left';
            // `buttons` is the pressed-button bitmask (left=1, right=2, middle=4).
            // CDP infers it inconsistently for mousePressed when modifiers are
            // present, so state it explicitly.
            const buttonsMask = buttonName === 'right' ? 2 : buttonName === 'middle' ? 4 : 1;
            // CDP only synthesises dblclick when the press/release pairs carry
            // clickCount 1 then 2; a single pair with clickCount:2 fires click
            // alone on several renderers. Mirrors computer.ts double/triple path.
            for (let i = 1; i <= clickCount; i++) {
              await animateAgentCursorClick(tabId, loc.x, loc.y, clickNote);
              await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: loc.x,
                y: loc.y,
                button: buttonName,
                buttons: buttonsMask,
                clickCount: i,
                modifiers: modifierMask,
              });
              await new Promise((r) => setTimeout(r, 35));
              await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: loc.x,
                y: loc.y,
                button: buttonName,
                buttons: 0,
                clickCount: i,
                modifiers: modifierMask,
              });
              if (i < clickCount) {
                await new Promise((r) => setTimeout(r, 50));
              }
            }
            isTrusted = true;
          });
          if (probeArmed) {
            deliveryVerified = await readDeliveryProbe(tabId);
          }
        } catch (cdpErr) {
          console.warn('[ClickTool] CDP click failed, falling back to content script:', cdpErr);
        }

        if (isTrusted) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Click operation successful (CDP Input)',
                  clickMethod: loc.resolutionPath,
                  resolutionPath: loc.resolutionPath,
                  coordinates: { x: loc.x, y: loc.y },
                  tagName: loc.tagName,
                  text: loc.text,
                  isTrusted: true,
                  ...(clickAffinityWarning ? { affinityWarning: clickAffinityWarning } : {}),
                  ...(deliveryVerified === undefined ? {} : { deliveryVerified }),
                  ...(loc.warning ? { warning: loc.warning } : {}),
                  _canonicalRecommendation: `For 10x higher reliability and native Shadow DOM support, prefer '${resolveToolName('interact_index')}'.`,
                }),
              },
            ],
            isError: false,
          };
        }
      }

      await this.injectContentScript(tab.id, ['inject-scripts/click-helper.js']);

      // Send click message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.CLICK_ELEMENT,
          selector: finalSelector,
          coordinates,
          ref: finalRef,
          waitForNavigation,
          timeout,
          double: args.double === true,
          button,
          bubbles,
          cancelable,
          modifiers,
        },
        frameId,
      );

      // Determine actual click method used
      let clickMethod: string;
      if (coordinates) {
        clickMethod = 'coordinates';
      } else if (finalRef) {
        clickMethod = 'ref';
      } else if (finalSelector) {
        clickMethod = 'selector';
      } else {
        clickMethod = 'unknown';
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Click operation successful',
              elementInfo: result.elementInfo,
              navigationOccurred: result.navigationOccurred,
              clickMethod,
              _canonicalRecommendation: `For 10x higher reliability and native Shadow DOM support, prefer '${resolveToolName('interact_index')}'.`,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in click operation:', error);
      return createErrorResponse(
        `Error performing click: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const clickTool = new ClickTool();

interface FillToolParams {
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  ref?: string; // Element ref from accessibility tree
  index?: number; // Compact 1-based index from chrome_read_dom
  targetText?: string; // Target element by label or visible text
  role?: string; // Target element by ARIA role
  coordinate?: Coordinates | PolymorphicCoordinate; // Preferred unified coordinate parameter
  coordinates?: Coordinates | PolymorphicCoordinate; // Alias coordinates to click and focus before typing
  coordinateSpace?: 'viewport' | 'screenshot'; // Space of coordinate/coordinates (default: viewport)
  // Unified text parameter (alias for value)
  text?: string;
  // Accept string | number | boolean for broader form input coverage
  value?: string | number | boolean;
  frameId?: number;
  tabId?: number; // target existing tab id
  windowId?: number; // when no tabId, pick active tab from this window
  sessionId?: string; // session affinity identifier
  sessionContext?: string;
}

/**
 * Tool for filling form elements on web pages
 */
class FillTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.FILL;

  /**
   * Execute fill operation
   */
  async execute(args: FillToolParams): Promise<ToolResult> {
    const coordinates = args.coordinate || args.coordinates;
    const value = args.value !== undefined ? args.value : args.text;
    const targetText = args.targetText || (args.value !== undefined ? args.text : undefined);
    const { selector, selectorType = 'css', ref, frameId } = args;

    console.log(`Starting fill operation with options:`, args);

    const hasRef = Boolean(ref || args.index !== undefined);
    const hasSelector = Boolean(selector);
    const hasTargetTextOrRole = Boolean(targetText || args.role);
    const hasCoords = Boolean(coordinates);

    if (!hasRef && !hasSelector && !hasTargetTextOrRole && !hasCoords) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS +
          ': Provide ref, index, selector, targetText/role, or coordinate',
      );
    }

    if (value === undefined || value === null) {
      return createErrorResponse(
        ERROR_MESSAGES.INVALID_PARAMETERS + ': Text or value must be provided',
      );
    }

    try {
      const fillHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || (args as any).sessionContext,
      );
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || (args as any).sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      }
      const tabId = tab.id;

      const fillAffinityWarning = await resolveAffinityWarning(
        args,
        tabId,
        fillHadPreexistingBinding,
      );

      let finalRef = ref;
      let finalSelector = selector;

      // If selector is XPath, convert to ref first
      if (selector && selectorType === 'xpath') {
        await this.injectContentScript(tabId, ['inject-scripts/accessibility-tree-helper.js']);
        try {
          const resolved = await this.sendMessageToTab(
            tabId,
            {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector,
              isXPath: true,
            },
            frameId,
          );
          if (resolved && resolved.success && resolved.ref) {
            finalRef = resolved.ref;
            finalSelector = undefined; // Use ref instead of selector
          } else {
            return createErrorResponse(
              `Failed to resolve XPath selector: ${resolved?.error || 'unknown error'}`,
            );
          }
        } catch (error) {
          return createErrorResponse(
            `Error resolving XPath: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      // Unified locator & CDP Input fill dispatch (P1-4)
      const loc = await resolveTargetLocation(tabId, {
        ref: finalRef,
        index: args.index,
        selector: finalSelector,
        selectorType,
        targetText,
        text: targetText,
        role: args.role,
        coordinate: coordinates,
        coordinateSpace: (args as any).coordinateSpace,
      });

      if (loc.success) {
        let isTrusted = false;
        let deliveryVerified: boolean | undefined;
        try {
          const probeArmed = await armDeliveryProbe(tabId, ['focus', 'input', 'change']);
          // Animate virtual agent cursor before physical click-to-focus
          const valStr = args.value !== undefined && args.value !== true ? String(args.value) : '';
          const fillNote =
            (args as any).note ||
            (args as any).actionNote ||
            (valStr
              ? `Typing "${valStr.length > 18 ? valStr.slice(0, 15) + '...' : valStr}"`
              : 'Focusing input');
          await animateAgentCursor(tabId, loc.x, loc.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: fillNote,
          });
          await cdpSessionManager.withSession(tabId, 'fill-tool', async () => {
            // Click to focus
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseMoved',
              x: loc.x,
              y: loc.y,
            });
            await animateAgentCursorClick(tabId, loc.x, loc.y, fillNote);
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: loc.x,
              y: loc.y,
              button: 'left',
              clickCount: 1,
            });
            await new Promise((r) => setTimeout(r, 35));
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: loc.x,
              y: loc.y,
              button: 'left',
              clickCount: 1,
            });

            // Clear input
            let isMac = false;
            try {
              const platform = await chrome.runtime.getPlatformInfo();
              isMac = platform?.os === 'mac';
            } catch {}
            const selectAllMod = isMac ? 4 : 2;

            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              modifiers: selectAllMod,
              windowsVirtualKeyCode: 65,
              key: 'a',
              code: 'KeyA',
            });
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              modifiers: selectAllMod,
              windowsVirtualKeyCode: 65,
              key: 'a',
              code: 'KeyA',
            });
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'rawKeyDown',
              windowsVirtualKeyCode: 8,
              key: 'Backspace',
              code: 'Backspace',
            });
            await cdpSessionManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
              type: 'keyUp',
              windowsVirtualKeyCode: 8,
              key: 'Backspace',
              code: 'Backspace',
            });

            // Insert text
            const textToInsert = String(value);
            if (textToInsert.length > 0) {
              await cdpSessionManager.sendCommand(tabId, 'Input.insertText', {
                text: textToInsert,
              });
            }
            isTrusted = true;
          });
          if (probeArmed) {
            deliveryVerified = await readDeliveryProbe(tabId);
          }
        } catch (cdpErr) {
          console.warn('[FillTool] CDP fill failed, falling back to content script:', cdpErr);
        }

        if (isTrusted) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  message: 'Fill operation successful (CDP Input)',
                  fillMethod: loc.resolutionPath,
                  resolutionPath: loc.resolutionPath,
                  coordinates: { x: loc.x, y: loc.y },
                  tagName: loc.tagName,
                  isTrusted: true,
                  ...(fillAffinityWarning ? { affinityWarning: fillAffinityWarning } : {}),
                  ...(deliveryVerified === undefined ? {} : { deliveryVerified }),
                  ...(loc.warning ? { warning: loc.warning } : {}),
                }),
              },
            ],
            isError: false,
          };
        }
      }

      await this.injectContentScript(tab.id, ['inject-scripts/fill-helper.js']);

      // Send fill message to content script
      const result = await this.sendMessageToTab(
        tab.id,
        {
          action: TOOL_MESSAGE_TYPES.FILL_ELEMENT,
          selector: finalSelector,
          ref: finalRef,
          value,
        },
        frameId,
      );

      if (result && result.error) {
        return createErrorResponse(result.error);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: result.message || 'Fill operation successful',
              elementInfo: result.elementInfo,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in fill operation:', error);
      return createErrorResponse(
        `Error filling element: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const fillTool = new FillTool();
