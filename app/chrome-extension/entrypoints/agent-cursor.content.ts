export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: false,
  runAt: 'document_start',
  main() {
    initAgentCursor();
  },
});

// ============================================================================
// BrowserPaw Virtual Mouse (Agent Cursor) - 1:1 ChatGPT Physics Replica
// ============================================================================

interface Point {
  x: number;
  y: number;
}

interface SpringConfig {
  dampingFraction: number;
  response: number;
}

interface SpringState {
  value: number;
  target: number;
  velocity: number;
  force: number;
  dampingFraction: number;
  response: number;
  scriptTime: number;
  simulationTime: number;
}

interface BezierSegment {
  control1: Point;
  control2: Point;
  end: Point;
}

interface BezierPath {
  start: Point;
  startControl: Point;
  end: Point;
  endControl: Point;
  arc: Point | null;
  arcIn: Point | null;
  arcOut: Point | null;
  segments: BezierSegment[];
}

const CURSOR_BASE_SCALE = 0.9;
const CURSOR_SIZE = 24;
const HALF_SIZE = CURSOR_SIZE / 2;
const ASSET_WIDTH = 23;
const ASSET_HEIGHT = 24;
const ASSET_OFFSET_X = 12;
const ASSET_OFFSET_Y = -2.5;
const ASSET_ROTATION_DEG = 44;
const GLOW_CSS_VAR = '--browser-agent-cursor-glow-color';
const GLOW_COLOR = '#339cff';
const GLOW_FILTER = `drop-shadow(0 2px 6px rgba(0, 0, 0, 0.32)) drop-shadow(0 0 3px color-mix(in srgb, var(${GLOW_CSS_VAR}) 40%, transparent))`;

const DT_STEP = 1 / 240;
const FRAME_DURATION = 1 / 60;
const DISTANCE_THRESHOLD_SCOOT = 196;
const VELOCITY_THRESHOLD_ARRIVED = 12;
const POSITION_THRESHOLD_ARRIVED = 0.85;

const SPRING_POS: SpringConfig = { dampingFraction: 0.92, response: 0.11 };
const SPRING_ROT: SpringConfig = { dampingFraction: 0.9, response: 0.08 };
const SPRING_STRETCH: SpringConfig = { dampingFraction: 0.85, response: 0.2 };
const SPRING_VISIBILITY: SpringConfig = { dampingFraction: 0.86, response: 0.42 };
const SPRING_SCOOT_AXIS: SpringConfig = { dampingFraction: 0.9, response: 0.09 };
const SPRING_SCOOT_ROT: SpringConfig = { dampingFraction: 0.82, response: 0.045 };
const SPRING_SCOOT_STRETCH: SpringConfig = { dampingFraction: 0.86, response: 0.09 };

function createSpring(val: number, target: number, cfg: SpringConfig): SpringState {
  return {
    value: val,
    target,
    velocity: 0,
    force: 0,
    dampingFraction: cfg.dampingFraction,
    response: cfg.response,
    scriptTime: 0,
    simulationTime: 0,
  };
}

function resetSpring(s: SpringState, val: number) {
  s.value = val;
  s.target = val;
  s.velocity = 0;
  s.force = 0;
  s.scriptTime = 0;
  s.simulationTime = 0;
}

function stepSpringSub(s: SpringState, stiffness: number, damping: number) {
  const halfDt = DT_STEP / 2;
  const velMid = s.velocity + s.force * halfDt;
  s.value += velMid * DT_STEP;
  s.force = velMid * -damping + (s.target - s.value) * stiffness;
  s.velocity = velMid + s.force * halfDt;
}

function isSpringSettled(s: SpringState): boolean {
  const velSqr = s.velocity * s.velocity;
  const forceSqr = s.force * s.force;
  if (Math.max(velSqr, forceSqr) > 0.001 * 0.001 * 3600) return false;
  const diff = s.target - s.value;
  return Math.abs(diff) <= 0.005;
}

function stepSpring(s: SpringState, dt: number) {
  const resp = Math.max(0.001, s.response);
  const maxStiffness = 1 / (2 * DT_STEP * DT_STEP);
  const stiffness = Math.min((Math.PI * 2) ** 2 / (resp * resp), maxStiffness);
  const damping = Math.sqrt(stiffness) * 2 * s.dampingFraction;

  s.scriptTime += Math.max(0, dt);
  if (s.scriptTime - s.simulationTime > 1) {
    s.simulationTime = s.scriptTime - FRAME_DURATION;
  }
  while (s.simulationTime < s.scriptTime) {
    stepSpringSub(s, stiffness, damping);
    s.simulationTime += DT_STEP;
  }
  if (isSpringSettled(s)) {
    s.value = s.target;
  }
}

function dist(a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function distToSegment(p1: Point, p2: Point, p: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p1, p);
  const t = Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / l2));
  const projection = {
    x: p1.x + t * dx,
    y: p1.y + t * dy,
  };
  return dist(p, projection);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function normAngle(deg: number): number {
  const m = deg % 360;
  return m < 0 ? m + 360 : m;
}

function angleDiff(from: number, to: number): number {
  let d = to - from;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

function setAngleTarget(s: SpringState, targetDeg: number) {
  s.target = s.value + angleDiff(s.value, targetDeg);
}

function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const it = 1 - t;
  const c0 = it * it * it;
  const c1 = 3 * it * it * t;
  const c2 = 3 * it * t * t;
  const c3 = t * t * t;
  return {
    x: p0.x * c0 + p1.x * c1 + p2.x * c2 + p3.x * c3,
    y: p0.y * c0 + p1.y * c1 + p2.y * c2 + p3.y * c3,
  };
}

function cubicBezierTangent(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const it = 1 - t;
  return {
    x: 3 * it * it * (p1.x - p0.x) + 6 * it * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
    y: 3 * it * it * (p1.y - p0.y) + 6 * it * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
  };
}

function evaluateBezierPath(path: BezierPath, t: number): { point: Point; tangent: Point } {
  const cl = clamp(t, 0, 1);
  const segIndex = cl === 1 ? path.segments.length - 1 : Math.floor(cl * path.segments.length);
  const seg = path.segments[segIndex] || path.segments[0];
  const startPt = segIndex === 0 ? path.start : path.segments[segIndex - 1].end;
  const localT = cl === 1 ? 1 : cl * path.segments.length - segIndex;
  return {
    point: cubicBezier(startPt, seg.control1, seg.control2, seg.end, localT),
    tangent: cubicBezierTangent(startPt, seg.control1, seg.control2, seg.end, localT),
  };
}

function tangentToDegrees(tangent: Point): number {
  const len = Math.sqrt(tangent.x * tangent.x + tangent.y * tangent.y);
  if (len < 0.001) return normAngle(-44);
  return normAngle(Math.atan2(tangent.y / len, tangent.x / len) * (180 / Math.PI) + 90);
}

function buildArcCandidates(
  start: Point,
  end: Point,
  bounds: { width: number; height: number },
): BezierPath {
  const d = dist(start, end);
  const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const normal = d > 0 ? { x: -(end.y - start.y) / d, y: (end.x - start.x) / d } : { x: 0, y: -1 };
  const naturalArcRatio = 0.18;
  const maxArcForDist = Math.max(6, d * 0.28);
  const minArc = Math.min(8, d * 0.2);
  const arcHeight = clamp(d * naturalArcRatio, minArc, Math.min(160, maxArcForDist));
  let arcPt = { x: mid.x + normal.x * arcHeight, y: mid.y + normal.y * arcHeight };

  // Keep arc within viewport margins
  const margin = 36;
  if (
    arcPt.x < margin ||
    arcPt.x > bounds.width - margin ||
    arcPt.y < margin ||
    arcPt.y > bounds.height - margin
  ) {
    const invertedPt = { x: mid.x - normal.x * arcHeight, y: mid.y - normal.y * arcHeight };
    if (
      invertedPt.x >= margin &&
      invertedPt.x <= bounds.width - margin &&
      invertedPt.y >= margin &&
      invertedPt.y <= bounds.height - margin
    ) {
      arcPt = invertedPt;
    } else {
      arcPt = {
        x: clamp(arcPt.x, margin, bounds.width - margin),
        y: clamp(arcPt.y, margin, bounds.height - margin),
      };
    }
  }

  return {
    start,
    startControl: {
      x: start.x + (arcPt.x - start.x) * 0.5,
      y: start.y + (arcPt.y - start.y) * 0.5,
    },
    end,
    endControl: { x: end.x + (arcPt.x - end.x) * 0.5, y: end.y + (arcPt.y - end.y) * 0.5 },
    arc: arcPt,
    arcIn: null,
    arcOut: null,
    segments: [
      {
        control1: {
          x: start.x + (arcPt.x - start.x) * 0.45,
          y: start.y + (arcPt.y - start.y) * 0.45,
        },
        control2: { x: arcPt.x - (end.x - start.x) * 0.15, y: arcPt.y - (end.y - start.y) * 0.15 },
        end: arcPt,
      },
      {
        control1: { x: arcPt.x + (end.x - start.x) * 0.15, y: arcPt.y + (end.y - start.y) * 0.15 },
        control2: { x: end.x - (end.x - arcPt.x) * 0.45, y: end.y - (end.y - arcPt.y) * 0.45 },
        end,
      },
    ],
  };
}

interface AgentCursorState {
  point: Point;
  rotation: number;
  scootAxisRotation: number;
  thinkStartedAt: number | null;
  positionXSpring: SpringState;
  positionYSpring: SpringState;
  rotationSpring: SpringState;
  stretchSpring: SpringState;
  visibilitySpring: SpringState;
  scootAxisSpring: SpringState;
  scootRotationSpring: SpringState;
  scootStretchSpring: SpringState;
  motion:
    | {
        mode: 'scoot';
        start: Point;
        end: Point;
        axisRotation: number;
        rotationTarget: number;
        progressSpring: SpringState;
      }
    | { mode: 'bezier'; path: BezierPath; progressSpring: SpringState }
    | null;
}

function initCursorState(pt: Point): AgentCursorState {
  return {
    point: pt,
    rotation: normAngle(-44),
    scootAxisRotation: 0,
    thinkStartedAt: null,
    positionXSpring: createSpring(pt.x, pt.x, SPRING_POS),
    positionYSpring: createSpring(pt.y, pt.y, SPRING_POS),
    rotationSpring: createSpring(normAngle(-44), normAngle(-44), SPRING_ROT),
    stretchSpring: createSpring(1, 1, SPRING_STRETCH),
    visibilitySpring: createSpring(0, 0, SPRING_VISIBILITY),
    scootAxisSpring: createSpring(0, 0, SPRING_SCOOT_AXIS),
    scootRotationSpring: createSpring(0, 0, SPRING_SCOOT_ROT),
    scootStretchSpring: createSpring(1, 1, SPRING_SCOOT_STRETCH),
    motion: null,
  };
}

function initAgentCursor() {
  if (window.top !== window.self) return; // Top-level window only

  const OVERLAY_ROOT_ID = 'codex-agent-overlay-root';
  const existing = document.getElementById(OVERLAY_ROOT_ID);
  if (existing) return;

  const host = document.createElement('div');
  host.id = OVERLAY_ROOT_ID;
  host.dataset.browserpawAgentOverlayRoot = 'true';
  host.dataset.browserclawAgentOverlayRoot = 'true';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    .codex-agent-overlay {
      all: initial;
      z-index: 2147483646;
      pointer-events: none;
      position: fixed;
      inset: 0;
    }
    @media print {
      .codex-agent-overlay {
        display: none;
      }
    }
  `;
  shadow.appendChild(style);

  const overlay = document.createElement('div');
  overlay.className = 'codex-agent-overlay';
  overlay.setAttribute('aria-hidden', 'true');

  const cursorContainer = document.createElement('div');
  cursorContainer.style.position = 'absolute';
  cursorContainer.style.width = `${CURSOR_SIZE}px`;
  cursorContainer.style.height = `${CURSOR_SIZE}px`;
  cursorContainer.style.left = '0';
  cursorContainer.style.top = '0';
  cursorContainer.style.transformOrigin = `${HALF_SIZE}px ${HALF_SIZE}px`;
  cursorContainer.style.willChange = 'transform, opacity, filter';
  cursorContainer.style.opacity = '0';
  cursorContainer.style.visibility = 'hidden';

  const offsetWrapper = document.createElement('div');
  offsetWrapper.style.transform = `translate3d(${ASSET_OFFSET_X}px, ${ASSET_OFFSET_Y}px, 0)`;

  const assetImg = document.createElement('img');
  assetImg.alt = '';
  assetImg.draggable = false;
  assetImg.width = ASSET_WIDTH;
  assetImg.height = ASSET_HEIGHT;
  assetImg.src = chrome.runtime.getURL('images/cursor-chat.png');
  assetImg.style.display = 'block';
  assetImg.style.setProperty(GLOW_CSS_VAR, GLOW_COLOR);
  assetImg.style.filter = GLOW_FILTER;
  assetImg.style.transform = `rotate(${ASSET_ROTATION_DEG}deg) scale(1)`;
  assetImg.style.transformOrigin = '0 0';

  offsetWrapper.appendChild(assetImg);
  cursorContainer.appendChild(offsetWrapper);
  overlay.appendChild(cursorContainer);

  // Click ripple element
  const clickRipple = document.createElement('div');
  clickRipple.style.position = 'absolute';
  clickRipple.style.left = '0';
  clickRipple.style.top = '0';
  clickRipple.style.width = '32px';
  clickRipple.style.height = '32px';
  clickRipple.style.marginLeft = '-16px';
  clickRipple.style.marginTop = '-16px';
  clickRipple.style.borderRadius = '50%';
  clickRipple.style.pointerEvents = 'none';
  clickRipple.style.border = '2.5px solid #339cff';
  clickRipple.style.boxShadow = '0 0 10px #339cff, inset 0 0 6px #339cff';
  clickRipple.style.transform = 'scale(0)';
  clickRipple.style.opacity = '0';
  overlay.appendChild(clickRipple);

  // Action Note Tooltip (1:1 with Reference Video pCfdTz2KS1i7qtOM.mp4)
  const actionTooltip = document.createElement('div');
  actionTooltip.className = 'codex-agent-tooltip';
  actionTooltip.style.position = 'absolute';
  actionTooltip.style.left = '0';
  actionTooltip.style.top = '0';
  actionTooltip.style.pointerEvents = 'none';
  actionTooltip.style.userSelect = 'none';
  actionTooltip.style.zIndex = '2147483647';
  actionTooltip.style.display = 'flex';
  actionTooltip.style.alignItems = 'center';
  actionTooltip.style.gap = '6px';
  actionTooltip.style.padding = '5px 12px';
  actionTooltip.style.background = 'rgba(24, 24, 27, 0.94)';
  actionTooltip.style.backdropFilter = 'blur(12px)';
  actionTooltip.style.setProperty('-webkit-backdrop-filter', 'blur(12px)');
  actionTooltip.style.border = '1px solid rgba(255, 255, 255, 0.14)';
  actionTooltip.style.borderRadius = '8px';
  actionTooltip.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.2)';
  actionTooltip.style.color = '#ffffff';
  actionTooltip.style.fontFamily =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  actionTooltip.style.fontSize = '12px';
  actionTooltip.style.fontWeight = '500';
  actionTooltip.style.lineHeight = '16px';
  actionTooltip.style.whiteSpace = 'nowrap';
  actionTooltip.style.opacity = '0';
  actionTooltip.style.transform = 'translate3d(0, 0, 0) scale(0.92)';
  actionTooltip.style.transformOrigin = 'center center';
  actionTooltip.style.transition =
    'opacity 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)';
  actionTooltip.style.willChange = 'transform, opacity';

  const tooltipText = document.createElement('span');
  tooltipText.style.overflow = 'hidden';
  tooltipText.style.textOverflow = 'ellipsis';
  tooltipText.style.maxWidth = '340px';
  actionTooltip.appendChild(tooltipText);
  overlay.appendChild(actionTooltip);

  let tooltipHideTimer: number | null = null;
  let typewriterTimer: number | null = null;
  let caretRemoveTimer: number | null = null;
  let currentNoteText = '';
  let tooltipVisible = false;

  const updateTooltipPosition = (scale = 1) => {
    if (!tooltipVisible) return;
    const tooltipWidth = actionTooltip.offsetWidth || 140;
    const tooltipHeight = actionTooltip.offsetHeight || 28;
    // Horizontally centered below cursor
    let tx = Math.round(cursorState.point.x - tooltipWidth / 2 + 10);
    tx = clamp(tx, 12, window.innerWidth - tooltipWidth - 12);

    // Below cursor by default, flip above if near bottom edge
    let ty = Math.round(cursorState.point.y + 24);
    if (ty + tooltipHeight > window.innerHeight - 10) {
      ty = Math.round(cursorState.point.y - tooltipHeight - 12);
    }
    ty = clamp(ty, 8, window.innerHeight - tooltipHeight - 8);

    actionTooltip.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  };

  const showActionNote = (noteText: string, autoHideMs = 2800) => {
    if (cursorMode === 'off') {
      hideActionNote();
      return;
    }
    const text = (noteText || '').trim();
    if (!text) {
      hideActionNote();
      return;
    }
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }

    tooltipVisible = true;
    agentActiveUntil = Math.max(agentActiveUntil, Date.now() + Math.max(3000, autoHideMs));
    actionTooltip.style.opacity = '1';

    if (text !== currentNoteText) {
      currentNoteText = text;
      if (typewriterTimer) {
        clearInterval(typewriterTimer);
        typewriterTimer = null;
      }
      if (caretRemoveTimer) {
        clearTimeout(caretRemoveTimer);
        caretRemoveTimer = null;
      }

      // Smooth typewriter reveal (1:1 with reference video pCfdTz2KS1i7qtOM.mp4)
      if (text.length <= 40) {
        let charIndex = 0;
        tooltipText.textContent = '';
        const caret = document.createElement('span');
        caret.className = 'codex-agent-caret';
        caret.textContent = '|';
        caret.style.display = 'inline-block';
        caret.style.marginLeft = '1px';
        caret.style.opacity = '0.9';
        caret.style.fontWeight = '300';
        caret.style.color = '#93c5fd';

        typewriterTimer = window.setInterval(() => {
          charIndex++;
          if (charIndex <= text.length) {
            tooltipText.textContent = text.slice(0, charIndex);
            tooltipText.appendChild(caret);
            updateTooltipPosition(1);
          } else {
            if (typewriterTimer) {
              clearInterval(typewriterTimer);
              typewriterTimer = null;
            }
            if (caretRemoveTimer) {
              clearTimeout(caretRemoveTimer);
            }
            caretRemoveTimer = window.setTimeout(() => {
              caretRemoveTimer = null;
              if (caret.parentNode) caret.remove();
              updateTooltipPosition(1);
            }, 500);
          }
        }, 20);
      } else {
        tooltipText.textContent = text;
      }
    }

    updateTooltipPosition(1);

    if (autoHideMs > 0) {
      tooltipHideTimer = window.setTimeout(() => {
        hideActionNote();
      }, autoHideMs);
    }
  };

  const hideActionNote = () => {
    if (tooltipHideTimer) {
      clearTimeout(tooltipHideTimer);
      tooltipHideTimer = null;
    }
    if (typewriterTimer) {
      clearInterval(typewriterTimer);
      typewriterTimer = null;
    }
    if (caretRemoveTimer) {
      clearTimeout(caretRemoveTimer);
      caretRemoveTimer = null;
    }
    currentNoteText = '';
    actionTooltip.style.opacity = '0';
    updateTooltipPosition(0.92);
    tooltipVisible = false;
  };

  const resetAutoIdleTimer = () => {
    if (cursorMode !== 'auto') return;
    if (autoIdleTimer) clearTimeout(autoIdleTimer);
    // Attentive idle period: cursor stays visible in gentle standby for 3.5s
    autoIdleTimer = window.setTimeout(() => {
      if (!cursorState.motion) {
        hideCursor();
        hideActionNote();
      }
    }, 3500);
  };

  const triggerClickAnimation = (clickX?: number, clickY?: number, note?: string) => {
    if (cursorMode === 'off') return;
    const cx = typeof clickX === 'number' ? clickX : cursorState.point.x;
    const cy = typeof clickY === 'number' ? clickY : cursorState.point.y;
    const currentDist = dist(cursorState.point, { x: cx, y: cy });
    agentActiveUntil = Math.max(agentActiveUntil, Date.now() + 2500);

    cursorState.visibilitySpring.value = 1;
    cursorState.visibilitySpring.target = 1;

    // STRICTLY FORBID TELEPORTATION:
    // If cursor is not yet at click point (>2px), target smoothly without snapping
    if (currentDist > 2) {
      cursorState.positionXSpring.target = cx;
      cursorState.positionYSpring.target = cy;
    } else {
      cursorState.point = { x: cx, y: cy };
      cursorState.positionXSpring.target = cx;
      cursorState.positionYSpring.target = cy;
    }
    renderCursor();
    startAnimationLoop();

    if (note) {
      showActionNote(note);
    }
    // Dynamic multi-ripple spawn (ensures rapid double/triple clicks render distinct concentric ripples)
    const ripple = clickRipple.cloneNode(true) as HTMLDivElement;
    ripple.style.left = `${cx}px`;
    ripple.style.top = `${cy}px`;
    ripple.style.transform = 'scale(0.2)';
    ripple.style.opacity = '0.95';
    ripple.style.transition = 'none';
    overlay.appendChild(ripple);
    void ripple.offsetWidth;
    ripple.style.transition = 'transform 0.35s cubic-bezier(0, 0, 0.2, 1), opacity 0.35s ease-out';
    ripple.style.transform = 'scale(1.8)';
    ripple.style.opacity = '0';
    setTimeout(() => {
      ripple.remove();
    }, 380);

    // Natural physiological dip on click
    assetImg.style.transition = 'transform 0.08s ease-out';
    assetImg.style.transform = `rotate(${ASSET_ROTATION_DEG}deg) scale(0.84)`;
    setTimeout(() => {
      assetImg.style.transition = 'transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)';
      assetImg.style.transform = `rotate(${ASSET_ROTATION_DEG}deg) scale(1)`;
    }, 85);

    if (cursorMode === 'auto') {
      resetAutoIdleTimer();
    }
  };

  shadow.appendChild(overlay);

  let hasInteracted = false;
  const initialPoint: Point = {
    x: Math.round(window.innerWidth * 0.5),
    y: Math.round(window.innerHeight * 0.5),
  };

  const cursorState = initCursorState(initialPoint);

  let isRunningAnimation = false;
  let lastFrameTime = performance.now();
  let pendingMoveSequence: number | null = null;
  let userTakeoverDetected = false;
  let agentActiveUntil = 0;
  let autoIdleTimer: number | null = null;
  type CursorMode = 'off' | 'auto' | 'always';
  let cursorMode: CursorMode = 'always';

  const hideCursorImmediate = () => {
    cursorState.visibilitySpring.value = 0;
    cursorState.visibilitySpring.target = 0;
    cursorState.thinkStartedAt = null;
    cursorContainer.style.opacity = '0';
    cursorContainer.style.visibility = 'hidden';
    hideActionNote();
  };

  // Load and listen to user-configured cursor mode (off, auto, always)
  try {
    chrome.storage.local.get('agentCursorMode', (data) => {
      if (data?.agentCursorMode) {
        cursorMode = data.agentCursorMode;
        if (cursorMode === 'off') {
          hideCursorImmediate();
        }
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.agentCursorMode) {
        cursorMode = changes.agentCursorMode.newValue || 'always';
        if (cursorMode === 'off') {
          hideCursorImmediate();
        } else if (cursorMode === 'always' && hasInteracted) {
          cursorState.visibilitySpring.target = 1;
          startAnimationLoop();
        }
      }
    });
  } catch {}

  const triggerArrivalCallback = (seq: number | null) => {
    if (seq !== null) {
      chrome.runtime
        .sendMessage({
          type: 'AGENT_CURSOR_ARRIVED',
          moveSequence: seq,
        })
        .catch(() => {});
    }
  };

  const renderCursor = () => {
    const now = performance.now();
    let rotation = cursorState.rotation;

    // Thinking breathing wobble if idle
    if (cursorState.thinkStartedAt !== null) {
      const elapsedSec = (now - cursorState.thinkStartedAt) / 1000;
      if (elapsedSec < 1.41) {
        const envelope = Math.sin(Math.min(1, elapsedSec / 1.41) * Math.PI);
        const wave = Math.sin((elapsedSec / 0.66) * Math.PI * 2) * envelope;
        rotation += wave * 12.5;
      } else {
        cursorState.thinkStartedAt = null;
      }
    }

    const vis = clamp(cursorState.visibilitySpring.value, 0, 1);
    const scaleVis = 0.4 + 0.6 * vis;
    const blurPx = 5 * (1 - vis);
    const stretch = cursorState.stretchSpring.value;
    const scootStretch = clamp(cursorState.scootStretchSpring.value, 0, 1);
    const scootRot = cursorState.scootRotationSpring.value;
    const axisRot = cursorState.scootAxisRotation;

    const transforms: string[] = [
      `translate3d(${Math.round((cursorState.point.x - HALF_SIZE) * 10) / 10}px, ${Math.round((cursorState.point.y - HALF_SIZE) * 10) / 10}px, 0)`,
    ];

    if (Math.abs(axisRot) > 0.001 || Math.abs(scootStretch - 1) > 0.001) {
      transforms.push(
        `rotate(${axisRot}deg)`,
        `scale(1, ${scootStretch})`,
        `rotate(${-axisRot}deg)`,
      );
    }

    transforms.push(
      `rotate(${normAngle(rotation + scootRot)}deg)`,
      `scale(${stretch * scaleVis * CURSOR_BASE_SCALE}, ${scaleVis * CURSOR_BASE_SCALE})`,
    );

    cursorContainer.style.transform = transforms.join(' ');
    if (vis <= 0.001) {
      cursorContainer.style.opacity = '0';
      cursorContainer.style.visibility = 'hidden';
      return;
    }
    cursorContainer.style.visibility = 'visible';
    cursorContainer.style.opacity = `${vis}`;
    cursorContainer.style.filter = `blur(${Math.round(blurPx * 10) / 10}px)`;

    if (tooltipVisible) {
      updateTooltipPosition(1);
    }
  };

  const tick = (time: number) => {
    isRunningAnimation = false;
    const dt = Math.min(0.1, Math.max(FRAME_DURATION, (time - lastFrameTime) / 1000));
    lastFrameTime = time;

    // Step all springs
    stepSpring(cursorState.visibilitySpring, dt);
    stepSpring(cursorState.stretchSpring, dt);
    stepSpring(cursorState.scootStretchSpring, dt);
    stepSpring(cursorState.scootRotationSpring, dt);

    const motion = cursorState.motion;
    let arrivedThisFrame = false;

    if (motion?.mode === 'scoot') {
      stepSpring(motion.progressSpring, dt);
      cursorState.positionXSpring.target = motion.end.x;
      cursorState.positionYSpring.target = motion.end.y;
      setAngleTarget(cursorState.scootAxisSpring, motion.axisRotation);
      setAngleTarget(cursorState.rotationSpring, normAngle(-44));

      const prg = motion.progressSpring.value;
      const sinArc = Math.sin(clamp(prg, 0, 1) * Math.PI);
      cursorState.stretchSpring.target = 1;
      cursorState.scootStretchSpring.target = 1 - sinArc * 0.15;
      cursorState.scootRotationSpring.target = motion.rotationTarget * sinArc;

      stepSpring(cursorState.positionXSpring, dt);
      stepSpring(cursorState.positionYSpring, dt);
      stepSpring(cursorState.rotationSpring, dt);
      stepSpring(cursorState.scootAxisSpring, dt);

      cursorState.point = {
        x: cursorState.positionXSpring.value,
        y: cursorState.positionYSpring.value,
      };
      cursorState.rotation = cursorState.rotationSpring.value;
      cursorState.scootAxisRotation = cursorState.scootAxisSpring.value;

      if (prg >= 0.99 && dist(cursorState.point, motion.end) <= 1.5) {
        cursorState.point = motion.end;
        resetSpring(cursorState.positionXSpring, motion.end.x);
        resetSpring(cursorState.positionYSpring, motion.end.y);
        cursorState.motion = null;
        cursorState.thinkStartedAt = time;
        arrivedThisFrame = true;
      } else if (prg >= 0.98) {
        cursorState.positionXSpring.target = motion.end.x;
        cursorState.positionYSpring.target = motion.end.y;
      }
    } else if (motion?.mode === 'bezier') {
      cursorState.scootStretchSpring.target = 1;
      cursorState.scootRotationSpring.target = 0;
      stepSpring(motion.progressSpring, dt);

      const prg = clamp(motion.progressSpring.value, 0, 1);
      const evalPt = evaluateBezierPath(motion.path, prg);
      const tangentDeg = tangentToDegrees(evalPt.tangent);

      cursorState.positionXSpring.target = evalPt.point.x;
      cursorState.positionYSpring.target = evalPt.point.y;
      setAngleTarget(cursorState.rotationSpring, tangentDeg);
      setAngleTarget(cursorState.scootAxisSpring, 0);

      const prevPt = { ...cursorState.point };
      stepSpring(cursorState.positionXSpring, dt);
      stepSpring(cursorState.positionYSpring, dt);
      stepSpring(cursorState.rotationSpring, dt);
      stepSpring(cursorState.scootAxisSpring, dt);

      cursorState.point = {
        x: cursorState.positionXSpring.value,
        y: cursorState.positionYSpring.value,
      };
      cursorState.rotation = cursorState.rotationSpring.value;
      cursorState.scootAxisRotation = cursorState.scootAxisSpring.value;

      const speed = dist(prevPt, cursorState.point) / dt;
      cursorState.stretchSpring.target = clamp(1 - speed / 5500, 0.65, 1);

      if (prg >= 0.99 && dist(cursorState.point, motion.path.end) <= 1.5) {
        cursorState.point = motion.path.end;
        resetSpring(cursorState.positionXSpring, motion.path.end.x);
        resetSpring(cursorState.positionYSpring, motion.path.end.y);
        resetSpring(cursorState.stretchSpring, 1);
        cursorState.motion = null;
        cursorState.thinkStartedAt = time;
        arrivedThisFrame = true;
      } else if (prg >= 0.98) {
        cursorState.positionXSpring.target = motion.path.end.x;
        cursorState.positionYSpring.target = motion.path.end.y;
      }
    } else {
      // Free spring settling
      stepSpring(cursorState.positionXSpring, dt);
      stepSpring(cursorState.positionYSpring, dt);
      stepSpring(cursorState.rotationSpring, dt);
      cursorState.point = {
        x: cursorState.positionXSpring.value,
        y: cursorState.positionYSpring.value,
      };
      cursorState.rotation = cursorState.rotationSpring.value;
    }

    renderCursor();

    if (arrivedThisFrame) {
      const seq = pendingMoveSequence;
      pendingMoveSequence = null;
      triggerArrivalCallback(seq);
      resetAutoIdleTimer();
    }

    // Check if loop needs to keep ticking
    const isMoving = cursorState.motion !== null;
    const isBreathing = cursorState.thinkStartedAt !== null;
    const isSpringing =
      !isSpringSettled(cursorState.positionXSpring) ||
      !isSpringSettled(cursorState.positionYSpring) ||
      !isSpringSettled(cursorState.rotationSpring) ||
      !isSpringSettled(cursorState.stretchSpring) ||
      !isSpringSettled(cursorState.visibilitySpring);

    if (isMoving || isBreathing || isSpringing) {
      startAnimationLoop();
    }
  };

  const startAnimationLoop = () => {
    if (!isRunningAnimation) {
      isRunningAnimation = true;
      requestAnimationFrame(tick);
    }
  };

  const moveTo = (
    targetX: number,
    targetY: number,
    moveSequence: number | null,
    immediate = false,
    actionNote?: string,
    fromX?: number,
    fromY?: number,
  ) => {
    if (cursorMode === 'off') {
      triggerArrivalCallback(moveSequence);
      return;
    }

    // Smart user takeover guard: if user interacted very recently, yield peacefully
    const now = Date.now();
    if (userTakeoverDetected && now < userInteractingUntil) {
      if (pendingMoveSequence !== null && pendingMoveSequence !== moveSequence) {
        triggerArrivalCallback(pendingMoveSequence);
        pendingMoveSequence = null;
      }
      setTimeout(() => triggerArrivalCallback(moveSequence), 80);
      return;
    }

    userTakeoverDetected = false;
    if (pendingMoveSequence !== null && pendingMoveSequence !== moveSequence) {
      triggerArrivalCallback(pendingMoveSequence);
    }
    pendingMoveSequence = moveSequence;
    agentActiveUntil = Math.max(agentActiveUntil, now + 3500);
    cursorState.visibilitySpring.target = 1;
    cursorState.thinkStartedAt = null;

    if (autoIdleTimer) {
      clearTimeout(autoIdleTimer);
      autoIdleTimer = null;
    }

    if (actionNote) {
      showActionNote(actionNote);
    }

    const target: Point = {
      x: clamp(targetX, 0, window.innerWidth),
      y: clamp(targetY, 0, window.innerHeight),
    };

    if (!hasInteracted) {
      hasInteracted = true;
      // If previous coordinate was supplied by background, resume from exact position
      if (typeof fromX === 'number' && typeof fromY === 'number') {
        cursorState.point = {
          x: clamp(fromX, 0, window.innerWidth),
          y: clamp(fromY, 0, window.innerHeight),
        };
        resetSpring(cursorState.positionXSpring, cursorState.point.x);
        resetSpring(cursorState.positionYSpring, cursorState.point.y);
        cursorState.visibilitySpring.value = 1;
        cursorState.visibilitySpring.target = 1;
      } else {
        // Natural entrance trajectory without teleportation:
        // Start smoothly from off-axis entry point with 0 opacity and glide in
        const entryX = target.x > window.innerWidth / 2 ? target.x - 70 : target.x + 70;
        const entryY = Math.min(window.innerHeight - 24, target.y + 55);
        cursorState.point = {
          x: clamp(entryX, 0, window.innerWidth),
          y: clamp(entryY, 0, window.innerHeight),
        };
        resetSpring(cursorState.positionXSpring, cursorState.point.x);
        resetSpring(cursorState.positionYSpring, cursorState.point.y);
        cursorState.visibilitySpring.value = 0;
        cursorState.visibilitySpring.target = 1;
      }
    }

    const distance = dist(cursorState.point, target);

    // STRICTLY FORBID TELEPORTATION:
    // Only snap if distance < 1.5. Every movement between two points executes
    // a natural Bezier curve trajectory with control point bias.
    if (distance < 1.5) {
      cursorState.point = target;
      resetSpring(cursorState.positionXSpring, target.x);
      resetSpring(cursorState.positionYSpring, target.y);
      resetSpring(cursorState.stretchSpring, 1);
      cursorState.motion = null;
      renderCursor();
      pendingMoveSequence = null;
      triggerArrivalCallback(moveSequence);
      return;
    }

    const path = buildArcCandidates(cursorState.point, target, {
      width: window.innerWidth,
      height: window.innerHeight,
    });
    cursorState.motion = {
      mode: 'bezier',
      path,
      progressSpring: createSpring(
        0,
        1,
        immediate
          ? { dampingFraction: 0.95, response: 0.055 }
          : { dampingFraction: 0.88, response: 0.13 },
      ),
    };

    startAnimationLoop();
  };

  const hideCursor = () => {
    if (cursorMode === 'always') return; // in always mode, remain visible at last interaction point
    cursorState.visibilitySpring.target = 0;
    cursorState.thinkStartedAt = null;
    startAnimationLoop();
  };

  let lastUserMousePos: Point | null = null;
  let userMoveAccumulatedDist = 0;
  let userTakeoverTimer: number | null = null;
  let userInteractingUntil = 0;

  const onUserMouseMove = (e: MouseEvent) => {
    if (cursorMode === 'always' || !e.isTrusted) return;
    const isAgentActive = Date.now() < agentActiveUntil || cursorState.motion !== null;
    if (isAgentActive) {
      // If mouse event is within 60px of the agent's current or target point, it's CDP movement
      const dToCursor = dist(cursorState.point, { x: e.clientX, y: e.clientY });
      const targetPt = cursorState.motion
        ? cursorState.motion.mode === 'scoot'
          ? cursorState.motion.end
          : cursorState.motion.path.end
        : cursorState.point;
      const dToTarget = dist(targetPt, { x: e.clientX, y: e.clientY });
      if (dToCursor < 60 || dToTarget < 60) {
        lastUserMousePos = { x: e.clientX, y: e.clientY };
        return;
      }
      // If cursor is in motion along a trajectory, verify proximity to motion corridor
      if (cursorState.motion) {
        const dToSeg = distToSegment(cursorState.point, targetPt, { x: e.clientX, y: e.clientY });
        if (dToSeg < 60) {
          lastUserMousePos = { x: e.clientX, y: e.clientY };
          return;
        }
      }
    }
    if (!lastUserMousePos) {
      lastUserMousePos = { x: e.clientX, y: e.clientY };
      return;
    }
    const d = dist(lastUserMousePos, { x: e.clientX, y: e.clientY });
    lastUserMousePos = { x: e.clientX, y: e.clientY };
    userMoveAccumulatedDist += d;

    // Filter sensor jitter; require deliberate movement (>18px)
    if (userMoveAccumulatedDist > 18) {
      userTakeoverDetected = true;
      userInteractingUntil = Date.now() + 1500;
      hideCursor();
      hideActionNote();
    }

    if (userTakeoverTimer) clearTimeout(userTakeoverTimer);
    userTakeoverTimer = window.setTimeout(() => {
      userMoveAccumulatedDist = 0;
      lastUserMousePos = null;
      if (Date.now() >= userInteractingUntil) {
        userTakeoverDetected = false;
      }
    }, 1500);
  };

  const onUserInteractionDirect = (e: Event) => {
    if (cursorMode === 'always' || !e.isTrusted) return;
    const isAgentActive = Date.now() < agentActiveUntil;
    if (isAgentActive) {
      if (e.type === 'mousedown') {
        const me = e as MouseEvent;
        const d = dist(cursorState.point, { x: me.clientX, y: me.clientY });
        const targetPt = cursorState.motion
          ? cursorState.motion.mode === 'scoot'
            ? cursorState.motion.end
            : cursorState.motion.path.end
          : cursorState.point;
        if (dist(targetPt, { x: me.clientX, y: me.clientY }) < 50) return;
        if (d < 50) return; // CDP click at agent cursor location
      } else if (e.type === 'wheel') {
        const we = e as WheelEvent;
        const d = dist(cursorState.point, { x: we.clientX, y: we.clientY });
        if (d < 120) return; // CDP wheel scroll around target container
      } else if (e.type === 'keydown') {
        return; // Agent typing via CDP Input.dispatchKeyEvent
      }
    }
    userTakeoverDetected = true;
    userInteractingUntil = Date.now() + 1500;
    hideCursor();
    hideActionNote();
    if (userTakeoverTimer) clearTimeout(userTakeoverTimer);
    userTakeoverTimer = window.setTimeout(() => {
      if (Date.now() >= userInteractingUntil) {
        userTakeoverDetected = false;
      }
    }, 1500);
  };

  window.addEventListener('mousemove', onUserMouseMove, { passive: true });
  window.addEventListener('mousedown', onUserInteractionDirect, { passive: true });
  window.addEventListener('keydown', onUserInteractionDirect, { passive: true });
  window.addEventListener('wheel', onUserInteractionDirect, { passive: true });
  window.addEventListener(
    'scroll',
    () => {
      if (tooltipVisible) updateTooltipPosition(1);
    },
    { passive: true },
  );
  window.addEventListener(
    'resize',
    () => {
      if (tooltipVisible) updateTooltipPosition(1);
    },
    { passive: true },
  );

  let activeInterventionCleanup: (() => void) | null = null;

  // Message listener for Background commands
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;

    if (message.type === 'HUMAN_INTERVENTION_REQUEST') {
      if (activeInterventionCleanup) {
        try {
          activeInterventionCleanup();
        } catch {}
        activeInterventionCleanup = null;
      }
      const { reason } = message;
      // Move virtual cursor smoothly to standby corner
      moveTo(window.innerWidth - 60, 40, null, false);

      let banner = shadow.getElementById('codex-human-intervention-banner');
      if (banner) banner.remove();

      banner = document.createElement('div');
      banner.id = 'codex-human-intervention-banner';
      banner.style.cssText = [
        'position: fixed',
        'top: 24px',
        'left: 50%',
        'transform: translateX(-50%)',
        'z-index: 2147483647',
        'background: rgba(15, 23, 42, 0.92)',
        'backdrop-filter: blur(16px)',
        '-webkit-backdrop-filter: blur(16px)',
        'border: 1px solid rgba(51, 156, 255, 0.5)',
        'border-radius: 9999px',
        'box-shadow: 0 12px 40px rgba(0, 0, 0, 0.6), 0 0 24px rgba(51, 156, 255, 0.35)',
        'color: #ffffff',
        'padding: 10px 22px',
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        'font-size: 14px',
        'line-height: 20px',
        'display: flex',
        'align-items: center',
        'gap: 16px',
        'pointer-events: auto',
        'user-select: none',
        'animation: codexSlideIn 0.35s cubic-bezier(0.16, 1, 0.3, 1)',
      ].join('; ');

      const style = document.createElement('style');
      style.textContent = `
        @keyframes codexSlideIn {
          from { opacity: 0; transform: translate(-50%, -20px) scale(0.96); }
          to { opacity: 1; transform: translate(-50%, 0) scale(1); }
        }
        @keyframes codexPulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(51, 156, 255, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 8px rgba(51, 156, 255, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(51, 156, 255, 0); }
        }
      `;
      banner.appendChild(style);

      const pulseDot = document.createElement('div');
      pulseDot.style.cssText =
        'width: 10px; height: 10px; border-radius: 50%; background: #339cff; animation: codexPulse 1.8s infinite; flex-shrink: 0;';
      banner.appendChild(pulseDot);

      const textContainer = document.createElement('div');
      textContainer.style.cssText =
        'font-weight: 500; max-width: 480px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
      const labelSpan = document.createElement('span');
      labelSpan.style.cssText = 'color: #93c5fd; font-weight: 600;';
      labelSpan.textContent = 'Human Assistance Required: ';
      textContainer.appendChild(labelSpan);
      textContainer.appendChild(document.createTextNode(reason));
      banner.appendChild(textContainer);

      const continueBtn = document.createElement('button');
      continueBtn.id = 'codex-btn-continue';
      continueBtn.style.cssText = [
        'background: #339cff',
        'color: #ffffff',
        'border: none',
        'padding: 6px 14px',
        'border-radius: 9999px',
        'font-size: 12px',
        'font-weight: 600',
        'cursor: pointer',
        'transition: all 0.2s',
        'outline: none',
      ].join('; ');
      continueBtn.textContent = 'Complete & Resume (Enter)';
      banner.appendChild(continueBtn);

      shadow.appendChild(banner);

      const cleanup = () => {
        window.removeEventListener('keydown', onKey);
        if (activeInterventionCleanup === cleanup) {
          activeInterventionCleanup = null;
        }
        if (banner && banner.parentNode) {
          banner.style.transition = 'opacity 0.25s, transform 0.25s';
          banner.style.opacity = '0';
          banner.style.transform = 'translate(-50%, -15px) scale(0.95)';
          setTimeout(() => banner?.remove(), 260);
        }
      };
      activeInterventionCleanup = cleanup;

      const onDone = () => {
        cleanup();
        sendResponse({ ok: true, action: 'completed_by_user' });
      };

      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          const target = (e.composedPath?.()[0] || e.target) as HTMLElement | null;
          const tagName = target?.tagName?.toLowerCase();
          const isInput =
            tagName === 'input' ||
            tagName === 'textarea' ||
            tagName === 'select' ||
            Boolean(target?.isContentEditable);
          if (isInput) {
            return;
          }
          e.preventDefault();
          onDone();
        }
      };

      banner.querySelector('#codex-btn-continue')?.addEventListener('click', onDone);
      window.addEventListener('keydown', onKey);
      return true;
    }

    if (message.type === 'HUMAN_INTERVENTION_CANCEL') {
      if (activeInterventionCleanup) {
        try {
          activeInterventionCleanup();
        } catch {}
        activeInterventionCleanup = null;
      } else {
        const banner = shadow.getElementById('codex-human-intervention-banner');
        if (banner) banner.remove();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'AGENT_CURSOR_MOVE') {
      const { x, y, moveSequence, immediate, actionNote, fromX, fromY } = message;
      moveTo(
        x,
        y,
        typeof moveSequence === 'number' ? moveSequence : null,
        immediate === true,
        actionNote,
        fromX,
        fromY,
      );
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'AGENT_CURSOR_CLICK') {
      triggerClickAnimation(message.x, message.y, message.actionNote);
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'AGENT_CURSOR_SET_NOTE') {
      if (message.note) {
        showActionNote(message.note, message.durationMs ?? 2600);
      } else {
        hideActionNote();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'AGENT_CURSOR_HIDE') {
      if (message.force || cursorMode !== 'always') {
        hideCursor();
        hideActionNote();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'AGENT_CURSOR_STATE') {
      const cursor = message.state?.cursor;
      if (cursor && typeof cursor.x === 'number' && typeof cursor.y === 'number') {
        moveTo(cursor.x, cursor.y, cursor.moveSequence ?? null, cursor.animateMovement === false);
      } else if (message.state?.isVisible === false) {
        hideCursor();
      }
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  // Explicitly initialize cursor into hidden state on initial page load
  renderCursor();
}
