import { cdpSessionManager } from './cdp-session-manager';

export interface FramePoint {
  x: number;
  y: number;
}

// A frame's content quad maps its viewport into its parent's renderer viewport.
export function projectPointThroughQuad(
  point: FramePoint,
  width: number,
  height: number,
  quad: number[],
): FramePoint {
  if (
    ![point.x, point.y, width, height, ...quad].every(Number.isFinite) ||
    width <= 0 ||
    height <= 0 ||
    quad.length !== 8
  )
    throw new Error('Invalid frame projection geometry');
  const [x0, y0, x1, y1, x2, y2, x3, y3] = quad;
  const turns = [0, 1, 2, 3].map((i) => {
    const j = (i + 1) % 4;
    const k = (i + 2) % 4;
    return (
      (quad[j * 2] - quad[i * 2]) * (quad[k * 2 + 1] - quad[j * 2 + 1]) -
      (quad[j * 2 + 1] - quad[i * 2 + 1]) * (quad[k * 2] - quad[j * 2])
    );
  });
  if (!turns.every((v) => v > 1e-8) && !turns.every((v) => v < -1e-8)) {
    throw new Error('Degenerate or folded frame content quad');
  }
  const dx1 = x1 - x2,
    dx2 = x3 - x2,
    dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2,
    dy2 = y3 - y2,
    dy3 = y0 - y1 + y2 - y3;
  let g = 0,
    h = 0;
  if (Math.abs(dx3) > 1e-8 || Math.abs(dy3) > 1e-8) {
    const determinant = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(determinant) < 1e-8) throw new Error('Singular frame projection');
    g = (dx3 * dy2 - dx2 * dy3) / determinant;
    h = (dx1 * dy3 - dx3 * dy1) / determinant;
  }
  const u = point.x / width,
    v = point.y / height;
  const denominator = g * u + h * v + 1;
  if (denominator <= 1e-8) throw new Error('Frame projection crosses the perspective horizon');
  const result = {
    x: ((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / denominator,
    y: ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / denominator,
  };
  if (!Number.isFinite(result.x) || !Number.isFinite(result.y)) {
    throw new Error('Nonfinite frame projection');
  }
  return result;
}

interface FrameContext {
  sessionId?: string;
  frameId: string;
  rootFrameId: string;
  contextId: number;
}

async function boundedInjection<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Frame identity injection timed out')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function projectFramePoint(
  tabId: number,
  frameId: number,
  point: FramePoint,
): Promise<FramePoint> {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Invalid frame point');
  }
  if (frameId === 0) return point;
  const frameDocument = await chrome.webNavigation.getFrame({ tabId, frameId });
  if (!frameDocument?.documentId) throw new Error(`Frame ${frameId} has no active document`);
  const target = { tabId, documentIds: [frameDocument.documentId] };
  const marker = 'data-bp-frame-' + crypto.randomUUID();
  const cleanup = () =>
    boundedInjection(
      chrome.scripting.executeScript({
        target,
        func: (attribute: string) => document.documentElement.removeAttribute(attribute),
        args: [marker],
      }),
    ).catch(() => {});
  let abandoned = false;
  try {
    const stamp = chrome.scripting.executeScript({
      target,
      func: (attribute: string) => {
        document.documentElement.setAttribute(attribute, '1');
        return { width: innerWidth, height: innerHeight };
      },
      args: [marker],
    });
    // A timed-out injection can still execute after the first cleanup.
    void stamp
      .then(() => {
        if (abandoned) void cleanup();
      })
      .catch(() => {});
    const stamped = await boundedInjection(stamp);
    const viewport = stamped[0]?.result;
    if (!viewport || viewport.width <= 0 || viewport.height <= 0) {
      throw new Error(`Frame ${frameId} has no usable viewport`);
    }
    const sessions = await cdpSessionManager.ensureFrameSessions(tabId);
    const send = (
      sessionId: string | undefined,
      method: string,
      params: object = {},
    ): Promise<any> => cdpSessionManager.sendFrameCommand(tabId, sessionId, method, params);
    const trees = new Map<string | undefined, any>();
    const candidates: Array<{ sessionId?: string; frameId: string; rootFrameId: string }> = [];
    for (const sessionId of [undefined, ...sessions.map((session) => session.sessionId)]) {
      const tree = (await send(sessionId, 'Page.getFrameTree')).frameTree;
      if (!tree?.frame?.id) throw new Error('Missing renderer frame tree');
      trees.set(sessionId, tree);
      const visit = (node: any) => {
        if (typeof node?.frame?.id !== 'string') return;
        candidates.push({ sessionId, frameId: node.frame.id, rootFrameId: tree.frame.id });
        for (const child of node.childFrames ?? []) visit(child);
      };
      visit(tree);
    }
    let context: FrameContext | undefined;
    for (const candidate of candidates) {
      let world: any;
      try {
        world = await send(candidate.sessionId, 'Page.createIsolatedWorld', {
          frameId: candidate.frameId,
          worldName: 'browserpaw-frame-projection',
        });
      } catch {
        continue; // An OOPIF's parent renderer cannot create its execution context.
      }
      if (!Number.isInteger(world?.executionContextId)) continue;
      const probe = await send(candidate.sessionId, 'Runtime.evaluate', {
        contextId: world.executionContextId,
        expression: `document.documentElement.hasAttribute(${JSON.stringify(marker)})`,
        returnByValue: true,
      });
      if (probe?.result?.value === true) {
        if (context) throw new Error('Ambiguous frame document identity');
        context = { ...candidate, contextId: world.executionContextId };
      }
    }
    if (!context) throw new Error(`Frame ${frameId} is not in this tab's confirmed sessions`);

    let projected = point;
    let currentFrameId = context.frameId;
    let currentSessionId = context.sessionId;
    let size = viewport;
    const visited = new Set<string>();
    while (currentFrameId !== trees.get(undefined)?.frame.id) {
      const key = `${currentSessionId ?? ''}:${currentFrameId}`;
      if (visited.has(key)) throw new Error('Cyclic frame ownership');
      visited.add(key);
      const localRoot = trees.get(currentSessionId)?.frame.id;
      const parentSessionId =
        currentFrameId === localRoot
          ? sessions.find((session) => session.sessionId === currentSessionId)?.parentSessionId
          : currentSessionId;
      if (currentFrameId === localRoot && !currentSessionId) {
        throw new Error('Frame ownership did not reach the top document');
      }
      const owner = await send(parentSessionId, 'DOM.getFrameOwner', { frameId: currentFrameId });
      if (!owner?.backendNodeId) throw new Error('Missing frame owner');
      await send(parentSessionId, 'DOM.scrollIntoViewIfNeeded', {
        backendNodeId: owner.backendNodeId,
      });
      const box = await send(parentSessionId, 'DOM.getBoxModel', {
        backendNodeId: owner.backendNodeId,
      });
      projected = projectPointThroughQuad(
        projected,
        size.width,
        size.height,
        box?.model?.content ?? [],
      );
      currentSessionId = parentSessionId;
      currentFrameId = trees.get(currentSessionId)?.frame.id;
      if (!currentFrameId) throw new Error('Missing parent renderer');
      if (currentSessionId !== undefined) {
        const world = await send(currentSessionId, 'Page.createIsolatedWorld', {
          frameId: currentFrameId,
          worldName: 'browserpaw-frame-projection',
        });
        const dimensions = await send(currentSessionId, 'Runtime.evaluate', {
          contextId: world.executionContextId,
          expression: '({width:innerWidth,height:innerHeight})',
          returnByValue: true,
        });
        size = dimensions?.result?.value;
        if (!size || size.width <= 0 || size.height <= 0)
          throw new Error('Missing parent viewport');
      }
    }
    const finalViewport = await send(context.sessionId, 'Runtime.evaluate', {
      contextId: context.contextId,
      expression: `({marked:document.documentElement.hasAttribute(${JSON.stringify(marker)}),width:innerWidth,height:innerHeight})`,
      returnByValue: true,
    });
    const final = finalViewport?.result?.value;
    if (!final?.marked || final.width !== viewport.width || final.height !== viewport.height) {
      throw new Error('Frame viewport changed during projection');
    }
    const active = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (active?.documentId !== frameDocument.documentId)
      throw new Error('Frame navigated during projection');
    return projected;
  } finally {
    abandoned = true;
    await cleanup();
  }
}
