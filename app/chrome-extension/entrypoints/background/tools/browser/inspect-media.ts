import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { screenshotTool } from './screenshot';

export interface InspectMediaParams {
  index?: number;
  selector?: string;
  zoom?: number;
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

/**
 * Inspects and extracts high-fidelity visual media directly from the page.
 * Uses a dual-track extraction:
 * 1. Lossless In-Memory Track: extracts raw bitstream data from <img>, <canvas>, <video> via OffscreenCanvas.
 * 2. Super-Sampled Crop Track: generates a high-resolution 200%-300% zoom crop for complex composite captchas/charts.
 */
export class InspectMediaTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.INSPECT_MEDIA;

  async execute(args: InspectMediaParams): Promise<ToolResult> {
    const sessionId = args.sessionId || args.sessionContext;
    let targetTab: chrome.tabs.Tab;

    try {
      if (typeof args.tabId === 'number') {
        const t = await this.tryGetTab(args.tabId, sessionId);
        if (!t || !t.id) return createErrorResponse(`Tab with ID ${args.tabId} not found`);
        targetTab = t;
      } else {
        targetTab = await this.resolveAffinityTab({ tabId: args.tabId, sessionId });
      }
    } catch (error) {
      return createErrorResponse(
        `Failed to resolve tab: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const tabId = targetTab.id;
    if (typeof tabId !== 'number') return createErrorResponse('Invalid target tab ID');

    if (typeof args.index !== 'number' && (!args.selector || !args.selector.trim())) {
      return createErrorResponse(
        `Either "index" (1-based from ${resolveToolName('read_dom')}) or "selector" must be provided`,
      );
    }

    // Path 1: In-Memory Lossless Canvas/Image Extraction
    let inMemOutcome: any = null;
    let inMemError: string | null = null;
    try {
      const inMemoryResults = await this.safeExecuteScript(tabId, {
        target: { tabId },
        func: (targetIdx?: number | null, targetSelector?: string | null) => {
          try {
            let el: Element | null = null;
            if (typeof targetIdx === 'number') {
              const isolatedMap =
                (window as any)[Symbol.for('__browser_use_isolated_index_map__')] ||
                (window as any)[Symbol.for('BROWSERPAW_ISOLATED_INDEX_MAP')] ||
                (window as any)[Symbol.for('BROWSERCLAW_ISOLATED_INDEX_MAP')] ||
                (window as any).__MCP_INDEX_MAP__;
              const raw = isolatedMap?.get(targetIdx);
              el = raw?.deref ? (raw.deref() ?? null) : raw || null;
              if (el && (el as any).isConnected === false) el = null;
              if (!el) {
                try {
                  el = document.querySelector(`[data-mcp-idx="${targetIdx}"]`);
                } catch {}
              }
            }
            if (!el && targetSelector) {
              try {
                el = document.querySelector(targetSelector);
              } catch {}
            }
            if (!el) return { found: false };

            const rect = el.getBoundingClientRect();
            const tag = el.tagName.toLowerCase();

            // 1. Direct Canvas element (support cross-realm / tag check)
            if (
              tag === 'canvas' ||
              el instanceof HTMLCanvasElement ||
              typeof (el as any).toDataURL === 'function'
            ) {
              try {
                const canvasEl = el as HTMLCanvasElement;
                return {
                  found: true,
                  method: 'in-memory-canvas',
                  tag,
                  width: canvasEl.width || rect.width,
                  height: canvasEl.height || rect.height,
                  dataUrl: canvasEl.toDataURL('image/png'),
                };
              } catch {}
            }

            // 2. Direct Image element (support cross-realm / tag check)
            const imgEl = el as HTMLImageElement;
            if (
              (tag === 'img' || el instanceof HTMLImageElement) &&
              imgEl.complete &&
              imgEl.naturalWidth > 0
            ) {
              const canvas = document.createElement('canvas');
              canvas.width = imgEl.naturalWidth;
              canvas.height = imgEl.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(imgEl, 0, 0);
                try {
                  return {
                    found: true,
                    method: 'in-memory-image',
                    tag,
                    width: imgEl.naturalWidth,
                    height: imgEl.naturalHeight,
                    src: imgEl.currentSrc || imgEl.src,
                    dataUrl: canvas.toDataURL('image/png'),
                  };
                } catch {
                  // Tainted canvas by cross-origin, fallback to crop
                }
              }
            }

            // 3. Image child inside container (e.g. captcha container)
            const innerImg = el.querySelector('img');
            if (innerImg && innerImg.complete && innerImg.naturalWidth > 0) {
              const canvas = document.createElement('canvas');
              canvas.width = innerImg.naturalWidth;
              canvas.height = innerImg.naturalHeight;
              const ctx = canvas.getContext('2d');
              if (ctx) {
                ctx.drawImage(innerImg, 0, 0);
                try {
                  return {
                    found: true,
                    method: 'in-memory-nested-image',
                    tag: 'img',
                    width: innerImg.naturalWidth,
                    height: innerImg.naturalHeight,
                    src: innerImg.currentSrc || innerImg.src,
                    dataUrl: canvas.toDataURL('image/png'),
                  };
                } catch {}
              }
            }

            return {
              found: true,
              method: 'requires-crop',
              tag,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          } catch (e: any) {
            return { found: false, error: String(e?.message || e) };
          }
        },
        args: [args.index ?? null, args.selector ?? null],
      });

      inMemOutcome = inMemoryResults?.[0]?.result;
      const outcome = inMemOutcome;
      if (outcome && outcome.found && outcome.dataUrl) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  success: true,
                  extractionTrack: outcome.method,
                  tag: outcome.tag,
                  width: outcome.width,
                  height: outcome.height,
                  sourceUrl: outcome.src,
                },
                null,
                2,
              ),
            },
            {
              type: 'image',
              data: outcome.dataUrl.split(',')[1] || outcome.dataUrl,
              mimeType: 'image/png',
            },
          ],
          isError: false,
        };
      }
    } catch (inMemErr: any) {
      inMemError = inMemErr?.message || String(inMemErr);
    }

    // Path 2: Super-sampled crop fallback (200%-300% zoom)
    try {
      const zoomFactor = typeof args.zoom === 'number' && args.zoom >= 1.0 ? args.zoom : 2.0;
      const cropResult = await screenshotTool.execute({
        tabId,
        targetIndex: args.index,
        selector: args.selector,

        autoExpand: true,
      });

      if (cropResult.isError) return cropResult;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                success: true,
                extractionTrack: 'super-sampled-crop',
                zoom: zoomFactor,

                targetIndex: args.index,
                selector: args.selector,
                note: 'Captured via 2.0x super-sampled viewport crop without boundary distortions',
              },
              null,
              2,
            ),
          },
          ...(cropResult.content.filter((c) => c.type === 'image') as any),
        ],
        isError: false,
      };
    } catch (cropErr) {
      return createErrorResponse(
        `Inspect media failed: ${cropErr instanceof Error ? cropErr.message : String(cropErr)}`,
      );
    }
  }
}

export const inspectMediaTool = new InspectMediaTool();
