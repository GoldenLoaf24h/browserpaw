import { tabFaviconManager } from './tab-favicon';
import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import {
  TOOL_NAMES,
  resolveToolName,
  type PrunedDOMTreeResult,
  type IndexedElement,
} from 'chrome-mcp-shared';
import { executeInPage } from './in-page-engine';
import { snapshotCacheManager } from '@/utils/snapshot-cache-manager';
import { renderCompactElementLine } from './dom-indexer';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { scrubUrl } from '@/utils/url-sanitizer';

export interface ReadDOMParams {
  viewportThreshold?: number;
  tabId?: number;
  windowId?: number;
  highlight?: boolean;
  sessionId?: string;
  sessionContext?: string;
  cursor?: number;
  limit?: number;
  deltaOnly?: boolean;
  maxTextLength?: number;
  format?: 'compact' | 'html' | 'fast';
  fast?: boolean;
  legacyVisibility?: boolean;
  viewportOnly?: boolean;
  activeViewportOnly?: boolean;
  /**
   * CSS selector to scope parsing to a specific container/element (e.g. "#main-cart").
   * Only descendants and self within matching containers are indexed.
   */
  selector?: string;
  /**
   * Alias for selector. CSS selector to scope parsing to a specific container/element.
   */
  scope?: string;
  /**
   * CSS selector(s) to exclude from parsing (e.g. "#footer, #recommendations, .ad-banner").
   * Matching elements and their entire subtrees are pruned.
   */
  exclude?: string | string[];
  /**
   * Opt in to the bulky per-element detail blocks (indexedElements + indexMap).
   * Off by default: the pruned tree already carries index/tag/attributes/text
   * for every element, and the detail blocks duplicated it as pretty-printed
   * JSON — roughly 7x the payload for the same information. Only request them
   * when you need geometry (rect/safeClickPoint) or per-element flags.
   */
  includeDetails?: boolean;
  /**
   * When true and an active modal is detected, prunes background page elements
   * and scopes indexing to the active modal while protecting portals, dropdowns, and alerts.
   */
  isolateModal?: boolean;
  /**
   * When true, automatically detects and dismisses visible marketing popups, coupon modals,
   * and promotional overlays before indexing DOM nodes (default: false).
   */
  dismissOverlays?: boolean;
  /**
   * When true (default on long/feed/waterfall pages without selector), virtualizes and folds
   * repetitive offscreen subtrees into concise summaries to slash token overhead.
   */
  virtualizeViewport?: boolean;
  /**
   * When true (default: true), identifies composite card containers (article, [role="article"],
   * [role="listitem"], li) and aggregates fragmented leaf text nodes into unified structured card summaries.
   */
  flattenCards?: boolean;
}

export class ReadDOMTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.READ_DOM;

  async execute(args: ReadDOMParams = {}): Promise<ToolResult> {
    try {
      const tab = await this.resolveAffinityTab({
        tabId: args.tabId,
        windowId: args.windowId,
        sessionId: args.sessionId || args.sessionContext,
      });
      if (!tab.id) {
        return createErrorResponse(`No active tab found for ${resolveToolName('read_dom')}`);
      }
      tabFaviconManager.markTabActive(tab.id);

      if (args.dismissOverlays) {
        try {
          const dismissRes = await executeInPage({ tabId: tab.id }, 'inPageDismissOverlays', []);
          const count = dismissRes?.[0]?.result?.dismissedCount ?? 0;
          if (count > 0) {
            await waitForPageSettle(tab.id, { timeoutMs: 500 }).catch(() => {});
          } else {
            await new Promise((r) => setTimeout(r, 100));
          }
        } catch {}
      }

      // Fast Snapshot Engine branch (Phase F1: 10-30ms, <=15KB, WeakMap caching)
      if (args.fast || args.format === 'fast') {
        const snapRes = await executeInPage({ tabId: tab.id }, 'inPageFastSnapshot', [
          { legacyVisibility: args.legacyVisibility },
        ]);
        const fastData = snapRes?.[0]?.result as any;
        if (fastData?.isErrorPage) {
          const pageUrl = scrubUrl(tab.url || '');
          return {
            content: [
              {
                type: 'text',
                text: [
                  `## ⚠️ Browser Navigation / Network Error`,
                  ``,
                  `The page at **${pageUrl || 'unknown URL'}** failed to load and is displaying Chrome's native error page (\`chrome-error://chromewebdata/\`).`,
                  ``,
                  `- **Reason**: ${fastData?.error || 'Frame is showing error page'}`,
                  `- **Status**: Network unreachable, DNS failure, or page crashed.`,
                  ``,
                  `*Tip: Please check the URL, network connection, or try navigating to a valid address using \`${resolveToolName('navigate')}\`.*`,
                ].join('\n'),
              },
            ],
            isError: false,
          };
        }
        if (!fastData) {
          return createErrorResponse('Failed to execute fast DOM snapshot');
        }

        const snapshotElements = (fastData.actions || []).map((a: any, idx: number) => {
          const actionText = a.label || a.name || '';
          const rect = a.rect
            ? {
                x: a.rect.x ?? 0,
                y: a.rect.y ?? 0,
                width: a.rect.w ?? a.rect.width ?? 0,
                height: a.rect.h ?? a.rect.height ?? 0,
              }
            : { x: 0, y: 0, width: 0, height: 0 };
          return {
            index: idx + 1,
            tagName: a.role || a.kind || 'element',
            isInteractive: true,
            attributes: {
              role: a.role,
              name: actionText,
              id: a.id,
              // The fast snapshot already carries the live control value; without it a caller
              // cannot tell a filled field from an empty one, so a completed fill looks
              // unperformed and gets repeated until the run reports itself stuck.
              ...(a.kind === 'fill' && typeof a.value === 'string' && a.value !== ''
                ? { value: a.value }
                : {}),
              ...(a.current_value ? { current_value: a.current_value } : {}),
            },
            text: actionText,
            rect,
          };
        });

        const snapshot = snapshotCacheManager.setSnapshot(tab.id, {
          url: scrubUrl(tab.url || fastData.url),
          elementCount: snapshotElements.length,
          elements: snapshotElements,
          representation: 'fast',
        });

        const treeString = snapshotElements
          .map((e: any) => {
            const valuePart = e.attributes?.value ? ` value="${e.attributes.value}"` : '';
            return `[${e.index}] ${e.tagName}${e.text ? ' "' + e.text + '"' : ''}${valuePart}`;
          })
          .join('\n');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                ...fastData,
                url: scrubUrl(fastData.url || tab.url || ''),
                snapshotId: snapshot.snapshotId,
                treeString,
              }),
            },
          ],
          isError: false,
        };
      }

      const effectiveSelector = args.scope || args.selector;
      const prunerOpts = {
        viewportThreshold: args.viewportThreshold ?? 1000,
        highlight: args.highlight ?? false,
        maxTextLength: args.maxTextLength,
        format: args.format ?? 'compact',
        viewportOnly: args.viewportOnly,
        activeViewportOnly: args.activeViewportOnly,
        selector: effectiveSelector,
        scope: args.scope,
        exclude: args.exclude,
        isolateModal: args.isolateModal,
        virtualizeViewport: args.virtualizeViewport,
        flattenCards: args.flattenCards,
      };

      let results: chrome.scripting.InjectionResult<PrunedDOMTreeResult>[] = [];
      try {
        // Multi-frame penetration using Chrome Extension native { allFrames: true }
        results = await executeInPage({ tabId: tab.id, allFrames: true }, 'inPageDOMPruner', [
          prunerOpts,
        ]);
      } catch (frameErr) {
        // Fallback to main frame only if allFrames fails
        results = await executeInPage({ tabId: tab.id }, 'inPageDOMPruner', [prunerOpts]);
      }

      if (!results || results.length === 0) {
        return createErrorResponse('Failed to execute DOM pruning and indexing');
      }

      // Handle Chrome native error page (chrome-error://chromewebdata/) gracefully
      const errorPageResult = results.find((r) => (r?.result as any)?.isErrorPage);
      if (errorPageResult) {
        const errPayload = errorPageResult.result as any;
        const pageUrl = scrubUrl(tab.url || '');
        return {
          content: [
            {
              type: 'text',
              text: [
                `## ⚠️ Browser Navigation / Network Error`,
                ``,
                `The page at **${pageUrl || 'unknown URL'}** failed to load and is displaying Chrome's native error page (\`chrome-error://chromewebdata/\`).`,
                ``,
                `- **Reason**: ${errPayload?.error || 'Frame is showing error page'}`,
                `- **Status**: Network unreachable, DNS failure, or page crashed.`,
                ``,
                `*Tip: Please check the URL, network connection, or try navigating to a valid address using \`${resolveToolName('navigate')}\`.*`,
              ].join('\n'),
            },
          ],
          isError: false,
        };
      }

      // Merge multi-frame results
      const mainFrame = results.find((r) => r.frameId === 0) || results[0];
      const mainData = mainFrame?.result;
      if (!mainData) {
        return createErrorResponse('Failed to execute DOM pruning on main frame');
      }

      const mergedData: PrunedDOMTreeResult = {
        treeString: mainData.treeString,
        elementCount: mainData.elementCount,
        interactiveCount: mainData.interactiveCount,
        compressionRatio: mainData.compressionRatio,
        indexMap: { ...mainData.indexMap },
        indexedElements: [...(mainData.indexedElements || [])],
        assets: [...(mainData.assets || [])],
        pages_up: mainData.pages_up,
        pages_down: mainData.pages_down,
        scrollInfo: mainData.scrollInfo,
        activeModal: mainData.activeModal,
        focusTrapped: mainData.focusTrapped,
        isConfirmationTrap: mainData.isConfirmationTrap,
        modalIsolated: mainData.modalIsolated,
        virtualizedCount: mainData.virtualizedCount,
        virtualizedSummary: mainData.virtualizedSummary,
        flattenedCardCount: mainData.flattenedCardCount,
        selectorMatched:
          mainData.selectorMatched ?? (results.some((r) => r.result?.selectorMatched) || false),
      };

      let currentIndex = (mergedData.indexedElements?.length || 0) + 1;
      let currentAssetIndex = (mergedData.assets?.length || 0) + 1;
      const subframeLines: string[] = [];
      const assetRoutes = new Map<number, { frameId: number; localIndex: number }>();

      if (mainData.assets) {
        for (const a of mainData.assets) {
          if (typeof a.index === 'number') {
            assetRoutes.set(a.index, {
              frameId: mainFrame?.frameId ?? 0,
              localIndex: (a.index || 1) - 1,
            });
          }
        }
      }

      for (const r of results) {
        if (r === mainFrame || !r.result) continue;
        const subData = r.result;
        mergedData.elementCount += subData.elementCount;

        if (typeof subData.virtualizedCount === 'number' && subData.virtualizedCount > 0) {
          mergedData.virtualizedCount =
            (mergedData.virtualizedCount || 0) + subData.virtualizedCount;
        }
        if (Array.isArray(subData.virtualizedSummary) && subData.virtualizedSummary.length > 0) {
          if (!mergedData.virtualizedSummary) mergedData.virtualizedSummary = [];
          for (const s of subData.virtualizedSummary) {
            mergedData.virtualizedSummary.push({
              selector: `iframe[${r.frameId}] ${s.selector}`,
              count: s.count,
            });
          }
        }

        if (subData.indexedElements && subData.indexedElements.length > 0) {
          const startingIndexForFrame = currentIndex;
          const frameOffset = startingIndexForFrame - 1;

          subframeLines.push(`\n<!-- Frame ${r.frameId} -->`);
          for (const el of subData.indexedElements) {
            const remappedIndex = currentIndex++;
            const remappedEl: IndexedElement = {
              ...el,
              index: remappedIndex,
            };
            mergedData.indexedElements!.push(remappedEl);
            mergedData.indexMap[remappedIndex] = {
              selector: el.attributes?.id
                ? `#${el.attributes.id}`
                : `${el.tagName}[data-mcp-idx="${remappedIndex}"]`,
              frameId: String(r.frameId),
              tagName: el.tagName,
            };

            if (args.format === 'html') {
              const attrStr = Object.entries(el.attributes || {})
                .map(([k, v]) => `${k}="${v}"`)
                .join(' ');
              const textPart = el.text ? ` "${el.text}"` : '';
              const shadowPart = el.inShadowDom ? ' [shadow]' : '';
              subframeLines.push(
                `[${remappedIndex}]${shadowPart} <${el.tagName}${attrStr ? ' ' + attrStr : ''} frame="${r.frameId}">${textPart}</${el.tagName}>`,
              );
            } else {
              subframeLines.push(renderCompactElementLine(remappedEl, r.frameId));
            }
          }

          // Crucial: Re-index the subframe in the tab context so its in-page isolatedMap, data-mcp-idx,
          // and visual Set-of-Mark badges match the merged index!
          try {
            await executeInPage({ tabId: tab.id, frameIds: [r.frameId] }, 'inPageReindexFrame', [
              frameOffset,
              args.highlight ?? false,
            ]);
          } catch (reindexErr) {
            console.warn(`Failed to synchronize subframe ${r.frameId} index map:`, reindexErr);
          }
        }
        if (subData.assets && subData.assets.length > 0) {
          if (!mergedData.assets) mergedData.assets = [];
          // Subframe asset geometry is viewport-local to that frame; tag them
          // with frameId and remapped index so downstream crop/fetch can resolve without collision.
          for (let localIdx = 0; localIdx < subData.assets.length; localIdx++) {
            const a = subData.assets[localIdx];
            const globalIndex = currentAssetIndex++;
            mergedData.assets.push({
              ...a,
              index: globalIndex,
              src: a.src ? `${a.src}#@frame=${r.frameId}` : undefined,
            });
            assetRoutes.set(globalIndex, {
              frameId: r.frameId,
              localIndex: (typeof a.index === 'number' ? a.index : localIdx + 1) - 1,
            });
          }
        }
      }

      // Dual-track CDP Accessibility Tree alignment & fusion (Task B5)
      if (tab.id) {
        try {
          const axRes: any = await cdpSessionManager.sendCommand(
            tab.id,
            'Accessibility.getFullAXTree',
            {},
          );
          if (axRes && Array.isArray(axRes.nodes)) {
            const axNodes = axRes.nodes;
            const axRoleMap = new Map<string, { role?: string; name?: string; value?: string }>();
            const axIdMap = new Map<string, { role?: string; name?: string; value?: string }>();
            const axNameCounts = new Map<string, number>();

            for (const n of axNodes) {
              const roleVal = n.role?.value;
              const nameVal = n.name?.value;
              const valVal = n.value?.value;
              const info = { role: roleVal, name: nameVal, value: valVal };
              if (nameVal) {
                const norm = nameVal.trim().toLowerCase();
                axNameCounts.set(norm, (axNameCounts.get(norm) || 0) + 1);
                axRoleMap.set(norm, info);
              }
              if (Array.isArray(n.properties)) {
                for (const p of n.properties) {
                  if (p.name === 'id' && p.value?.value) {
                    axIdMap.set(String(p.value.value).trim().toLowerCase(), info);
                  }
                }
              }
            }

            const domTextCounts = new Map<string, number>();
            if (Array.isArray(mergedData.indexedElements)) {
              for (const el of mergedData.indexedElements) {
                const t = (
                  el.text ||
                  el.attributes?.['aria-label'] ||
                  el.attributes?.['title'] ||
                  ''
                )
                  .trim()
                  .toLowerCase();
                if (t) domTextCounts.set(t, (domTextCounts.get(t) || 0) + 1);
              }
            }

            // Align AXTree attributes onto indexedElements
            let treeChanged = false;
            if (Array.isArray(mergedData.indexedElements)) {
              for (const el of mergedData.indexedElements) {
                const elText = (
                  el.text ||
                  el.attributes?.['aria-label'] ||
                  el.attributes?.['title'] ||
                  ''
                )
                  .trim()
                  .toLowerCase();
                const elId = (el.attributes?.id || '').trim().toLowerCase();

                let axInfo: { role?: string; name?: string; value?: string } | undefined =
                  undefined;
                if (elId && axIdMap.has(elId)) {
                  axInfo = axIdMap.get(elId);
                } else if (elText) {
                  const axCount = axNameCounts.get(elText) || 0;
                  const domCount = domTextCounts.get(elText) || 0;
                  if (axCount <= 1 && domCount <= 1) {
                    axInfo = axRoleMap.get(elText);
                  }
                }

                if (axInfo) {
                  if (axInfo.role === 'button' || axInfo.role === 'link') {
                    if (el.tagName.toLowerCase() === 'div' || el.tagName.toLowerCase() === 'span') {
                      el.role = axInfo.role;
                      el.isInteractive = true;
                      if (el.attributes) el.attributes.role = axInfo.role;
                      treeChanged = true;
                    }
                  }
                  if (
                    axInfo.value !== undefined &&
                    (el.tagName.toLowerCase() === 'input' ||
                      el.tagName.toLowerCase() === 'textarea')
                  ) {
                    el.value = axInfo.value;
                    if (el.attributes) el.attributes.value = axInfo.value;
                    treeChanged = true;
                  }
                }
              }

              if (treeChanged && args.format !== 'html') {
                const mainElements = mergedData.indexedElements.filter((el) => {
                  const fId = mergedData.indexMap[el.index]?.frameId;
                  return !fId || fId === '0';
                });
                mergedData.treeString = mainElements
                  .map((el) => renderCompactElementLine(el))
                  .join('\n');

                subframeLines.length = 0;
                for (const r of results) {
                  if (r === mainFrame || !r.result) continue;
                  subframeLines.push('\n<!-- Frame ' + r.frameId + ' -->');
                  const frameElements = mergedData.indexedElements.filter(
                    (el) => String(mergedData.indexMap[el.index]?.frameId) === String(r.frameId),
                  );
                  for (const el of frameElements) {
                    subframeLines.push(renderCompactElementLine(el, r.frameId));
                  }
                }
              }
            }
          }
        } catch {
          // Graceful fallback when CDP is unavailable or not attached
        }
      }

      // Count the interactive subset, not every indexed element: informational
      // nodes (headings, role=alert) are indexed with isInteractive:false, and
      // reusing the total length here collapsed interactiveCount back onto
      // elementCount for the whole chrome_read_dom response.
      mergedData.interactiveCount = (mergedData.indexedElements || []).filter(
        (el) => el.isInteractive,
      ).length;
      if (subframeLines.length > 0) {
        mergedData.treeString += '\n' + subframeLines.join('\n');
      }
      if (mergedData.assets && mergedData.assets.length > 0) {
        const assetLines = mergedData.assets
          .map(
            (a) =>
              `[asset ${a.index}] ${a.kind} ${a.rect.width}x${a.rect.height} @(${a.rect.x},${a.rect.y})${a.src ? ' ' + a.src.slice(0, 120) : ''}${a.alt ? ' alt=' + JSON.stringify(a.alt.slice(0, 60)) : ''}`,
          )
          .join('\n');
        mergedData.treeString += `\n[Visual Assets: ${mergedData.assets.length} found. Pass assetIndex to ${resolveToolName('screenshot')} to view one.]\n${assetLines}`;
      }

      // Delta DOM support: return only changed/added/removed diffs
      if (args.deltaOnly && tab.id) {
        const diff = snapshotCacheManager.diffWithPrevious(
          tab.id,
          mergedData.indexedElements || [],
          { representation: 'standard' },
        );
        snapshotCacheManager.setSnapshot(tab.id, {
          url: scrubUrl(tab.url || ''),
          elementCount: mergedData.elementCount,
          elements: mergedData.indexedElements,
          representation: 'standard',
          assetRoutes,
        });

        if (diff.isDelta && diff.unchanged) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    unchanged: true,
                    revision: diff.revision,
                    totalElements: diff.totalCurrent,
                    message:
                      'Page DOM unchanged since last snapshot. No new or modified interactive elements.',
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          };
        }

        if (diff.isDelta) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    success: true,
                    isDelta: true,
                    revision: diff.revision,
                    addedCount: diff.added.length,
                    modifiedCount: diff.modified.length,
                    removedIndices: diff.removed,
                    added: diff.added,
                    modified: diff.modified,
                    ...(diff.truncated
                      ? {
                          truncated: true,
                          totalAdded: diff.totalAdded,
                          totalModified: diff.totalModified,
                          totalRemoved: diff.totalRemoved,
                          summary: diff.summary,
                        }
                      : {}),
                  },
                  null,
                  2,
                ),
              },
            ],
            isError: false,
          };
        }
      }

      // Record snapshot in cache manager (P1-6)
      const snapshot = snapshotCacheManager.setSnapshot(tab.id, {
        url: scrubUrl(tab.url || ''),
        elementCount: mergedData.elementCount,
        elements: mergedData.indexedElements,
        representation: 'standard',
        assetRoutes,
      });

      // Pagination cursor support (P1-6)
      // Decouple pagination from non-element banner and asset lines
      const totalElements =
        (mergedData.indexedElements || []).length || mergedData.elementCount || 0;
      const cursor = typeof args.cursor === 'number' ? Math.max(0, args.cursor) : 0;
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;

      let treeString = mergedData.treeString;
      let returnElements = mergedData.indexedElements || [];
      let hasMore = false;
      let nextCursor: number | undefined = undefined;

      if (limit !== undefined) {
        const end = Math.min(cursor + limit, totalElements);
        returnElements = returnElements.slice(cursor, end);
        hasMore = end < totalElements;
        nextCursor = hasMore ? end : undefined;

        const allTreeLines = mergedData.treeString ? mergedData.treeString.split('\n') : [];
        const allowedIndices = new Set(returnElements.map((e) => e.index));
        const hasIndexedLines = allTreeLines.some((l) => /^\[\d+\]/.test(l));
        if (hasIndexedLines) {
          const slicedLines: string[] = [];
          let passedElements = false;
          for (const line of allTreeLines) {
            const m = line.match(/^\[(\d+)\]/);
            if (m) {
              passedElements = true;
              if (allowedIndices.has(parseInt(m[1], 10))) {
                slicedLines.push(line);
              }
            } else if (!passedElements && cursor === 0) {
              slicedLines.push(line);
            } else if (passedElements && !hasMore) {
              slicedLines.push(line);
            }
          }
          treeString = slicedLines.join('\n');
        } else {
          treeString = allTreeLines.slice(cursor, end).join('\n');
        }
      }

      const resultPayload: Record<string, any> = {
        ...mergedData,
        treeString,
        indexedElements: returnElements,
        snapshotId: snapshot.snapshotId,
        tabUrl: scrubUrl(tab.url || ''),
        tabTitle: tab.title,
        cursor,
        limit,
        totalElements,
        hasMore,
        nextCursor,
        ...(effectiveSelector !== undefined
          ? {
              selector: effectiveSelector,
              ...(args.scope ? { scope: args.scope } : {}),
              selectorMatched: Boolean(mergedData.selectorMatched),
              ...(!mergedData.selectorMatched ||
              (mergedData.elementCount === 0 && effectiveSelector.trim().toLowerCase() === 'form')
                ? {
                    message:
                      effectiveSelector.trim().toLowerCase() === 'form'
                        ? 'No elements matching selector "form" found on page. Modern div-based SPAs often do not use native <form> tags; consider targeting \'[role="form"]\' or omitting selector to scan the full container.'
                        : `No elements matching selector "${effectiveSelector}" found on page.`,
                    ...(effectiveSelector.trim().toLowerCase() === 'form'
                      ? {
                          suggestion:
                            'Modern div-based SPAs often do not use native <form> tags. Try targeting \'[role="form"]\' or omitting selector to scan the full container.',
                          diagnostic:
                            'Selector "form" matched 0 elements. Modern SPAs often wrap inputs in <div> structures rather than <form>. Consider targeting \'[role="form"]\' or omitting selector.',
                        }
                      : {}),
                  }
                : {}),
            }
          : {}),
        ...(args.exclude !== undefined ? { exclude: args.exclude } : {}),
        ...(mergedData.modalIsolated ? { modalIsolated: true } : {}),
        ...(mergedData.isConfirmationTrap ? { isConfirmationTrap: true } : {}),
        pipelineHint: `1-Turn Optimal Paradigm: Pipeline fill + submit in 1 turn via ${resolveToolName('batch_actions')}([{type: "fill", index: ..., text: "..."\x7d, {type: "click", index: ...\x7d]) or ${resolveToolName('fill_index')}({ index, text, pressEnter: true \x7d). Avoid splitting fill and submit into separate LLM turns.`,
      };

      // Default response is the pruned tree plus counters only. The detail
      // blocks (indexedElements / indexMap) have no in-extension consumer —
      // element resolution goes through the page-side isolated index map — and
      // they tripled the payload by restating what treeString already says.
      if (!args.includeDetails) {
        delete resultPayload.indexedElements;
        delete resultPayload.indexMap;
      }

      return {
        content: [
          {
            type: 'text',
            // Compact JSON: the 2-space indent alone cost ~37% of the response
            // and no consumer parses it as text.
            text: JSON.stringify(resultPayload),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return createErrorResponse(
        `Error executing ${resolveToolName('read_dom')}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const readDOMTool = new ReadDOMTool();
