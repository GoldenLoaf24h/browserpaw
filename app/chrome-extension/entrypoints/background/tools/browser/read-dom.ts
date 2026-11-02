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
import { snapshotCacheManager, snapshotObservationKey } from '@/utils/snapshot-cache-manager';
import { renderCompactElementLine } from './dom-indexer';
import { waitForPageSettle } from '@/utils/action-watchdog';
import { cdpSessionManager } from '@/utils/cdp-session-manager';
import { scrubUrl } from '@/utils/url-sanitizer';
import type { FastSnapshotOptions, FastSnapshotResult } from './fast-snapshot';
import { describeFrameCoverage } from '@/utils/frame-coverage';
import { observationPriority } from '@/utils/observation-priority';

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
   * when you need geometry (rect/safeClickPoint), per-element flags, or the
   * fast engine's structured actions and validation metadata.
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

function roundRobinUniqueByFrame<T>(
  buckets: Array<{ frameId: number; items: T[] }>,
  keyOf: (item: T) => string | number,
  priorityOf: (item: T) => number,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const seen = new Set<string | number>();
  const ordered: T[] = [];
  let offset = 0;

  while (true) {
    let progressed = false;
    for (const bucket of buckets) {
      const item = bucket.items[offset];
      if (item === undefined) continue;
      progressed = true;
      const key = keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(item);
    }
    if (!progressed) break;
    offset++;
  }

  return ordered.sort((a, b) => priorityOf(b) - priorityOf(a)).slice(0, limit);
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

      // Fast Snapshot Engine branch (bounded actions/text with WeakMap caching)
      const hasNonZeroCursor = typeof args.cursor === 'number' && args.cursor > 0;
      if ((args.fast || args.format === 'fast') && !args.deltaOnly && !hasNonZeroCursor) {
        const unsupportedFastOptions = [
          args.flattenCards ? 'flattenCards' : null,
          args.virtualizeViewport ? 'virtualizeViewport' : null,
        ].filter((value): value is string => Boolean(value));
        if (unsupportedFastOptions.length > 0) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'blocked',
                  code: 'unsupported_fast_options',
                  unsupported: unsupportedFastOptions,
                }),
              },
            ],
            isError: true,
          };
        }
        const effectiveSelector = args.scope || args.selector;
        const fastObservationKey = snapshotObservationKey({
          ...args,
          selector: effectiveSelector,
        });
        const fastOpts: FastSnapshotOptions = {
          legacyVisibility: args.legacyVisibility,
          selector: effectiveSelector,
          scope: args.scope,
          exclude: args.exclude,
          viewportThreshold: args.viewportThreshold,
          viewportOnly: args.viewportOnly,
          activeViewportOnly: args.activeViewportOnly,
          isolateModal: args.isolateModal,
          limit: args.limit,
          maxTextLength: args.maxTextLength,
        };

        const snapRes = await executeInPage<FastSnapshotResult>(
          { tabId: tab.id, allFrames: true },
          'inPageFastSnapshot',
          [fastOpts],
        );

        const mainFrame = snapRes.find((r) => r.frameId === 0) || snapRes[0];
        const fastData = mainFrame?.result as any;
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

        const subFrames = snapRes.filter(
          (r) => r !== mainFrame && r.result && !(r.result as any).isErrorPage,
        );
        const seenIndices = new Set<number>();
        const snapshotElements: any[] = [];

        const processActionsToElements = (actions: any[], frameId: number) => {
          for (const a of actions) {
            if (!/^e\d+$/.test(a.id)) continue;
            const index = Number(a.id.slice(1));
            if (seenIndices.has(index)) {
              if (a.kind === 'fill' && a.value) {
                const existing = snapshotElements.find((e) => e.index === index);
                if (existing && existing.attributes) {
                  existing.attributes.value = a.value;
                }
              }
              continue;
            }
            seenIndices.add(index);
            const actionText = a.label || a.name || '';
            const rect = a.rect
              ? {
                  x: a.rect.x ?? 0,
                  y: a.rect.y ?? 0,
                  width: a.rect.w ?? a.rect.width ?? 0,
                  height: a.rect.h ?? a.rect.height ?? 0,
                }
              : { x: 0, y: 0, width: 0, height: 0 };
            snapshotElements.push({
              index,
              tagName: a.role || a.kind || 'element',
              isInteractive: true,
              ...(a.withinFocusScope ? { withinFocusScope: true } : {}),
              frameId: frameId !== 0 ? frameId : undefined,
              attributes: {
                role: a.role,
                name: actionText,
                ...(a.domId ? { id: a.domId } : {}),
                ...(frameId !== 0 ? { frame: String(frameId) } : {}),
                ...(a.kind === 'fill' && typeof a.value === 'string' && a.value !== ''
                  ? { value: a.value }
                  : {}),
                ...(a.current_value ? { current_value: a.current_value } : {}),
                ...(a.invalid ? { invalid: 'true' } : {}),
                ...(a.invalidReason ? { invalidReason: a.invalidReason } : {}),
                ...(a.validationMessage ? { validationMessage: a.validationMessage } : {}),
                ...(a.required ? { required: 'true' } : {}),
                ...(a.valid !== undefined ? { valid: String(a.valid) } : {}),
                ...(a.checked !== undefined ? { checked: a.checked } : {}),
                ...(a.selected !== undefined ? { 'aria-selected': a.selected } : {}),
                ...(a.expanded !== undefined ? { 'aria-expanded': a.expanded } : {}),
                ...(a.ariaInvalid ? { 'aria-invalid': a.ariaInvalid } : {}),
                ...(a.errormessage ? { errormessage: a.errormessage } : {}),
                ...(a.description ? { description: a.description } : {}),
                ...(a.focused ? { focused: 'true' } : {}),
              },
              text: actionText,
              value: a.kind === 'fill' ? a.value : a.current_value,
              rect,
            });
          }
        };

        processActionsToElements(fastData.actions || [], mainFrame.frameId ?? 0);
        for (const sf of subFrames) {
          processActionsToElements(sf.result?.actions || [], sf.frameId);
        }

        const mergeStructuralElements = (elements: IndexedElement[], frameId: number) => {
          for (const element of elements) {
            const existing = snapshotElements.find(
              (candidate) => candidate.index === element.index,
            );
            if (existing) {
              existing.role = element.role || existing.role;
              existing.attributes = {
                ...element.attributes,
                ...existing.attributes,
                ...(frameId !== 0 ? { frame: String(frameId) } : {}),
              };
              if (!existing.text && element.text) existing.text = element.text;
              continue;
            }
            snapshotElements.push({
              ...element,
              frameId: frameId !== 0 ? frameId : undefined,
              attributes: {
                ...element.attributes,
                ...(frameId !== 0 ? { frame: String(frameId) } : {}),
              },
            });
          }
        };
        mergeStructuralElements(fastData.structuralElements || [], mainFrame.frameId ?? 0);
        for (const sf of subFrames) {
          mergeStructuralElements(sf.result?.structuralElements || [], sf.frameId);
        }

        const FAST_GLOBAL_ELEMENT_LIMIT = 250;
        let frameOmittedActions = 0;
        let frameOmittedElements = 0;
        for (const frame of snapRes) {
          frameOmittedActions += frame.result?.omitted_actions || 0;
          frameOmittedElements += frame.result?.omitted_elements || 0;
        }
        const totalElements = snapshotElements.length + frameOmittedElements;
        const userLimit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : undefined;
        const effectiveLimit =
          userLimit !== undefined
            ? Math.min(userLimit, FAST_GLOBAL_ELEMENT_LIMIT)
            : FAST_GLOBAL_ELEMENT_LIMIT;

        const allInteractiveActions: any[] = [];
        for (const a of fastData.actions || []) {
          if (/^e\d+$/.test(a.id)) allInteractiveActions.push(a);
        }
        for (const sf of subFrames) {
          for (const a of sf.result?.actions || []) {
            if (/^e\d+$/.test(a.id)) allInteractiveActions.push(a);
          }
        }

        const byFrame = snapRes.map((frame) => {
          const actions = (frame.result?.actions || []).filter((a: any) => /^e\d+$/.test(a.id));
          const seenElementIds = new Set<number>();
          const elementIds: number[] = [];
          for (const action of actions) {
            const numericId = Number(action.id.slice(1));
            if (seenElementIds.has(numericId)) continue;
            seenElementIds.add(numericId);
            elementIds.push(numericId);
          }
          for (const element of frame.result?.structuralElements || []) {
            if (seenElementIds.has(element.index)) continue;
            seenElementIds.add(element.index);
            elementIds.push(element.index);
          }
          return { frameId: frame.frameId, actions, elementIds };
        });
        const selectedByFrame = new Map<number, any[]>();
        for (const frame of byFrame) selectedByFrame.set(frame.frameId, []);
        const priorities = new Map(
          snapshotElements.map((element) => [element.index, observationPriority(element)]),
        );
        const chosenElementIds = new Set(
          roundRobinUniqueByFrame(
            byFrame.map((frame) => ({ frameId: frame.frameId, items: frame.elementIds })),
            (elementId) => elementId,
            (elementId) => priorities.get(elementId) || 0,
            effectiveLimit,
          ),
        );

        const allUniqueElementIds = new Set<number>();
        for (const frame of byFrame) {
          for (const elementId of frame.elementIds) allUniqueElementIds.add(elementId);
        }

        const retainedElementIds = chosenElementIds;
        let actionRecordCount = 0;
        const selectActionCounts = new Map<number, number>();
        for (const frame of byFrame) {
          for (const action of frame.actions) {
            if (retainedElementIds.has(Number(action.id.slice(1)))) {
              const numericId = Number(action.id.slice(1));
              if (action.kind === 'select') {
                const count = selectActionCounts.get(numericId) || 0;
                if (count >= 50) continue;
                selectActionCounts.set(numericId, count + 1);
              }
              selectedByFrame.get(frame.frameId)!.push(action);
              actionRecordCount++;
            }
          }
        }
        const omitted_elements =
          Math.max(0, allUniqueElementIds.size - retainedElementIds.size) + frameOmittedElements;
        const omittedDueToBudget = allInteractiveActions.length - actionRecordCount;

        const totalOmittedActions = frameOmittedActions + omittedDueToBudget;

        const retainedActionIds = new Set([...selectedByFrame.values()].flat().map((a) => a.id));
        const pagedElements = snapshotElements
          .filter((e) => retainedElementIds.has(e.index))
          .sort((a, b) => observationPriority(b) - observationPriority(a));

        const coverage = await describeFrameCoverage(tab.id, snapRes);
        const snapshot = snapshotCacheManager.setSnapshot(tab.id, {
          url: scrubUrl(tab.url || fastData.url),
          elementCount: pagedElements.length,
          elements: pagedElements,
          representation: 'fast',
          observationKey: fastObservationKey,
          coverage,
        });

        if (args.highlight) {
          try {
            await executeInPage({ tabId: tab.id, allFrames: true }, 'inPageRenderHighlights', []);
          } catch {}
        }

        const treeLines: string[] = [];
        let lastFrameId = 0;
        for (const e of pagedElements) {
          const frameId = e.frameId || 0;
          if (frameId !== lastFrameId && frameId !== 0) {
            treeLines.push(`\n<!-- Frame ${frameId} -->`);
            lastFrameId = frameId;
          }
          treeLines.push(renderCompactElementLine(e, e.frameId));
        }
        const treeString = treeLines.join('\n');

        const GLOBAL_BODY_TEXT_BUDGET = 6000;
        const combinedTextParts = [fastData.text || ''];
        for (const sf of subFrames) {
          if (sf.result?.text) combinedTextParts.push(sf.result.text);
        }
        const rawCombinedText = combinedTextParts.join('\n');
        let textTruncated = snapRes.some((r) => r.result?.textTruncated === true);
        let totalOmittedText = snapRes.reduce((acc, r) => acc + (r.result?.omitted_text || 0), 0);

        let combinedText = rawCombinedText;
        if (rawCombinedText.length > GLOBAL_BODY_TEXT_BUDGET) {
          textTruncated = true;
          totalOmittedText += rawCombinedText.length - GLOBAL_BODY_TEXT_BUDGET;
          combinedText = rawCombinedText.slice(0, GLOBAL_BODY_TEXT_BUDGET);
        }

        let combinedActions: any[] | undefined = undefined;
        let combinedGuards: Record<string | number, any> | undefined = undefined;
        let mergedPageKey: any[] | undefined = undefined;
        let mergedMarker: any[] | undefined = undefined;

        if (args.includeDetails) {
          const subInteractiveActions: any[] = subFrames.flatMap(
            (sf) => selectedByFrame.get(sf.frameId) || [],
          );
          const mainInteractiveActions = selectedByFrame.get(mainFrame.frameId) || [];
          const mainControlActions = (fastData.actions || []).filter(
            (a: any) => !/^e\d+$/.test(a.id),
          );
          const cappedInteractiveActions = [...mainInteractiveActions, ...subInteractiveActions];
          combinedActions = [...cappedInteractiveActions, ...mainControlActions];

          combinedGuards = {};
          for (const a of fastData.actions || []) {
            if (
              retainedActionIds.has(a.id) &&
              typeof a.node === 'number' &&
              fastData.guards?.[a.node]
            ) {
              combinedGuards[a.node] = fastData.guards[a.node];
              if (subFrames.length > 0) {
                combinedGuards[a.id] = fastData.guards[a.node];
              }
            }
          }

          for (const sf of subFrames) {
            for (const a of sf.result?.actions || []) {
              if (
                retainedActionIds.has(a.id) &&
                typeof a.node === 'number' &&
                sf.result?.guards?.[a.node]
              ) {
                const numericKey = Number(a.id.slice(1));
                combinedGuards[numericKey] = sf.result.guards[a.node];
                combinedGuards[a.id] = sf.result.guards[a.node];
              }
            }
          }

          if (subFrames.length > 0) {
            const mergedInputsState = [
              ...(Array.isArray(fastData.page_key?.[6]) ? fastData.page_key[6] : []),
              ...subFrames.flatMap((sf) =>
                (Array.isArray(sf.result?.page_key?.[6]) ? sf.result.page_key[6] : []).map(
                  (item: any) => [
                    item[0],
                    item[1],
                    item[2],
                    item[3],
                    item[4],
                    item[5],
                    `frame:${sf.frameId}`,
                  ],
                ),
              ),
            ];

            mergedPageKey = [
              fastData.page_key?.[0] ?? performance.timeOrigin,
              fastData.page_key?.[1] ?? (tab.url || ''),
              fastData.page_key?.[2] ?? 0,
              fastData.page_key?.[3] ?? 0,
              fastData.page_key?.[4] ?? fastData.w,
              fastData.page_key?.[5] ?? fastData.h,
              mergedInputsState,
              ...subFrames.map((sf) => ({ frameId: sf.frameId, url: sf.result?.url })),
            ];

            mergedMarker = [
              fastData.marker?.[0] ?? performance.timeOrigin,
              fastData.marker?.[1] ?? (tab.url || fastData.url),
              fastData.marker?.[2] ?? 0,
              fastData.marker?.[3] ?? 0,
              fastData.marker?.[4] ?? fastData.w,
              fastData.marker?.[5] ?? fastData.h,
              fastData.title,
              combinedText,
              combinedActions.map(({ rect, ...rest }: any) => rest),
              mergedInputsState,
            ];
          } else {
            mergedPageKey = fastData.page_key;
            mergedMarker = fastData.marker;
          }
        }

        let selectorMatched: boolean | undefined = undefined;
        if (effectiveSelector !== undefined) {
          selectorMatched = snapRes.some((r) => r.result?.selectorMatched === true);
        }

        const fastResponseData: any = { ...fastData };
        delete fastResponseData.structuralElements;
        delete fastResponseData.observationReused;

        const responseObj: any = {
          ...(args.includeDetails
            ? {
                ...fastResponseData,
                actions: combinedActions,
                guards: combinedGuards,
                page_key: mergedPageKey,
                marker: mergedMarker,
                indexedElements: pagedElements,
                omitted_actions: totalOmittedActions,
                omitted_elements,
                text: combinedText,
                observations: snapRes.map((frame) => ({
                  frameId: frame.frameId,
                  documentId: frame.documentId,
                  reused: (frame.result as any)?.observationReused ?? null,
                })),
              }
            : {
                title: fastData.title,
                text: combinedText,
                w: fastData.w,
                h: fastData.h,
                scroll: fastData.scroll,
                scrollInfo: fastData.scrollInfo,
                omitted_actions: totalOmittedActions,
                omitted_elements,
              }),
          url: scrubUrl(fastData.url || tab.url || ''),
          snapshotId: snapshot.snapshotId,
          treeString,
          elementCount: pagedElements.length,
          totalElements,
          ...(textTruncated ? { textTruncated: true, omitted_text: totalOmittedText } : {}),
        };

        if (selectorMatched !== undefined) {
          responseObj.selectorMatched = selectorMatched;
        }

        responseObj.coverage = coverage;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(responseObj),
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
        format: (args.format === 'fast' || !args.format ? 'compact' : args.format) as
          'compact' | 'html',
        viewportOnly: args.viewportOnly,
        activeViewportOnly: args.activeViewportOnly,
        selector: effectiveSelector,
        scope: args.scope,
        exclude: args.exclude,
        isolateModal: args.isolateModal,
        virtualizeViewport: args.virtualizeViewport,
        flattenCards: args.flattenCards,
      };
      const standardObservationKey = snapshotObservationKey(prunerOpts);

      // allFrames is the coverage contract: a failed broadcast must not silently
      // degrade into a main-frame-only snapshot.
      const results = await executeInPage({ tabId: tab.id, allFrames: true }, 'inPageDOMPruner', [
        prunerOpts,
      ]);

      if (!results || results.length === 0) {
        return createErrorResponse('Failed to execute DOM pruning and indexing');
      }

      // Handle Chrome native error page (chrome-error://chromewebdata/) gracefully
      const errorPageResult = results.find(
        (r) => r.frameId === 0 && (r?.result as any)?.isErrorPage,
      );
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
        selectorMatched: results.some((r) => r.result?.selectorMatched === true),
      };
      const standardCoverage = await describeFrameCoverage(tab.id, results);

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
        if (r === mainFrame || !r.result || (r.result as any).isErrorPage) continue;
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
          subframeLines.push(`\n<!-- Frame ${r.frameId} -->`);
          for (const el of subData.indexedElements) {
            mergedData.indexedElements!.push(el);
            mergedData.indexMap[el.index] = {
              selector: subData.indexMap?.[el.index]?.selector,
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
                `[${el.index}]${shadowPart} <${el.tagName}${attrStr ? ' ' + attrStr : ''} frame="${r.frameId}">${textPart}</${el.tagName}>`,
              );
            } else {
              subframeLines.push(renderCompactElementLine(el, r.frameId));
            }
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

      const orderedFrames = [mainFrame, ...results.filter((result) => result !== mainFrame)];
      const standardFrameBuckets = orderedFrames
        .filter((result) => result?.result && !(result.result as any).isErrorPage)
        .map((result) => ({ frameId: result.frameId, items: [] as IndexedElement[] }));
      const bucketByFrameId = new Map(
        standardFrameBuckets.map((bucket) => [String(bucket.frameId), bucket]),
      );
      const mainFrameId = String(mainFrame.frameId);
      for (const element of mergedData.indexedElements || []) {
        const mappedFrameId = mergedData.indexMap[element.index]?.frameId;
        const bucket =
          bucketByFrameId.get(mappedFrameId === undefined ? mainFrameId : String(mappedFrameId)) ||
          bucketByFrameId.get(mainFrameId);
        bucket?.items.push(element);
      }
      const fairStandardElements = roundRobinUniqueByFrame(
        standardFrameBuckets,
        (element) => element.index,
        observationPriority,
      );

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

      let deltaRequiresFullBaseline = false;

      // Delta DOM support: return only changed/added/removed diffs
      if (args.deltaOnly && tab.id && standardCoverage.status === 'complete') {
        const diff = snapshotCacheManager.diffWithPrevious(
          tab.id,
          mergedData.indexedElements || [],
          { representation: 'standard', observationKey: standardObservationKey },
        );
        deltaRequiresFullBaseline = !diff.isDelta;
        snapshotCacheManager.setSnapshot(tab.id, {
          url: scrubUrl(tab.url || ''),
          elementCount: mergedData.elementCount,
          elements: mergedData.indexedElements,
          representation: 'standard',
          observationKey: standardObservationKey,
          assetRoutes,
          coverage: standardCoverage,
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
                    coverage: standardCoverage,
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
                    coverage: standardCoverage,
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
        observationKey: standardObservationKey,
        assetRoutes,
        coverage: standardCoverage,
      });

      // Pagination cursor support (P1-6)
      // Decouple pagination from non-element banner and asset lines
      const totalElements =
        (mergedData.indexedElements || []).length || mergedData.elementCount || 0;
      const cursor = typeof args.cursor === 'number' ? Math.max(0, args.cursor) : 0;
      const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 250;

      let treeString = mergedData.treeString;
      let returnElements = mergedData.indexedElements || [];
      let hasMore = false;
      let nextCursor: number | undefined = undefined;

      const end = Math.min(cursor + limit, totalElements);
      returnElements = fairStandardElements.slice(cursor, end);
      hasMore = end < totalElements;
      nextCursor = hasMore ? end : undefined;

      const allTreeLines = mergedData.treeString ? mergedData.treeString.split('\n') : [];
      const hasIndexedLines = allTreeLines.some((l) => /^\[\d+\]/.test(l));
      if (hasIndexedLines) {
        const elementLines = new Map<number, string>();
        for (const line of allTreeLines) {
          const match = line.match(/^\[(\d+)\]/);
          if (match) elementLines.set(Number(match[1]), line);
        }
        const firstElementLine = allTreeLines.findIndex((line) => /^\[\d+\]/.test(line));
        const lastElementLine = allTreeLines.findLastIndex((line) => /^\[\d+\]/.test(line));
        const leadingLines = cursor === 0 ? allTreeLines.slice(0, firstElementLine) : [];
        const trailingLines = !hasMore ? allTreeLines.slice(lastElementLine + 1) : [];
        const pageElementLines = returnElements.map((element) => {
          const existingLine = elementLines.get(element.index);
          if (existingLine) return existingLine;
          const frameId = mergedData.indexMap[element.index]?.frameId;
          return args.format === 'html'
            ? `[${element.index}]${element.inShadowDom ? ' [shadow]' : ''} <${element.tagName}${Object.entries(
                element.attributes || {},
              )
                .map(([key, value]) => ` ${key}="${value}"`)
                .join(
                  '',
                )}${frameId && frameId !== '0' ? ` frame="${frameId}"` : ''}>${element.text ? ` "${element.text}"` : ''}</${element.tagName}>`
            : renderCompactElementLine(
                element,
                frameId && frameId !== '0' ? Number(frameId) : undefined,
              );
        });
        treeString = [...leadingLines, ...pageElementLines, ...trailingLines].join('\n');
      } else {
        treeString = allTreeLines.slice(cursor, end).join('\n');
      }

      const resultPayload: Record<string, any> = {
        ...mergedData,
        ...(args.includeDetails
          ? {
              observations: results.map((frame) => ({
                frameId: frame.frameId,
                documentId: frame.documentId,
                reused: frame.result?.observationReused ?? null,
              })),
            }
          : {}),
        coverage: standardCoverage,
        ...(args.deltaOnly && (deltaRequiresFullBaseline || standardCoverage.status !== 'complete')
          ? {
              isDelta: false,
              ...(standardCoverage.status !== 'complete'
                ? {
                    deltaError:
                      'Incomplete frame observation; complete baseline retained, no removals inferred',
                  }
                : {}),
            }
          : {}),
        treeString,
        indexedElements: returnElements,
        snapshotId: snapshot.snapshotId,
        tabUrl: scrubUrl(tab.url || ''),
        tabTitle: tab.title,
        cursor,
        limit,
        totalElements,
        omitted_elements: Math.max(0, totalElements - returnElements.length - cursor),
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
