import type { UnifiedLocatorOptions, UnifiedLocatorResult } from 'chrome-mcp-shared';
import { snapshotCacheManager } from './snapshot-cache-manager';
import { parseUnifiedCoordinate } from './coordinate-parser';
import { TaskCancelledError } from './action-abort';

export function formatLocatorDiagnostics(
  loc?: UnifiedLocatorResult | BrowserLocatorResult | null,
): Record<string, any> {
  if (!loc) return {};
  return { resolutionPath: loc.resolutionPath };
}

export interface BrowserLocatorOptions extends UnifiedLocatorOptions {
  frameId?: number;
  label?: string;
  exact?: boolean;
  captureId?: string;
  deadlineAt?: number;
  signal?: AbortSignal;
  operation?: 'click' | 'fill' | 'press' | 'locate';
}

export type BrowserLocatorResult = Omit<UnifiedLocatorResult, 'resolutionPath'> & {
  resolutionPath: UnifiedLocatorResult['resolutionPath'] | 'label';
  notFound?: boolean;
  dispatched?: boolean;
  requestDispatched?: boolean;
  status?: string;
};

export type InPageLocatorExecutor = (
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] },
  fnName: string,
  args: any[],
) => Promise<any[]>;

export type CdpCommandSender = (tabId: number, method: string, params: any) => Promise<any>;

export interface UnifiedLocatorDependencies {
  executeInPage?: InPageLocatorExecutor;
  sendCdpCommand?: CdpCommandSender;
  coordinateScaler?: (tabId: number, x: number, y: number) => { x: number; y: number };
  coordinateContext?: (
    tabId: number,
  ) => { viewportWidth?: number; viewportHeight?: number } | undefined;
  validateScreenshotCoordinateBinding?: (options: {
    tabId: number;
    captureId?: string;
    coordinateSpace?: 'viewport' | 'screenshot';
  }) => Promise<{ error?: string }>;
}

export function matchesLocatorRole(
  targetRole: string,
  el: { role?: string; tagName?: string; attributes?: Record<string, string> },
): boolean {
  const normTarget = targetRole.toLowerCase().trim();
  const elRole = (el.role || '').toLowerCase().trim();
  if (elRole && elRole === normTarget) return true;

  const tag = (el.tagName || '').toLowerCase().trim();
  const inputType = (el.attributes?.type || '').toLowerCase().trim();

  if (normTarget === 'button') {
    return (
      tag === 'button' ||
      (tag === 'input' &&
        (inputType === 'button' || inputType === 'submit' || inputType === 'reset'))
    );
  }
  if (normTarget === 'link') {
    return (
      tag === 'a' && (el.attributes?.href !== undefined || Boolean(el.attributes?.['data-href']))
    );
  }
  if (normTarget === 'textbox') {
    if (tag === 'textarea') return true;
    if (el.attributes?.contenteditable === 'true' || el.attributes?.contenteditable === '') {
      return true;
    }
    if (tag === 'input') {
      const nonText = new Set([
        'button',
        'submit',
        'reset',
        'checkbox',
        'radio',
        'hidden',
        'image',
        'file',
        'range',
        'color',
      ]);
      return !nonText.has(inputType);
    }
    return false;
  }
  if (normTarget === 'combobox') {
    return tag === 'select';
  }
  if (normTarget === 'checkbox' || normTarget === 'radio') {
    return tag === 'input' && inputType === normTarget;
  }
  return false;
}

export function isCandidateEligibleForOperation(
  el: any,
  operation?: 'click' | 'fill' | 'press' | 'locate',
): boolean {
  const tag = String(el.tagName || '')
    .toLowerCase()
    .trim();
  const inputType = String(el.attributes?.type || '')
    .toLowerCase()
    .trim();
  const elRole = String(el.role || '')
    .toLowerCase()
    .trim();

  if (operation === 'fill') {
    if (tag === 'textarea') return true;
    if (
      el.attributes?.contenteditable === 'true' ||
      el.attributes?.contenteditable === '' ||
      el.isEditor === true ||
      el.isComposer === true
    ) {
      return true;
    }
    if (tag === 'input') {
      const nonFill = new Set([
        'checkbox',
        'radio',
        'file',
        'hidden',
        'button',
        'submit',
        'reset',
        'image',
        'range',
        'color',
      ]);
      return !nonFill.has(inputType);
    }
    if (elRole === 'textbox' || elRole === 'searchbox') {
      return true;
    }
    return false;
  }

  if (operation === 'click') {
    if (el.isInteractive === true) return true;
    const clickableTags = new Set(['button', 'a', 'select', 'summary', 'option']);
    if (clickableTags.has(tag)) return true;
    const clickableRoles = new Set([
      'button',
      'link',
      'checkbox',
      'radio',
      'menuitem',
      'tab',
      'switch',
      'combobox',
    ]);
    if (clickableRoles.has(elRole)) return true;
    if (tag === 'input' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(inputType)) {
      return true;
    }
    return false;
  }

  if (el.isInteractive === true) return true;
  if (['button', 'a', 'input', 'textarea', 'select', 'summary'].includes(tag)) return true;
  if (el.role && !['generic', 'presentation', 'none'].includes(elRole)) return true;

  return false;
}

async function executeBoundedInPage(
  executeInPage: InPageLocatorExecutor,
  target: { tabId: number; allFrames?: boolean; frameIds?: number[] },
  fnName: string,
  args: any[],
  bounds?: { signal?: AbortSignal; deadlineAt?: number },
): Promise<any[]> {
  if (bounds?.signal?.aborted) {
    throw new TaskCancelledError('before in-page locator execution');
  }
  if (bounds?.deadlineAt !== undefined && Date.now() >= bounds.deadlineAt) {
    throw new Error('Locator deadline reached before in-page execution');
  }
  if (!bounds?.signal && bounds?.deadlineAt === undefined) {
    return await executeInPage(target, fnName, args);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const racePromises: Array<Promise<any>> = [];

    if (bounds.signal) {
      racePromises.push(
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new TaskCancelledError('during in-page locator execution'));
          bounds.signal!.addEventListener('abort', onAbort, { once: true });
          if (bounds.signal!.aborted) onAbort();
        }),
      );
    }

    if (bounds.deadlineAt !== undefined) {
      const remainingMs = Math.max(0, bounds.deadlineAt - Date.now());
      racePromises.push(
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Locator deadline reached')), remainingMs);
        }),
      );
    }

    if (!bounds.signal?.aborted) racePromises.push(executeInPage(target, fnName, args));
    return await Promise.race(racePromises);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (bounds.signal && onAbort) {
      bounds.signal.removeEventListener('abort', onAbort);
    }
  }
}

async function resolveAcrossFrames(
  executeInPage: InPageLocatorExecutor,
  tabId: number,
  fnName: string,
  args: any[],
  locatorDesc: string,
  resolutionPath: 'ref' | 'selector' | 'text' | 'role' | 'label',
  frameId?: number,
  bounds?: { signal?: AbortSignal; deadlineAt?: number },
): Promise<
  | { status: 'found'; match: any; frameId: number; documentId?: string }
  | { status: 'ambiguous'; error: string }
  | { status: 'error'; error: string }
  | { status: 'cancelled'; error: string }
  | { status: 'timeout'; error: string }
  | { status: 'none' }
> {
  let frameResults: any[];
  try {
    frameResults = await executeBoundedInPage(
      executeInPage,
      frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
      fnName,
      args,
      bounds,
    );
  } catch (err) {
    const isCancelled =
      err instanceof TaskCancelledError ||
      bounds?.signal?.aborted ||
      /cancelled|abort/i.test(err instanceof Error ? err.message : String(err));
    const isTimeout =
      (bounds?.deadlineAt !== undefined && Date.now() >= bounds.deadlineAt) ||
      /deadline|timed? ?out/i.test(err instanceof Error ? err.message : String(err));

    if (isCancelled) {
      return {
        status: 'cancelled',
        error: `Execution across frames cancelled: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (isTimeout) {
      return {
        status: 'timeout',
        error: `Execution across frames timed out: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    return {
      status: 'error',
      error: `Execution across frames failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!Array.isArray(frameResults) || frameResults.length === 0) {
    return { status: 'error', error: 'Frame execution returned no results' };
  }

  const eligible: Array<{ frameId: number; result: any; documentId?: string }> = [];

  for (const entry of frameResults) {
    const resultFrameId = typeof entry?.frameId === 'number' ? entry.frameId : 0;
    if (frameId !== undefined && resultFrameId !== frameId) {
      return {
        status: 'error',
        error: `Execution was requested for frameId ${frameId} but returned frameId ${resultFrameId}`,
      };
    }

    if (!entry || typeof entry !== 'object' || (!('result' in entry) && !('error' in entry))) {
      return {
        status: 'error',
        error: `Execution in frameId ${resultFrameId} returned malformed or undefined response`,
      };
    }

    if (entry.error) {
      return {
        status: 'error',
        error: `Execution in frameId ${resultFrameId} failed: ${entry.error}`,
      };
    }

    const res = entry.result;
    if (!res || typeof res !== 'object') {
      return {
        status: 'error',
        error: `Execution in frameId ${resultFrameId} returned invalid result object`,
      };
    }

    if (res.success === false) {
      const isInternallyAmbiguous =
        res.ambiguous === true ||
        (typeof res.matchCount === 'number' && res.matchCount > 1) ||
        (Array.isArray(res.matches) && res.matches.length > 1);

      if (isInternallyAmbiguous) {
        const countMsg = res.matchCount ? `${res.matchCount} elements` : 'multiple elements';
        const errorMsg =
          res.error ||
          `Strict mode violation: ${resolutionPath} "${locatorDesc}" resolved to ${countMsg} in frameId ${resultFrameId}. Specify a unique target.`;
        return { status: 'ambiguous', error: errorMsg };
      }

      if (res.notFound === true) {
        continue;
      }

      return {
        status: 'error',
        error: `Execution in frameId ${resultFrameId} failed: ${res.error || 'Unknown in-page error'}`,
      };
    }

    if (res.success !== true || !Number.isFinite(res.x) || !Number.isFinite(res.y)) {
      return {
        status: 'error',
        error: `Execution in frameId ${resultFrameId} returned invalid location`,
      };
    }

    if (res.success && Number.isFinite(res.x) && Number.isFinite(res.y)) {
      if (res.visible === false || res.isVisible === false) {
        continue;
      }
      if (
        (typeof res.width === 'number' && (!Number.isFinite(res.width) || res.width <= 0)) ||
        (typeof res.height === 'number' && (!Number.isFinite(res.height) || res.height <= 0))
      ) {
        continue;
      }
      eligible.push({ frameId: resultFrameId, result: res, documentId: entry.documentId });
    }
  }

  if (eligible.length > 1) {
    const frameList = eligible.map((e) => `frameId ${e.frameId}`).join(', ');
    return {
      status: 'ambiguous',
      error: `Strict mode violation: ${resolutionPath} "${locatorDesc}" resolved to ${eligible.length} elements across frames: ${frameList}. Specify a unique target or frame-specific ref.`,
    };
  }

  if (eligible.length === 1) {
    return {
      status: 'found',
      match: eligible[0].result,
      frameId: eligible[0].frameId,
      documentId: eligible[0].documentId,
    };
  }

  return { status: 'none' };
}

export async function resolveTargetLocation(
  tabId: number,
  options: BrowserLocatorOptions,
  customDeps?: UnifiedLocatorDependencies,
): Promise<BrowserLocatorResult> {
  const deps = customDeps || {};
  const coordParam = options.coordinate || options.coordinates;
  const targetText = options.targetText || options.text;
  const targetLabel = options.label?.trim();
  const hasRef = options.ref !== undefined || options.index !== undefined;
  const hasSelector = Boolean(options.selector && typeof options.selector === 'string');
  const hasTextOrRole = Boolean(targetText || options.role || targetLabel);
  const wantsScreenshotSpace =
    options.coordinateSpace === 'screenshot' || Boolean(options.captureId);
  const viewportContext = wantsScreenshotSpace ? undefined : deps.coordinateContext?.(tabId);
  const parsedCoord = coordParam
    ? parseUnifiedCoordinate(
        coordParam,
        wantsScreenshotSpace
          ? { tabId }
          : viewportContext
            ? {
                viewportWidth: viewportContext.viewportWidth,
                viewportHeight: viewportContext.viewportHeight,
              }
            : undefined,
      )
    : null;
  const hasCoordinate = Boolean(
    parsedCoord ||
    (coordParam &&
      typeof (coordParam as any).x === 'number' &&
      typeof (coordParam as any).y === 'number' &&
      Number.isFinite((coordParam as any).x) &&
      Number.isFinite((coordParam as any).y)),
  );

  const initialResolutionPath = hasRef
    ? 'ref'
    : hasSelector
      ? 'selector'
      : targetLabel
        ? 'label'
        : options.role
          ? 'role'
          : 'text';

  if (options.signal?.aborted) {
    return {
      success: false,
      x: 0,
      y: 0,
      resolutionPath: initialResolutionPath,
      error: 'Locator aborted before target resolution',
      dispatched: false,
      requestDispatched: false,
      status: 'cancelled',
    };
  }

  if (options.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
    return {
      success: false,
      x: 0,
      y: 0,
      resolutionPath: initialResolutionPath,
      error: 'Locator deadline reached before target resolution',
      dispatched: false,
      requestDispatched: false,
      status: 'timeout',
    };
  }

  if (!hasRef && !hasSelector && !hasTextOrRole && !hasCoordinate) {
    return {
      success: false,
      x: 0,
      y: 0,
      resolutionPath: 'ref',
      error: 'No target locator provided. Please specify ref, selector, text/role, or coordinate.',
      dispatched: false,
      requestDispatched: false,
    };
  }

  const isSnapshotValid = hasRef ? snapshotCacheManager.isSnapshotValid(tabId) : true;
  const invalidationWarning =
    !isSnapshotValid && hasRef ? snapshotCacheManager.getInvalidationMessage(tabId) : undefined;

  // 1. Primary: Try ref / index (Zero requests on exact unique match, fail closed on error/ambiguity, no guessing)
  if (hasRef && deps.executeInPage) {
    const rawRef = options.ref ?? options.index;
    try {
      const outcome = await resolveAcrossFrames(
        deps.executeInPage,
        tabId,
        'inPageGetElementCoordinates',
        [rawRef],
        String(rawRef),
        'ref',
        options.frameId,
        { signal: options.signal, deadlineAt: options.deadlineAt },
      );

      if (
        outcome.status === 'ambiguous' ||
        outcome.status === 'error' ||
        outcome.status === 'cancelled' ||
        outcome.status === 'timeout'
      ) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'ref',
          error: outcome.error,
          dispatched: false,
          requestDispatched: false,
          ...(outcome.status === 'cancelled' || outcome.status === 'timeout'
            ? { status: outcome.status }
            : {}),
        };
      }

      if (outcome.status === 'found') {
        const match = outcome.match;
        const targetFrameId = outcome.frameId;

        let warningToReport = invalidationWarning;
        const numericRef =
          typeof rawRef === 'number' ? rawRef : parseInt(String(rawRef).replace(/^#/, ''), 10);
        if (warningToReport && !isNaN(numericRef)) {
          const currentScopeHash =
            match.attributes?.['data-scope-hash'] || (match as any).scopeHash;
          if (snapshotCacheManager.isScopeValid(tabId, numericRef, currentScopeHash)) {
            warningToReport = undefined;
          }
        }
        if ((match as any).warning) {
          warningToReport = warningToReport
            ? `${warningToReport}; ${(match as any).warning}`
            : (match as any).warning;
        }

        return {
          success: true,
          x: match.x,
          y: match.y,
          resolutionPath: 'ref',
          index: typeof rawRef === 'number' ? rawRef : match.index,
          tagName: match.tagName,
          inputType: match.inputType,
          text: match.text,
          value: match.value,
          role: match.role,
          isClickable: match.isClickable,
          frameId: targetFrameId,
          frameOffsetX: match.frameOffsetX,
          frameOffsetY: match.frameOffsetY,
          attributes: match.attributes,
          isComposer: (match as any).isComposer,
          isEditor: (match as any).isEditor,
          isSearch: (match as any).isSearch,
          isSelectOption: Boolean((match as any).isSelectOption || match.tagName === 'option'),
          scopeHash: (match as any).scopeHash,
          warning: warningToReport,
        };
      }
    } catch (e) {
      return {
        success: false,
        x: 0,
        y: 0,
        resolutionPath: 'ref',
        error: `Ref resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // 2. Secondary: Try CSS / XPath selector (Zero requests on exact unique match, fail closed on error/ambiguity, no guessing)
  if (hasSelector && deps.executeInPage) {
    try {
      const outcome = await resolveAcrossFrames(
        deps.executeInPage,
        tabId,
        'inPageLocateBySelector',
        [options.selector!, options.selectorType],
        options.selector!,
        'selector',
        options.frameId,
        { signal: options.signal, deadlineAt: options.deadlineAt },
      );

      if (
        outcome.status === 'ambiguous' ||
        outcome.status === 'error' ||
        outcome.status === 'cancelled' ||
        outcome.status === 'timeout'
      ) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'selector',
          error: outcome.error,
          dispatched: false,
          requestDispatched: false,
          ...(outcome.status === 'cancelled' || outcome.status === 'timeout'
            ? { status: outcome.status }
            : {}),
        };
      }

      if (outcome.status === 'found') {
        const match = outcome.match;
        const targetFrameId = outcome.frameId;

        return {
          success: true,
          x: match.x,
          y: match.y,
          resolutionPath: 'selector',
          index: match.index,
          tagName: match.tagName,
          inputType: match.inputType,
          text: match.text,
          value: match.value,
          role: match.role,
          isClickable: match.isClickable,
          frameId: targetFrameId,
          frameOffsetX: match.frameOffsetX,
          frameOffsetY: match.frameOffsetY,
          attributes: match.attributes,
          isComposer: (match as any).isComposer,
          isEditor: (match as any).isEditor,
          isSearch: (match as any).isSearch,
        };
      }
    } catch (e) {
      return {
        success: false,
        x: 0,
        y: 0,
        resolutionPath: 'selector',
        error: `Selector resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  let textOrRoleMissed = false;

  // 3. Tertiary: Try visible text, ARIA role, or associated label
  if (hasTextOrRole && deps.executeInPage) {
    const targetPath = targetLabel ? 'label' : options.role ? 'role' : 'text';
    const legacyComposer = options.role === 'textbox' && options.preferComposer === true;
    const fnName = targetLabel
      ? 'inPageLocateByLabel'
      : legacyComposer
        ? 'inPageLocateByText'
        : options.role
          ? 'inPageLocateByRole'
          : 'inPageLocateByText';
    const fnArgs = targetLabel
      ? [targetLabel, { exact: options.exact === true }]
      : legacyComposer
        ? [targetText || '', 'composer']
        : options.role
          ? [options.role, { name: targetText || '', exact: options.exact === true }]
          : [targetText || '', { mode: 'text', exact: options.exact === true }];
    try {
      const outcome = await resolveAcrossFrames(
        deps.executeInPage,
        tabId,
        fnName,
        fnArgs,
        targetLabel || targetText || options.role || '',
        targetPath,
        options.frameId,
        { signal: options.signal, deadlineAt: options.deadlineAt },
      );

      if (
        outcome.status === 'ambiguous' ||
        outcome.status === 'error' ||
        outcome.status === 'cancelled' ||
        outcome.status === 'timeout'
      ) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: targetPath,
          error: outcome.error,
          dispatched: false,
          requestDispatched: false,
          ...(outcome.status === 'cancelled' || outcome.status === 'timeout'
            ? { status: outcome.status }
            : {}),
        };
      }

      if (outcome.status === 'found') {
        const match = outcome.match;
        const targetFrameId = outcome.frameId;

        return {
          success: true,
          x: match.x,
          y: match.y,
          resolutionPath: targetPath,
          index: match.index,
          tagName: match.tagName,
          inputType: match.inputType,
          text: match.text,
          value: match.value,
          role: match.role,
          isClickable: match.isClickable,
          frameId: targetFrameId,
          frameOffsetX: match.frameOffsetX,
          frameOffsetY: match.frameOffsetY,
          attributes: match.attributes,
          isComposer: (match as any).isComposer,
          isEditor: (match as any).isEditor,
          isSearch: (match as any).isSearch,
        };
      }
      textOrRoleMissed = outcome.status === 'none';
    } catch (e) {
      return {
        success: false,
        x: 0,
        y: 0,
        resolutionPath: targetPath,
        error: `Text/role resolution failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  // 4. Fallback: Visual Coordinate Mode
  if (hasCoordinate) {
    if (wantsScreenshotSpace) {
      if (!options.captureId) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'coordinate',
          error:
            'coordinateSpace "screenshot" requires an explicit captureId from a fresh screenshot. Capture a fresh screenshot and pass its captureId before using coordinate fallback.',
        };
      }
      if (!deps.validateScreenshotCoordinateBinding) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'coordinate',
          error: 'Screenshot coordinate validation is unavailable in this locator context.',
        };
      }
      const validation = await deps.validateScreenshotCoordinateBinding({
        tabId,
        captureId: options.captureId,
        coordinateSpace: options.coordinateSpace,
      });
      if (validation.error) {
        return {
          success: false,
          x: 0,
          y: 0,
          resolutionPath: 'coordinate',
          error: validation.error,
        };
      }
    }

    const rawX = parsedCoord ? parsedCoord.x : Number((coordParam as any)?.x ?? 0);
    const rawY = parsedCoord ? parsedCoord.y : Number((coordParam as any)?.y ?? 0);

    let targetX = Math.round(rawX);
    let targetY = Math.round(rawY);

    if (
      deps.coordinateScaler &&
      wantsScreenshotSpace &&
      !parsedCoord &&
      typeof (coordParam as any)?.x === 'number' &&
      typeof (coordParam as any)?.y === 'number'
    ) {
      const scaled = deps.coordinateScaler(tabId, (coordParam as any).x, (coordParam as any).y);
      targetX = scaled.x;
      targetY = scaled.y;
    }

    let coordinateWarning: string | undefined = undefined;

    if (deps.sendCdpCommand) {
      try {
        const locRes: any = await deps.sendCdpCommand(tabId, 'DOM.getNodeForLocation', {
          x: targetX,
          y: targetY,
          includeUserAgentShadowDOM: true,
          ignorePointerEventsNone: false,
        });

        if (locRes && locRes.backendNodeId) {
          const boxRes: any = await deps
            .sendCdpCommand(tabId, 'DOM.getBoxModel', {
              backendNodeId: locRes.backendNodeId,
            })
            .catch(() => null);

          if (boxRes && boxRes.model) {
            const width = boxRes.model.width || 0;
            const height = boxRes.model.height || 0;
            if (width <= 0 || height <= 0) {
              coordinateWarning = `Target element at (${targetX}, ${targetY}) has zero dimensions or may be invisible according to CDP box model.`;
              console.warn(
                `[UnifiedLocator] Target at (${targetX}, ${targetY}) has 0 dimensions in box model`,
              );
            }
          }
        }
      } catch (cdpCheckErr) {
        console.warn(
          '[UnifiedLocator] CDP coordinate visibility check non-fatal notice:',
          cdpCheckErr,
        );
      }
    }

    return {
      success: true,
      x: targetX,
      y: targetY,
      resolutionPath: 'coordinate',
      tagName: 'visual_target',
      frameId: 0,
      warning: coordinateWarning,
    };
  }

  const invalidationPrefix = invalidationWarning ? `[Snapshot Stale: ${invalidationWarning}] ` : '';
  return {
    success: false,
    x: 0,
    y: 0,
    resolutionPath: hasRef
      ? 'ref'
      : hasSelector
        ? 'selector'
        : targetLabel
          ? 'label'
          : options.role
            ? 'role'
            : 'text',
    notFound: textOrRoleMissed,
    error: `${invalidationPrefix}Target not found using degradation chain (ref -> selector -> text -> coordinate). Specify a valid ref, selector, text, or coordinates.`,
  };
}
