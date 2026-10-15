import { tabFaviconManager } from './tab-favicon';
import { tabGroupManager } from './tab-group-manager';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'chrome-mcp-shared';
import { ERROR_MESSAGES, TIMEOUTS } from '@/common/constants';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import { clickTool, fillTool } from './interaction';
import { keyboardTool } from './keyboard';
import { screenshotTool, normalizeImageToCssDimensions } from './screenshot';
import { screenshotContextManager, scaleCoordinates } from '@/utils/screenshot-context';
import { screenshotOriginViolation, dwell } from '@/utils/screenshot-guard';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { screenshotRingBuffer } from '@/utils/screenshot-ring-buffer';
import {
  compressImage,
  smartCompressForTransport,
  overlayCoordinateGrid,
} from '@/utils/image-utils';
import { parseUnifiedCoordinate, type PolymorphicCoordinate } from '@/utils/coordinate-parser';
import { sessionTabAffinity } from '@/utils/session-tab-affinity';
import { animateAgentCursor, animateAgentCursorClick, setAgentCursorNote } from './agent-cursor';
import { executeInPage } from './in-page-engine';
import { createMousePressGuard, isCdpOutcomeUncertainError } from '@/utils/race-cdp';

type MouseButton = 'left' | 'right' | 'middle';

interface Coordinates {
  x: number;
  y: number;
}

interface ZoomRegion {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Modifiers {
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface ComputerParams {
  action:
    | 'left_click'
    | 'right_click'
    | 'double_click'
    | 'triple_click'
    | 'left_click_drag'
    | 'scroll'
    | 'type'
    | 'key'
    | 'hover'
    | 'wait'
    | 'fill'
    | 'fill_form'
    | 'resize_page'
    | 'scroll_to'
    | 'zoom'
    | 'screenshot';
  // click/scroll coordinates in screenshot space (if screenshot context exists) or viewport space
  coordinates?: Coordinates | PolymorphicCoordinate; // for click/scroll; for drag, this is endCoordinates
  startCoordinates?: Coordinates | PolymorphicCoordinate; // for drag start
  // Optional element refs (from chrome_read_dom) as alternative to coordinates
  ref?: string; // click target or drag end
  startRef?: string; // drag start
  scrollDirection?: 'up' | 'down' | 'left' | 'right';
  scrollAmount?: number;
  text?: string; // for type/key
  repeat?: number; // for key action (1-100)
  modifiers?: Modifiers; // for click actions
  region?: ZoomRegion | PolymorphicCoordinate | number[]; // for zoom action
  duration?: number; // seconds for wait
  dwellMs?: number; // mouse-pressed dwell before release (anti-instant-click targets, 0-2000)
  coordinateSpace?: 'viewport' | 'screenshot'; // space of coordinates (default: viewport)
  // For fill
  selector?: string;
  selectorType?: 'css' | 'xpath'; // Type of selector (default: 'css')
  value?: string;
  frameId?: number; // Target frame for selector/ref resolution
  tabId?: number; // target existing tab id
  windowId?: number;
  background?: boolean; // avoid focusing/activating
  sessionId?: string;
  sessionContext?: string;
  autoSnap?: boolean; // automatically snap coordinates to closest interactive element if clicked whitespace (default: true)
  grid?: boolean | 'ruler' | 'crosshair' | 'classic' | '1000';
  highClarity?: boolean;
  crop?: any;
  quality?: number;
  format?: 'png' | 'jpeg' | 'webp';
  groupTitle?: string;
  groupColor?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  autoGroup?: boolean;
}

// Minimal CDP helper encapsulated here to avoid scattering CDP code
class CDPHelper {
  static async send(tabId: number, method: string, params?: object): Promise<any> {
    return await cdpSessionManager.sendCommand(tabId, method, params);
  }

  static async dispatchMouseEvent(tabId: number, opts: any) {
    const params: any = {
      type: opts.type,
      x: Math.round(opts.x),
      y: Math.round(opts.y),
      modifiers: opts.modifiers || 0,
    };
    if (
      opts.type === 'mousePressed' ||
      opts.type === 'mouseReleased' ||
      opts.type === 'mouseMoved'
    ) {
      params.button = opts.button || 'none';
      if (opts.type === 'mousePressed' || opts.type === 'mouseReleased') {
        params.clickCount = opts.clickCount || 1;
      }
      // Per CDP: buttons is ignored for mouseWheel
      params.buttons = opts.buttons !== undefined ? opts.buttons : 0;
    }
    if (opts.type === 'mouseWheel') {
      params.deltaX = opts.deltaX || 0;
      params.deltaY = opts.deltaY || 0;
    }
    await this.send(tabId, 'Input.dispatchMouseEvent', params);
  }

  static async insertText(tabId: number, text: string) {
    await this.send(tabId, 'Input.insertText', { text });
  }

  static modifierMask(mods: string[]): number {
    const map: Record<string, number> = {
      alt: 1,
      ctrl: 2,
      control: 2,
      meta: 4,
      cmd: 4,
      command: 4,
      win: 4,
      windows: 4,
      shift: 8,
    };
    let mask = 0;
    for (const m of mods) mask |= map[m] || 0;
    return mask;
  }

  // Enhanced key mapping for common non-character keys
  private static KEY_ALIASES: Record<string, { key: string; code?: string; text?: string }> = {
    enter: { key: 'Enter', code: 'Enter' },
    return: { key: 'Enter', code: 'Enter' },
    backspace: { key: 'Backspace', code: 'Backspace' },
    delete: { key: 'Delete', code: 'Delete' },
    tab: { key: 'Tab', code: 'Tab' },
    escape: { key: 'Escape', code: 'Escape' },
    esc: { key: 'Escape', code: 'Escape' },
    space: { key: ' ', code: 'Space', text: ' ' },
    pageup: { key: 'PageUp', code: 'PageUp' },
    pagedown: { key: 'PageDown', code: 'PageDown' },
    home: { key: 'Home', code: 'Home' },
    end: { key: 'End', code: 'End' },
    arrowup: { key: 'ArrowUp', code: 'ArrowUp' },
    arrowdown: { key: 'ArrowDown', code: 'ArrowDown' },
    arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft' },
    arrowright: { key: 'ArrowRight', code: 'ArrowRight' },
  };

  private static resolveKeyDef(token: string): { key: string; code?: string; text?: string } {
    const t = (token || '').toLowerCase();
    if (this.KEY_ALIASES[t]) return this.KEY_ALIASES[t];
    if (/^f([1-9]|1[0-2])$/.test(t)) {
      return { key: t.toUpperCase(), code: t.toUpperCase() };
    }
    if (t.length === 1) {
      const upper = t.toUpperCase();
      return { key: upper, code: `Key${upper}`, text: t };
    }
    return { key: token };
  }

  static async dispatchSimpleKey(tabId: number, token: string) {
    const def = this.resolveKeyDef(token);
    if (def.text && def.text.length === 1) {
      await this.insertText(tabId, def.text);
      return;
    }
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
    });
  }

  static async dispatchKeyChord(tabId: number, chord: string) {
    const parts = chord.split('+');
    const modifiers: string[] = [];
    let keyToken = '';
    for (const pRaw of parts) {
      const p = pRaw.trim().toLowerCase();
      if (
        ['ctrl', 'control', 'alt', 'shift', 'cmd', 'meta', 'command', 'win', 'windows'].includes(p)
      )
        modifiers.push(p);
      else keyToken = pRaw.trim();
    }
    const mask = this.modifierMask(modifiers);
    const def = this.resolveKeyDef(keyToken);
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      key: def.key,
      code: def.code,
      text: def.text,
      modifiers: mask,
    });
    await this.send(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      modifiers: mask,
    });
  }
}

class ComputerTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.COMPUTER;

  async execute(args: ComputerParams): Promise<ToolResult> {
    const params = args || ({} as ComputerParams);
    if (!params.action) return createErrorResponse('Action parameter is required');

    try {
      // D3: snapshot BEFORE resolveAffinityTab (fallback binds the fallback
      // tab, so post-resolution checks always pass).
      const computerHadPreexistingBinding = sessionTabAffinity.hasBinding(
        args.sessionId || args.sessionContext,
      );
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id)
        return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
      tabFaviconManager.markTabActive(tab.id);

      // TOOL01: Consume groupTitle, groupColor, autoGroup without double-grouping
      if (args.autoGroup !== false && typeof tab.windowId === 'number') {
        const isAlreadyAgentTab = tabGroupManager.isAgentTab(tab.id);
        const hasExplicitConfig = Boolean(args.groupTitle || args.groupColor);
        if (hasExplicitConfig || !isAlreadyAgentTab) {
          await tabGroupManager
            .ensureAgentTabGroup(tab.id, {
              title: args.groupTitle,
              color: args.groupColor,
              windowId: tab.windowId,
            })
            .catch(() => {});
        }
      }

      // D3 (TESTING-NOTES #19): warn when the target fell back to the active
      // tab so agent input landing on the user's current page is visible.
      const computerAffinityWarning = await (async () => {
        if (typeof args.tabId === 'number') return undefined;
        if (!computerHadPreexistingBinding) {
          return `input routed to active tab (tabId=${tab.id}); pass explicit tabId to target another tab`;
        }
        return undefined;
      })();

      // Execute the action and capture frame on success
      const result = await this.executeAction(params, tab);
      if (computerAffinityWarning && result?.content?.[0]?.type === 'text') {
        try {
          const payload = JSON.parse(result.content[0].text as string);
          if (payload && typeof payload === 'object' && payload.success !== false) {
            payload.affinityWarning = computerAffinityWarning;
            result.content[0].text = JSON.stringify(payload);
          }
        } catch {
          // Non-JSON response text: leave untouched.
        }
      }

      return result;
    } catch (error) {
      console.error('Error in computer tool:', error);
      return createErrorResponse(
        `Failed to execute action: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async executeAction(params: ComputerParams, tab: chrome.tabs.Tab): Promise<ToolResult> {
    if (!tab.id) {
      return createErrorResponse(ERROR_MESSAGES.TAB_NOT_FOUND + ': Active tab has no ID');
    }
    const tabId = tab.id;
    const targetSessionId = params.sessionId || params.sessionContext;
    const targetWindowId = tab.windowId;

    const isScreenshotSpace = params.coordinateSpace === 'screenshot';

    // Single unified helper to project and viewport-align coordinates
    const projectCoords = async (
      c1?: any,
      c2?: any,
    ): Promise<{
      p1?: Coordinates;
      p2?: Coordinates;
      error?: string;
    }> => {
      if (!c1 && !c2) return {};

      let screenshotCtx: any;
      if (isScreenshotSpace) {
        screenshotCtx = screenshotContextManager.getContext(tabId);
        if (!screenshotCtx) {
          return {
            error:
              'Screenshot context expired or not found. Capture a screenshot before using coordinateSpace: "screenshot".',
          };
        }
        if (tab.url) {
          const originErr = screenshotOriginViolation(tabId, tab.url, params.action);
          if (originErr) return { error: originErr };
        }
      }

      const parseOne = (raw: any): { x: number; y: number; isDocumentSpace?: boolean } | null => {
        if (!raw) return null;
        if (isScreenshotSpace && screenshotCtx) {
          // Normalize to screenshot pixel grid first without double scaling
          const rawParsed = parseUnifiedCoordinate(raw, {
            viewportWidth: screenshotCtx.screenshotWidth,
            viewportHeight: screenshotCtx.screenshotHeight,
            originX: 0,
            originY: 0,
          });
          if (!rawParsed) return null;
          const scaled = scaleCoordinates(rawParsed.x, rawParsed.y, screenshotCtx);
          return { x: scaled.x, y: scaled.y, isDocumentSpace: scaled.isDocumentSpace };
        }
        // Viewport space: standard CSS viewport without ROI/crop projection
        const parsed = parseUnifiedCoordinate(raw, { originX: 0, originY: 0 });
        return parsed ? { x: parsed.x, y: parsed.y } : null;
      };

      const res1 = parseOne(c1);
      const res2 = parseOne(c2);

      if ((c1 && !res1) || (c2 && !res2)) {
        return { error: 'Failed to parse coordinates' };
      }

      // If any coordinate is in document space (e.g. from fullPage screenshot), align viewport
      if (res1?.isDocumentSpace || res2?.isDocumentSpace) {
        const scrollRes = await executeInPage({ tabId }, 'inPageGetScrollState', []).catch(
          () => null,
        );
        const scrollState = scrollRes?.[0]?.result;
        if (
          !scrollState ||
          typeof scrollState.scrollX !== 'number' ||
          typeof scrollState.scrollY !== 'number' ||
          typeof scrollState.viewportWidth !== 'number' ||
          typeof scrollState.viewportHeight !== 'number'
        ) {
          return {
            error: 'Failed to retrieve page scroll geometry for document space coordinates',
          };
        }

        const vh = scrollState.viewportHeight;
        const vw = scrollState.viewportWidth;
        let curScrollX = scrollState.scrollX;
        let curScrollY = scrollState.scrollY;

        // Calculate valid scroll bounding interval [minScroll, maxScroll] that can show target point(s)
        const getFeasibleRange = (
          p1?: { x: number; y: number },
          p2?: { x: number; y: number },
        ): { minX: number; maxX: number; minY: number; maxY: number } | null => {
          let minX = 0;
          let maxX = Infinity;
          let minY = 0;
          let maxY = Infinity;

          if (p1 && p2) {
            minX = Math.max(0, p1.x - vw + 1, p2.x - vw + 1);
            maxX = Math.min(p1.x, p2.x);
            minY = Math.max(0, p1.y - vh + 1, p2.y - vh + 1);
            maxY = Math.min(p1.y, p2.y);
            if (minX > maxX || minY > maxY) return null;
          } else {
            const p = p1 || p2!;
            minX = Math.max(0, p.x - vw + 1);
            maxX = p.x;
            minY = Math.max(0, p.y - vh + 1);
            maxY = p.y;
          }
          return { minX, maxX, minY, maxY };
        };

        const range = getFeasibleRange(res1 ?? undefined, res2 ?? undefined);
        if (!range) {
          return {
            error: `Coordinates (${res1 ? res1.x + ',' + res1.y : ''}) and (${res2 ? res2.x + ',' + res2.y : ''}) cannot fit simultaneously within viewport (${vw}x${vh}). Both points must fit within the same viewport.`,
          };
        }

        // Check if current scroll position already accommodates the points
        const needScrollX = curScrollX < range.minX || curScrollX > range.maxX;
        const needScrollY = curScrollY < range.minY || curScrollY > range.maxY;

        if (needScrollX || needScrollY) {
          let targetX = curScrollX;
          let targetY = curScrollY;

          if (needScrollX) {
            const desiredX =
              res1 && res2 ? (res1.x + res2.x) / 2 - vw / 2 : (res1 || res2!).x - vw / 2;
            targetX = Math.round(Math.max(range.minX, Math.min(range.maxX, desiredX)));
          }
          if (needScrollY) {
            const desiredY =
              res1 && res2 ? (res1.y + res2.y) / 2 - vh / 2 : (res1 || res2!).y - vh / 2;
            targetY = Math.round(Math.max(range.minY, Math.min(range.maxY, desiredY)));
          }

          const instantRes = await executeInPage({ tabId }, 'inPageInstantScrollTo', [
            targetX,
            targetY,
          ]).catch(() => null);
          const scrollOutcome = instantRes?.[0]?.result;
          if (
            !scrollOutcome ||
            !scrollOutcome.success ||
            typeof scrollOutcome.scrollX !== 'number' ||
            typeof scrollOutcome.scrollY !== 'number'
          ) {
            return { error: 'Failed to scroll page to bring target coordinates into viewport' };
          }
          curScrollX = scrollOutcome.scrollX;
          curScrollY = scrollOutcome.scrollY;
        }

        // Verify that after scrolling, points are genuinely visible in current viewport (fail closed, no blind clamp)
        const toViewport = (r: {
          x: number;
          y: number;
          isDocumentSpace?: boolean;
        }): Coordinates | null => {
          if (!r.isDocumentSpace) return { x: r.x, y: r.y };
          const vx = Math.round(r.x - curScrollX);
          const vy = Math.round(r.y - curScrollY);
          if (vx < 0 || vx >= vw || vy < 0 || vy >= vh) {
            return null;
          }
          return { x: vx, y: vy };
        };

        const p1 = res1 ? toViewport(res1) : undefined;
        const p2 = res2 ? toViewport(res2) : undefined;

        if ((res1 && !p1) || (res2 && !p2)) {
          return {
            error: 'Target coordinates are outside viewport boundaries after scrolling',
          };
        }

        return { p1: p1 ?? undefined, p2: p2 ?? undefined };
      }

      return {
        p1: res1 ? { x: res1.x, y: res1.y } : undefined,
        p2: res2 ? { x: res2.x, y: res2.y } : undefined,
      };
    };

    // Helper to project coordinates (synchronous, for region/zoom or fallback; absolute CSS viewport, zero-offset)
    const project = (c?: any): Coordinates | undefined => {
      if (!c) return undefined;
      const parsed = parseUnifiedCoordinate(c, { originX: 0, originY: 0 });
      if (!parsed) return undefined;
      return { x: parsed.x, y: parsed.y };
    };

    switch (params.action) {
      case 'resize_page': {
        const width = Number((params as any).coordinates?.x || (params as any).text);
        const height = Number((params as any).coordinates?.y || (params as any).value);
        const w = Number((params as any).width ?? width);
        const h = Number((params as any).height ?? height);
        if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
          return createErrorResponse('Provide width and height for resize_page (positive numbers)');
        }
        try {
          // Prefer precise CDP emulation
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            await CDPHelper.send(tabId, 'Emulation.setDeviceMetricsOverride', {
              width: Math.round(w),
              height: Math.round(h),
              deviceScaleFactor: 0,
              mobile: false,
              screenWidth: Math.round(w),
              screenHeight: Math.round(h),
            });
          });
        } catch (e) {
          // Fallback: window resize
          if (tab.windowId !== undefined) {
            await chrome.windows.update(tab.windowId, {
              width: Math.round(w),
              height: Math.round(h),
            });
          } else {
            return createErrorResponse(
              `Failed to resize via CDP and cannot determine windowId: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, action: 'resize_page', width: w, height: h }),
            },
          ],
          isError: false,
        };
      }
      case 'hover': {
        // Resolve target point from ref | selector | coordinates
        let coord: Coordinates | undefined = undefined;
        let resolvedBy: 'ref' | 'selector' | 'coordinates' | undefined;

        try {
          if (params.ref) {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            // Scroll element into view first to ensure it's visible
            try {
              await this.sendMessageToTab(tab.id, { action: 'focusByRef', ref: params.ref });
            } catch {
              // Best effort - continue even if scroll fails
            }
            // Re-resolve coordinates after scroll
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.ref,
            });
            if (resolved && resolved.success) {
              coord = { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
              resolvedBy = 'ref';
            }
          } else if (params.selector) {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            const selectorType = params.selectorType || 'css';
            const ensured = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
              selector: params.selector,
              isXPath: selectorType === 'xpath',
            });
            if (ensured && ensured.success) {
              // Scroll element into view first to ensure it's visible
              const resolvedRef = typeof ensured.ref === 'string' ? ensured.ref : undefined;
              if (resolvedRef) {
                try {
                  await this.sendMessageToTab(tab.id, { action: 'focusByRef', ref: resolvedRef });
                } catch {
                  // Best effort - continue even if scroll fails
                }
                // Re-resolve coordinates after scroll
                const reResolved = await this.sendMessageToTab(tab.id, {
                  action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
                  ref: resolvedRef,
                });
                if (reResolved && reResolved.success) {
                  coord = {
                    x: Math.round(reResolved.center.x),
                    y: Math.round(reResolved.center.y),
                  };
                } else {
                  coord = { x: Math.round(ensured.center.x), y: Math.round(ensured.center.y) };
                }
              } else {
                coord = { x: Math.round(ensured.center.x), y: Math.round(ensured.center.y) };
              }
              resolvedBy = 'selector';
            }
          } else if (params.coordinates) {
            const pr = await projectCoords(params.coordinates);
            if (pr.error) return createErrorResponse(pr.error);
            coord = pr.p1;
            resolvedBy = 'coordinates';
          }
        } catch (e) {
          // fall through to error handling below
        }

        if (coord && params.autoSnap !== false && resolvedBy === 'coordinates') {
          try {
            const snap = (
              await executeInPage({ tabId }, 'inPageSnapCoordinate', [coord.x, coord.y, 24])
            )?.[0]?.result;
            if (snap?.snapped) {
              coord = { x: snap.x, y: snap.y };
            }
          } catch {}
        }

        if (!coord)
          return createErrorResponse(
            'Provide ref or selector or coordinates for hover, or failed to resolve target',
          );
        {
          const stale = params.coordinates
            ? screenshotOriginViolation(tab.id!, tab.url, 'hover')
            : null;
          if (stale) return createErrorResponse(stale);
        }

        try {
          // Animate virtual agent cursor before physical hover
          await animateAgentCursor(tabId, coord.x, coord.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: 'Hovering',
          });
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            // Move pointer to target. We can dispatch a single mouseMoved; browsers will generate mouseover/mouseenter as needed.
            await CDPHelper.dispatchMouseEvent(tabId, {
              type: 'mouseMoved',
              x: coord.x,
              y: coord.y,
              button: 'none',
              buttons: 0,
            });
          });

          // Optional hold to allow UI (menus/tooltips) to appear
          const holdMs = Math.max(
            0,
            Math.min(params.duration ? params.duration * 1000 : 400, 5000),
          );
          if (holdMs > 0) await new Promise((r) => setTimeout(r, holdMs));

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  coordinates: coord,
                  resolvedBy,
                  transport: 'cdp',
                }),
              },
            ],
            isError: false,
          };
        } catch (error) {
          console.warn('[ComputerTool] CDP hover failed, attempting DOM fallback', error);
          return await this.domHoverFallback(tab.id, coord, resolvedBy, params.ref);
        }
      }
      case 'left_click':
      case 'right_click': {
        // Calculate CDP modifier mask for click events
        const modifiersMask = CDPHelper.modifierMask(
          [
            params.modifiers?.altKey ? 'alt' : undefined,
            params.modifiers?.ctrlKey ? 'ctrl' : undefined,
            params.modifiers?.metaKey ? 'meta' : undefined,
            params.modifiers?.shiftKey ? 'shift' : undefined,
          ].filter((v): v is string => typeof v === 'string'),
        );

        if (params.ref) {
          // Prefer DOM click via ref
          const domResult = await clickTool.execute({
            ref: params.ref,
            waitForNavigation: false,
            timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            button: params.action === 'right_click' ? 'right' : 'left',
            modifiers: params.modifiers,
            tabId,
            windowId: targetWindowId,
            sessionId: targetSessionId,
          });
          return domResult;
        }
        if (params.selector) {
          // Support selector-based click
          const domResult = await clickTool.execute({
            selector: params.selector,
            selectorType: params.selectorType,
            frameId: params.frameId,
            waitForNavigation: false,
            timeout: TIMEOUTS.DEFAULT_WAIT * 5,
            button: params.action === 'right_click' ? 'right' : 'left',
            modifiers: params.modifiers,
            tabId,
            windowId: targetWindowId,
            sessionId: targetSessionId,
          });
          return domResult;
        }
        if (!params.coordinates)
          return createErrorResponse('Provide ref, selector, or coordinates for click action');

        const pr = await projectCoords(params.coordinates);
        if (pr.error || !pr.p1) {
          return createErrorResponse(pr.error || 'Failed to resolve coordinates');
        }
        let coord = pr.p1;
        let autoSnapResult: { snapped: boolean; targetTag?: string; distance?: number } | undefined;
        if (params.autoSnap !== false) {
          try {
            const snap = (
              await executeInPage({ tabId }, 'inPageSnapCoordinate', [coord.x, coord.y, 24])
            )?.[0]?.result;
            if (snap?.snapped) {
              autoSnapResult = {
                snapped: true,
                targetTag: snap.targetTag,
                distance: snap.distance,
              };
              coord = { x: snap.x, y: snap.y };
            }
          } catch {}
        }
        // Direct native CDP mouse event dispatch for coordinate clicks (isTrusted: true)
        try {
          const clickNote = params.action === 'right_click' ? 'Right click' : 'Click';
          await animateAgentCursor(tabId, coord.x, coord.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: clickNote,
          });
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            const button: MouseButton = params.action === 'right_click' ? 'right' : 'left';
            const clickCount = 1;
            await CDPHelper.dispatchMouseEvent(tabId, {
              type: 'mouseMoved',
              x: coord.x,
              y: coord.y,
              button: 'none',
              buttons: 0,
              modifiers: modifiersMask,
            });
            await animateAgentCursorClick(tabId, coord.x, coord.y, clickNote);
            for (let i = 1; i <= clickCount; i++) {
              const guard = createMousePressGuard(
                (eventParams) => CDPHelper.dispatchMouseEvent(tabId, eventParams),
                {
                  type: 'mouseReleased',
                  x: coord.x,
                  y: coord.y,
                  button,
                  buttons: 0,
                  clickCount: i,
                  modifiers: modifiersMask,
                },
              );
              try {
                await guard.press({
                  type: 'mousePressed',
                  x: coord.x,
                  y: coord.y,
                  button,
                  buttons: button === 'left' ? 1 : 2,
                  clickCount: i,
                  modifiers: modifiersMask,
                });
                await dwell(params.dwellMs);
                await guard.release();
              } finally {
                await guard.compensate();
              }
            }
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: params.action,
                  coordinates: coord,
                  ...(autoSnapResult ? { autoSnap: autoSnapResult } : {}),
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(
            `CDP click failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'double_click':
      case 'triple_click': {
        // Calculate CDP modifier mask for click events
        const modifiersMask = CDPHelper.modifierMask(
          [
            params.modifiers?.altKey ? 'alt' : undefined,
            params.modifiers?.ctrlKey ? 'ctrl' : undefined,
            params.modifiers?.metaKey ? 'meta' : undefined,
            params.modifiers?.shiftKey ? 'shift' : undefined,
          ].filter((v): v is string => typeof v === 'string'),
        );

        if (!params.coordinates && !params.ref && !params.selector)
          return createErrorResponse(
            'Provide ref, selector, or coordinates for double/triple click',
          );
        let coord = undefined as any;
        if (params.coordinates) {
          const pr = await projectCoords(params.coordinates);
          if (pr.error || !pr.p1)
            return createErrorResponse(pr.error || 'Failed to resolve coordinates');
          coord = pr.p1;
        }
        // If ref is provided, resolve center via accessibility helper
        if (params.ref) {
          try {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.ref,
            });
            if (resolved && resolved.success) {
              coord = { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
            }
          } catch (e) {
            // ignore and use provided coordinates
          }
        } else if (params.selector) {
          // Support selector-based click
          try {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            const selectorType = params.selectorType || 'css';
            const ensured = await this.sendMessageToTab(
              tab.id,
              {
                action: TOOL_MESSAGE_TYPES.ENSURE_REF_FOR_SELECTOR,
                selector: params.selector,
                isXPath: selectorType === 'xpath',
              },
              params.frameId,
            );
            if (ensured && ensured.success) {
              coord = { x: Math.round(ensured.center.x), y: Math.round(ensured.center.y) };
            }
          } catch (e) {
            // ignore
          }
        }
        if (!coord) return createErrorResponse('Failed to resolve coordinates from ref/selector');

        let doubleSnapResult:
          { snapped: boolean; targetTag?: string; distance?: number } | undefined;
        if (params.coordinates && params.autoSnap !== false && coord) {
          try {
            const snap = (
              await executeInPage({ tabId }, 'inPageSnapCoordinate', [coord.x, coord.y, 24])
            )?.[0]?.result;
            if (snap?.snapped) {
              doubleSnapResult = {
                snapped: true,
                targetTag: snap.targetTag,
                distance: snap.distance,
              };
              coord = { x: snap.x, y: snap.y };
            }
          } catch {}
        }

        {
          const stale = params.coordinates
            ? screenshotOriginViolation(tab.id!, tab.url, params.action)
            : null;
          if (stale) return createErrorResponse(stale);
        }
        try {
          const clickNote = params.action === 'double_click' ? 'Double click' : 'Triple click';
          await animateAgentCursor(tabId, coord.x, coord.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: clickNote,
          });
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            const button: MouseButton = 'left';
            const clickCount = params.action === 'double_click' ? 2 : 3;
            await CDPHelper.dispatchMouseEvent(tabId, {
              type: 'mouseMoved',
              x: coord.x,
              y: coord.y,
              button: 'none',
              buttons: 0,
              modifiers: modifiersMask,
            });
            for (let i = 1; i <= clickCount; i++) {
              await animateAgentCursorClick(tabId, coord.x, coord.y, clickNote);
              const guard = createMousePressGuard(
                (eventParams) => CDPHelper.dispatchMouseEvent(tabId, eventParams),
                {
                  type: 'mouseReleased',
                  x: coord.x,
                  y: coord.y,
                  button,
                  buttons: 0,
                  clickCount: i,
                  modifiers: modifiersMask,
                },
              );
              try {
                await guard.press({
                  type: 'mousePressed',
                  x: coord.x,
                  y: coord.y,
                  button,
                  buttons: 1,
                  clickCount: i,
                  modifiers: modifiersMask,
                });
                await new Promise((r) => setTimeout(r, 35));
                await guard.release();
              } finally {
                await guard.compensate();
              }
              if (i < clickCount) {
                await new Promise((r) => setTimeout(r, 50));
              }
            }
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: params.action,
                  coordinates: coord,
                  ...(doubleSnapResult ? { autoSnap: doubleSnapResult } : {}),
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(
            `CDP ${params.action} failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'left_click_drag': {
        if (!params.startCoordinates && !params.startRef)
          return createErrorResponse('Provide startRef or startCoordinates for drag');
        if (!params.coordinates && !params.ref)
          return createErrorResponse('Provide ref or end coordinates for drag');
        let start: Coordinates | undefined;
        let end: Coordinates | undefined;

        if (params.startCoordinates || params.coordinates) {
          const pr = await projectCoords(params.startCoordinates, params.coordinates);
          if (pr.error) return createErrorResponse(pr.error);
          start = pr.p1;
          end = pr.p2;
        }
        if (params.startRef || params.ref) {
          await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
        }
        if (params.startRef) {
          try {
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.startRef,
            });
            if (resolved && resolved.success)
              start = { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
          } catch {
            // ignore
          }
        } else if (params.autoSnap !== false && start) {
          try {
            const snap = (
              await executeInPage({ tabId }, 'inPageSnapCoordinate', [start.x, start.y, 24])
            )?.[0]?.result;
            if (snap?.snapped) {
              start = { x: snap.x, y: snap.y };
            }
          } catch {}
        }
        if (params.ref) {
          try {
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.ref,
            });
            if (resolved && resolved.success)
              end = { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
          } catch {
            // ignore
          }
        }
        if (!start || !end) return createErrorResponse('Failed to resolve drag coordinates');
        try {
          const dragNote = 'Dragging';
          await animateAgentCursor(tabId, start.x, start.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: dragNote,
          });
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            // 1. Move to start position
            await CDPHelper.dispatchMouseEvent(tabId, {
              type: 'mouseMoved',
              x: start.x,
              y: start.y,
              button: 'none',
              buttons: 0,
            });
            await new Promise((r) => setTimeout(r, 100));

            // 2. Mouse press and hold for 200ms physical delay to trigger HTML5 dragstart
            const dragGuard = createMousePressGuard(
              (eventParams) => CDPHelper.dispatchMouseEvent(tabId, eventParams),
              {
                type: 'mouseReleased',
                x: end.x,
                y: end.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
              },
            );
            try {
              await dragGuard.press({
                type: 'mousePressed',
                x: start.x,
                y: start.y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
              });
              await new Promise((r) => setTimeout(r, 200));

              // Launch visual cursor glide towards drop destination concurrently with physical trajectory
              const cursorDragArrivalPromise = animateAgentCursor(tabId, end.x, end.y, {
                waitForArrival: true,
                timeoutMs: 350,
                actionNote: dragNote,
              });

              // 3. Move along trajectory with intermediate steps so drag and dragover events fire
              const dragSteps = 5;
              for (let i = 1; i <= dragSteps; i++) {
                const curX = Math.round(start.x + (end.x - start.x) * (i / dragSteps));
                const curY = Math.round(start.y + (end.y - start.y) * (i / dragSteps));
                await CDPHelper.dispatchMouseEvent(tabId, {
                  type: 'mouseMoved',
                  x: curX,
                  y: curY,
                  button: 'left',
                  buttons: 1,
                });
                await new Promise((r) => setTimeout(r, 50));
              }

              // Ensure visual cursor has arrived at drop destination before releasing
              await cursorDragArrivalPromise;

              // 4. Physical hover pause at destination (300ms) ensuring drop target processes dragover
              await new Promise((r) => setTimeout(r, 300));

              // 5. Release mouse at end position to trigger drop event
              await dragGuard.release();

              // 6. Settle delay after drop (500ms) ensuring UI framework state reconciliation
              await new Promise((r) => setTimeout(r, 500));
            } finally {
              await dragGuard.compensate();
            }
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'left_click_drag', start, end }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(`Drag failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case 'scroll': {
        if (!params.coordinates && !params.ref)
          return createErrorResponse('Provide ref or coordinates for scroll');
        let coord = undefined as any;
        if (params.coordinates) {
          const pr = await projectCoords(params.coordinates);
          if (pr.error || !pr.p1)
            return createErrorResponse(pr.error || 'Failed to resolve coordinates');
          coord = pr.p1;
        }
        if (params.ref) {
          try {
            await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
            const resolved = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.RESOLVE_REF,
              ref: params.ref,
            });
            if (resolved && resolved.success)
              coord = { x: Math.round(resolved.center.x), y: Math.round(resolved.center.y) };
          } catch {
            // ignore
          }
        }
        if (!coord) return createErrorResponse('Failed to resolve scroll coordinates');
        {
          const stale = params.coordinates
            ? screenshotOriginViolation(tab.id!, tab.url, 'scroll')
            : null;
          if (stale) return createErrorResponse(stale);
        }
        const direction = params.scrollDirection || 'down';
        const amount = Math.max(1, Math.min(params.scrollAmount || 3, 10));
        // Convert to deltas (~100px per tick)
        const unit = 100;
        let deltaX = 0,
          deltaY = 0;
        if (direction === 'up') deltaY = -amount * unit;
        if (direction === 'down') deltaY = amount * unit;
        if (direction === 'left') deltaX = -amount * unit;
        if (direction === 'right') deltaX = amount * unit;
        try {
          await animateAgentCursor(tabId, coord.x, coord.y, {
            waitForArrival: true,
            timeoutMs: 350,
            actionNote: `Scrolling ${direction}`,
          });
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            const STEPS = 8;
            let lastRatio = 0;
            for (let s = 1; s <= STEPS; s++) {
              const ratio = 0.5 * (1 - Math.cos((Math.PI * s) / STEPS));
              const slice = ratio - lastRatio;
              lastRatio = ratio;
              const stepX = Math.round(deltaX * slice);
              const stepY = Math.round(deltaY * slice);
              await CDPHelper.dispatchMouseEvent(tabId, {
                type: 'mouseWheel',
                x: coord.x,
                y: coord.y,
                deltaX: stepX,
                deltaY: stepY,
              });
              if (s < STEPS) await new Promise((r) => setTimeout(r, 16));
            }
            await new Promise((r) => setTimeout(r, 60));
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'scroll',
                  coordinates: coord,
                  deltaX,
                  deltaY,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(
            `Scroll failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'type': {
        if (!params.text) return createErrorResponse('Text parameter is required for type action');
        try {
          const typeNote = `Typing "${params.text.length > 18 ? params.text.slice(0, 15) + '...' : params.text}"`;
          await setAgentCursorNote(tabId, typeNote);
          // Optional focus via ref before typing
          if (params.ref) {
            await clickTool.execute({
              ref: params.ref,
              waitForNavigation: false,
              timeout: TIMEOUTS.DEFAULT_WAIT * 5,
              tabId,
              windowId: targetWindowId,
              sessionId: targetSessionId,
            });
          }
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            // Use CDP insertText to avoid complex KeyboardEvent emulation for long text
            await CDPHelper.insertText(tabId, params.text!);
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'type',
                  length: params.text.length,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          if (isCdpOutcomeUncertainError(e)) {
            // The text may already have been inserted; retrying it through the
            // DOM keyboard tool would type it twice.
            return createErrorResponse(
              `Type action outcome unknown: ${e instanceof Error ? e.message : String(e)}; the text may already be inserted, not retrying via DOM keyboard fallback`,
            );
          }
          // Fallback to DOM-based keyboard tool
          const res = await keyboardTool.execute({
            keys: params.text.split('').join(','),
            delay: 0,
            selector: undefined,
            tabId,
            windowId: targetWindowId,
            sessionId: targetSessionId,
          });
          return res;
        }
      }
      case 'fill': {
        if (!params.ref && !params.selector) {
          return createErrorResponse('Provide ref or selector and a value for fill');
        }
        // Reuse existing fill tool to leverage robust DOM event behavior
        const res = await fillTool.execute({
          selector: params.selector as any,
          selectorType: params.selectorType as any,
          ref: params.ref as any,
          value: params.value as any,
          tabId,
          windowId: targetWindowId,
          sessionId: targetSessionId,
        } as any);
        return res;
      }
      case 'fill_form': {
        const elements = (params as any).elements as Array<{
          ref: string;
          value: string | number | boolean;
        }>;
        if (!Array.isArray(elements) || elements.length === 0) {
          return createErrorResponse('elements must be a non-empty array for fill_form');
        }
        const results: Array<{ ref: string; ok: boolean; error?: string }> = [];
        for (const item of elements) {
          if (!item || !item.ref) {
            results.push({ ref: String(item?.ref || ''), ok: false, error: 'missing ref' });
            continue;
          }
          try {
            const r = await fillTool.execute({
              ref: item.ref as any,
              value: item.value as any,
              tabId,
              windowId: targetWindowId,
              sessionId: targetSessionId,
            } as any);
            let innerOk = false;
            let errMsg: string | undefined;
            if (!r.isError && Array.isArray(r.content) && r.content[0]?.type === 'text') {
              try {
                const parsed = JSON.parse(r.content[0].text);
                if (parsed && typeof parsed === 'object') {
                  innerOk = parsed.success !== false;
                  if (!innerOk) errMsg = parsed.error || parsed.message || 'failed';
                } else {
                  innerOk = true;
                }
              } catch {
                innerOk = true;
              }
            }
            const ok = !r.isError && innerOk;
            if (!ok && !errMsg) {
              errMsg =
                r.isError && Array.isArray(r.content) && r.content[0]?.type === 'text'
                  ? r.content[0].text
                  : 'failed';
            }
            results.push({
              ref: item.ref,
              ok,
              error: ok ? undefined : errMsg,
            });
          } catch (e) {
            results.push({
              ref: item.ref,
              ok: false,
              error: String(e instanceof Error ? e.message : e),
            });
          }
        }
        const successCount = results.filter((r) => r.ok).length;
        const allFailed = results.length > 0 && successCount === 0;
        const isPartial = successCount > 0 && successCount < results.length;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: !allFailed,
                partial: isPartial,
                action: 'fill_form',
                filled: successCount,
                total: results.length,
                results,
              }),
            },
          ],
          isError: allFailed,
        };
      }
      case 'key': {
        if (!params.text)
          return createErrorResponse(
            'text is required for key action (e.g., "Backspace Backspace Enter" or "cmd+a")',
          );
        const tokens = params.text.trim().split(/\s+/).filter(Boolean);
        const repeat = params.repeat ?? 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) {
          return createErrorResponse('repeat must be an integer between 1 and 100 for key action');
        }
        try {
          const keyNote = `Pressing ${tokens.slice(0, 3).join(' ')}${tokens.length > 3 ? '...' : ''}`;
          await setAgentCursorNote(tabId, keyNote);
          // Optional focus via ref before key events
          if (params.ref) {
            await clickTool.execute({
              ref: params.ref,
              waitForNavigation: false,
              timeout: TIMEOUTS.DEFAULT_WAIT * 5,
              tabId,
              windowId: targetWindowId,
              sessionId: targetSessionId,
            });
          }
          await cdpSessionManager.withSession(tabId, 'computer', async () => {
            for (let i = 0; i < repeat; i++) {
              for (const t of tokens) {
                if (t.includes('+')) await CDPHelper.dispatchKeyChord(tabId, t);
                else await CDPHelper.dispatchSimpleKey(tabId, t);
              }
            }
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'key', keys: tokens, repeat }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          if (isCdpOutcomeUncertainError(e)) {
            return createErrorResponse(
              `Key action outcome unknown: ${e instanceof Error ? e.message : String(e)}; the key event(s) may already be dispatched, not retrying via DOM keyboard fallback`,
            );
          }
          // Fallback to DOM keyboard simulation (comma-separated combinations)
          const keysStr = tokens.join(',');
          const repeatedKeys =
            repeat === 1 ? keysStr : Array.from({ length: repeat }, () => keysStr).join(',');
          const res = await keyboardTool.execute({
            keys: repeatedKeys,
            tabId,
            windowId: targetWindowId,
            sessionId: targetSessionId,
          });
          return res;
        }
      }
      case 'wait': {
        const hasTextCondition =
          typeof (params as any).text === 'string' && (params as any).text.trim().length > 0;
        if (hasTextCondition) {
          try {
            // Conditional wait for text appearance/disappearance using content script
            await this.injectContentScript(
              tab.id,
              ['inject-scripts/wait-helper.js'],
              false,
              'ISOLATED',
              true,
            );
            const appear = (params as any).appear !== false; // default to true
            const timeoutMs = Math.max(
              0,
              Math.min(((params as any).timeout as number) || 10000, 120000),
            );
            const resp = await this.sendMessageToTab(tab.id, {
              action: TOOL_MESSAGE_TYPES.WAIT_FOR_TEXT,
              text: (params as any).text,
              appear,
              timeout: timeoutMs,
            });
            if (!resp || resp.success !== true) {
              return createErrorResponse(
                resp && resp.reason === 'timeout'
                  ? `wait_for timed out after ${timeoutMs}ms for text: ${(params as any).text}`
                  : `wait_for failed: ${resp && resp.error ? resp.error : 'unknown error'}`,
              );
            }
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    success: true,
                    action: 'wait_for',
                    appear,
                    text: (params as any).text,
                    matched: resp.matched || null,
                    tookMs: resp.tookMs,
                  }),
                },
              ],
              isError: false,
            };
          } catch (e) {
            return createErrorResponse(
              `wait_for failed: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          const seconds = Math.max(0, Math.min((params as any).duration || 0, 30));
          if (!seconds)
            return createErrorResponse('Duration parameter is required and must be > 0');
          await new Promise((r) => setTimeout(r, seconds * 1000));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ success: true, action: 'wait', duration: seconds }),
              },
            ],
            isError: false,
          };
        }
      }
      case 'scroll_to': {
        if (!params.ref) {
          return createErrorResponse('ref is required for scroll_to action');
        }
        try {
          await this.injectContentScript(tab.id, ['inject-scripts/accessibility-tree-helper.js']);
          const resp = await this.sendMessageToTab(tab.id, {
            action: 'focusByRef',
            ref: params.ref,
          });
          if (!resp || resp.success !== true) {
            return createErrorResponse(resp?.error || 'scroll_to failed: element not found');
          }
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'scroll_to',
                  ref: params.ref,
                }),
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(
            `scroll_to failed: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      case 'zoom': {
        const region = params.region;
        if (!region) {
          return createErrorResponse('region is required for zoom action');
        }

        let p0: Coordinates | undefined;
        let p1: Coordinates | undefined;

        if (Array.isArray(region) && region.length === 4) {
          const [a, b, c, d] = region.map(Number);
          if (isNaN(a) || isNaN(b) || isNaN(c) || isNaN(d)) {
            return createErrorResponse(
              'Invalid region: all 4 bounding box coordinates must be numbers',
            );
          }

          const ctx = screenshotContextManager.getContext(tabId);
          const vw = Math.round(Number(ctx?.viewportWidth || 1280));
          const vh = Math.round(Number(ctx?.viewportHeight || 800));
          // Bounding-box regions are always in ABSOLUTE viewport CSS pixels.
          // Never rescale by a previous screenshot context and never add a
          // previous ROI origin — both compound across zooms (observed
          // runaway: 853 -> 2191 after two zooms). Normalized 0~1.0 and
          // 0~1000 forms below are the only relative interpretations.
          const ox = 0;
          const oy = 0;

          // Determine orientation: Row-first [ymin, xmin, ymax, xmax] vs Cartesian [xmin, ymin, xmax, ymax]
          let isYminFirst = true;
          if ((a > vh || c > vh) && a <= vw && c <= vw) {
            isYminFirst = false; // [xmin, ymin, xmax, ymax]
          } else if ((b > vh || d > vh) && b <= vw && d <= vw) {
            isYminFirst = true; // [ymin, xmin, ymax, xmax]
          }

          const rawYmin = isYminFirst ? Math.min(a, c) : Math.min(b, d);
          const rawYmax = isYminFirst ? Math.max(a, c) : Math.max(b, d);
          const rawXmin = isYminFirst ? Math.min(b, d) : Math.min(a, c);
          const rawXmax = isYminFirst ? Math.max(b, d) : Math.max(a, c);

          const maxVal = Math.max(a, b, c, d);
          let x0 = rawXmin;
          let x1 = rawXmax;
          let y0 = rawYmin;
          let y1 = rawYmax;

          if (maxVal <= 1.0 && maxVal > 0) {
            x0 = rawXmin * vw;
            x1 = rawXmax * vw;
            y0 = rawYmin * vh;
            y1 = rawYmax * vh;
          } else if (
            maxVal <= 1000 &&
            (rawYmax > vh || rawXmax > vw || (region as any).scale === '1000')
          ) {
            x0 = (rawXmin / 1000) * vw;
            x1 = (rawXmax / 1000) * vw;
            y0 = (rawYmin / 1000) * vh;
            y1 = (rawYmax / 1000) * vh;
          }

          p0 = { x: Math.round(x0 + ox), y: Math.round(y0 + oy) };
          p1 = { x: Math.round(x1 + ox), y: Math.round(y1 + oy) };
        } else if (typeof region === 'object' && region !== null) {
          const rawX0 = (region as any).x0 ?? (region as any).xmin ?? (region as any).left;
          const rawY0 = (region as any).y0 ?? (region as any).ymin ?? (region as any).top;
          const rawX1 =
            (region as any).x1 ??
            (region as any).xmax ??
            (typeof (region as any).width === 'number' ? rawX0 + (region as any).width : undefined);
          const rawY1 =
            (region as any).y1 ??
            (region as any).ymax ??
            (typeof (region as any).height === 'number'
              ? rawY0 + (region as any).height
              : undefined);
          if (
            rawX0 !== undefined &&
            rawY0 !== undefined &&
            rawX1 !== undefined &&
            rawY1 !== undefined
          ) {
            p0 = project({ x: Number(rawX0), y: Number(rawY0) }) || {
              x: Number(rawX0),
              y: Number(rawY0),
            };
            p1 = project({ x: Number(rawX1), y: Number(rawY1) }) || {
              x: Number(rawX1),
              y: Number(rawY1),
            };
          }
        }

        if (
          !p0 ||
          !p1 ||
          !Number.isFinite(p0.x) ||
          !Number.isFinite(p0.y) ||
          !Number.isFinite(p1.x) ||
          !Number.isFinite(p1.y)
        ) {
          return createErrorResponse(
            'Invalid region: require finite coordinates (x0/y0/x1/y1 or [ymin,xmin,ymax,xmax])',
          );
        }

        const rx0 = Math.min(p0.x, p1.x);
        const ry0 = Math.min(p0.y, p1.y);
        const rx1 = Math.max(p0.x, p1.x);
        const ry1 = Math.max(p0.y, p1.y);
        const w = rx1 - rx0;
        const h = ry1 - ry0;
        if (w <= 0 || h <= 0) {
          return createErrorResponse(
            'Invalid region after projection: width and height must be positive',
          );
        }

        const stale = screenshotOriginViolation(tabId, tab.url, 'zoom');
        if (stale) return createErrorResponse(stale);

        try {
          let vw = 800;
          let vh = 600;
          const shot: any = await cdpSessionManager.withSession(tabId, 'computer', async () => {
            const metrics: any = await CDPHelper.send(tabId, 'Page.getLayoutMetrics', {});
            const viewport = metrics?.layoutViewport ||
              metrics?.visualViewport || {
                clientWidth: 800,
                clientHeight: 600,
                pageX: 0,
                pageY: 0,
              };
            vw = Math.round(Number(viewport.clientWidth || 800));
            vh = Math.round(Number(viewport.clientHeight || 600));
            if (rx1 > vw || ry1 > vh) {
              throw new Error(
                `Region exceeds viewport boundaries (${vw}x${vh}). Choose a region within the visible viewport.`,
              );
            }
            const pageX = Number(viewport.pageX || 0);
            const pageY = Number(viewport.pageY || 0);

            return await CDPHelper.send(tabId, 'Page.captureScreenshot', {
              format: 'png',
              captureBeyondViewport: false,
              fromSurface: true,
              clip: {
                x: pageX + rx0,
                y: pageY + ry0,
                width: w,
                height: h,
                scale: 1,
              },
            });
          });

          const base64Data = String(shot?.data || '');
          if (!base64Data) {
            return createErrorResponse('Failed to capture zoom screenshot via CDP');
          }

          // Enforce DPR 1:1 Normalization: resample from physical pixels to exact CSS viewport dimensions
          let normalizedBase64 = base64Data;
          try {
            const normalizedDataUrl = await normalizeImageToCssDimensions(
              `data:image/png;base64,${base64Data}`,
              Math.round(w),
              Math.round(h),
              'image/png',
              1.0,
            );
            normalizedBase64 = normalizedDataUrl.replace(/^data:[^;]+;base64,/, '');

            if (params.grid) {
              const gridStyle = typeof params.grid === 'string' ? params.grid : 'crosshair';
              const griddedDataUrl = await overlayCoordinateGrid(
                normalizedDataUrl,
                1,
                50,
                'image/png',
                1.0,
                {
                  style:
                    gridStyle === 'classic'
                      ? 'classic'
                      : gridStyle === 'crosshair'
                        ? 'crosshair'
                        : 'ruler',
                  originX: rx0,
                  originY: ry0,
                  normalized1000: gridStyle === '1000',
                },
              );
              normalizedBase64 = griddedDataUrl.replace(/^data:[^;]+;base64,/, '');
            }
          } catch (normErr) {
            console.warn('Failed to normalize or overlay grid on zoom image:', normErr);
          }

          const currentHostname = ((): string => {
            try {
              return new URL(tab.url || '').hostname;
            } catch {
              return '';
            }
          })();

          // Update screenshot context with ROI crop origin so subsequent clicks map accurately to global page
          screenshotContextManager.setContext(tabId, {
            screenshotWidth: Math.round(w),
            screenshotHeight: Math.round(h),
            viewportWidth: vw,
            viewportHeight: vh,
            cropWidth: Math.round(w),
            cropHeight: Math.round(h),
            originX: rx0,
            originY: ry0,
            hostname: currentHostname,
          });

          // Save to ring buffer
          screenshotRingBuffer.push({
            tabId,
            mimeType: 'image/png',
            width: Math.round(w),
            height: Math.round(h),
            dataBase64: normalizedBase64,
          });

          let finalBase64 = normalizedBase64;
          let finalMimeType = 'image/png';
          let isThumbnail = false;
          let warning: string | undefined;

          // Anti-blinding safety budget: if payload exceeds 450KB, save to disk and return high-quality thumbnail
          if (finalBase64.length > 450 * 1024) {
            try {
              const compressed = await smartCompressForTransport(
                `data:image/png;base64,${finalBase64}`,
                {
                  maxBytes: 450 * 1024,
                  preferredFormat: 'image/webp',
                  quality: 0.82,
                },
              );
              finalBase64 = compressed.dataUrl.replace(/^data:[^;]+;base64,/, '');
              finalMimeType = compressed.mimeType;
              if (compressed.wasDownscaled) {
                isThumbnail = true;
                warning =
                  'Zoom screenshot payload exceeded 450KB safety budget. Full image saved to disk. High-quality preview thumbnail returned to maintain visual perception.';
                screenshotContextManager.setContext(tabId, {
                  screenshotWidth: compressed.width,
                  screenshotHeight: compressed.height,
                  viewportWidth: vw,
                  viewportHeight: vh,
                  cropWidth: Math.round(w),
                  cropHeight: Math.round(h),
                  originX: rx0,
                  originY: ry0,
                  hostname: currentHostname,
                });
              }
            } catch (thumbErr) {
              console.warn('Failed to generate preview thumbnail for zoom:', thumbErr);
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'zoom',
                  mimeType: finalMimeType,
                  region: { x0: rx0, y0: ry0, x1: rx1, y1: ry1 },
                  ...(isThumbnail ? { isThumbnail: true, warning } : {}),
                }),
              },
              {
                type: 'image',
                data: finalBase64,
                mimeType: finalMimeType,
              },
            ],
            isError: false,
          };
        } catch (e) {
          return createErrorResponse(`zoom failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case 'screenshot': {
        // Reuse existing screenshot tool; forward grid, region, crop, quality, highClarity
        const result = await screenshotTool.execute({
          name: 'computer',
          storeBase64: true,
          fullPage: false,
          tabId,
          grid: (params as any).grid,
          region: (params as any).region,
          crop: (params as any).crop,
          highClarity: (params as any).highClarity,
          quality: (params as any).quality,
          format: (params as any).format || 'webp',
          sessionId: params.sessionId || params.sessionContext,
        });
        return result;
      }
      default:
        return createErrorResponse(`Unsupported action: ${params.action}`);
    }
  }

  /**
   * DOM-based hover fallback when CDP is unavailable
   * Tries ref-based approach first (works with iframes), falls back to coordinates
   */
  private async domHoverFallback(
    tabId: number,
    coord?: Coordinates,
    resolvedBy?: 'ref' | 'selector' | 'coordinates',
    ref?: string,
  ): Promise<ToolResult> {
    // Try ref-based approach first (handles iframes correctly)
    if (ref) {
      try {
        const resp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.DISPATCH_HOVER_FOR_REF,
          ref,
        });
        if (resp?.success) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  action: 'hover',
                  resolvedBy: 'ref',
                  transport: 'dom-ref',
                  target: resp.target,
                }),
              },
            ],
            isError: false,
          };
        }
      } catch (error) {
        console.warn('[ComputerTool] DOM ref hover failed, falling back to coordinates', error);
      }
    }

    // Fallback to coordinate-based approach
    if (!coord) {
      return createErrorResponse('Hover fallback requires coordinates or ref');
    }

    try {
      const [injection] = await this.safeExecuteScript(tabId, {
        target: { tabId },
        world: 'MAIN',
        func: (point) => {
          const target = document.elementFromPoint(point.x, point.y);
          if (!target) {
            return { success: false, error: 'No element found at coordinates' };
          }

          // Dispatch hover-related events
          for (const type of ['mousemove', 'mouseover', 'mouseenter']) {
            target.dispatchEvent(
              new MouseEvent(type, {
                bubbles: true,
                cancelable: true,
                clientX: point.x,
                clientY: point.y,
                view: window,
              }),
            );
          }

          return {
            success: true,
            target: {
              tagName: target.tagName,
              id: target.id,
              className: target.className,
              text: target.textContent?.trim()?.slice(0, 100) || '',
            },
          };
        },
        args: [coord],
      });

      const payload = injection?.result;
      if (!payload?.success) {
        return createErrorResponse(payload?.error || 'DOM hover fallback failed');
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              action: 'hover',
              coordinates: coord,
              resolvedBy,
              transport: 'dom',
              target: payload.target,
            }),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `DOM hover fallback failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const computerTool = new ComputerTool();
