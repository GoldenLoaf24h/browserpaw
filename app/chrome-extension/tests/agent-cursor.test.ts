import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  animateAgentCursor,
  hideAgentCursor,
} from '../entrypoints/background/tools/browser/agent-cursor';
import fs from 'node:fs';
import path from 'node:path';

describe('Agent Cursor (Virtual Mouse) Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('verifies cursor asset cursor-chat.png exists and has valid PNG header', () => {
    const assetPath = path.resolve(__dirname, '../public/images/cursor-chat.png');
    expect(fs.existsSync(assetPath)).toBe(true);

    const buf = fs.readFileSync(assetPath);
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
    expect(buf.length).toBeGreaterThan(1000);
  });

  it('sends AGENT_CURSOR_MOVE with expected coordinates and sequence', async () => {
    let sentMessage: any = null;
    (globalThis as any).chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn().mockImplementation(async (_tabId, msg) => {
          sentMessage = msg;
          return { ok: true };
        }),
      },
    };

    // Animate with immediate: true to skip wait
    await animateAgentCursor(101, 350, 420, { immediate: true });

    expect(sentMessage).toBeTruthy();
    expect(sentMessage.type).toBe('AGENT_CURSOR_MOVE');
    expect(sentMessage.x).toBe(350);
    expect(sentMessage.y).toBe(420);
    expect(typeof sentMessage.moveSequence).toBe('number');
  });

  it('safely handles timeouts without throwing when waiting for arrival', async () => {
    (globalThis as any).chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const start = Date.now();
    // Wait with a short 50ms timeout
    await animateAgentCursor(102, 100, 200, { waitForArrival: true, timeoutMs: 50 });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('sends AGENT_CURSOR_HIDE on hideAgentCursor', async () => {
    let sentMessage: any = null;
    (globalThis as any).chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn().mockImplementation(async (_tabId, msg) => {
          sentMessage = msg;
          return { ok: true };
        }),
      },
    };

    await hideAgentCursor(103);
    expect(sentMessage).toBeTruthy();
    expect(sentMessage.type).toBe('AGENT_CURSOR_HIDE');
  });

  it('verifies content script initializes cursor with strict hidden state', () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const source = fs.readFileSync(contentScriptPath, 'utf-8');

    // Verify cursorContainer is styled hidden and opacity 0 on mount
    expect(source).toContain("cursorContainer.style.opacity = '0'");
    expect(source).toContain("cursorContainer.style.visibility = 'hidden'");
    // Verify renderCursor hides cursor when vis <= 0.001
    expect(source).toContain('if (vis <= 0.001)');
    // Verify initial call to renderCursor()
    expect(source).toContain('renderCursor();');
  });

  it('verifies human intervention ignores enter key in input elements and cleans up on cancel', () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const source = fs.readFileSync(contentScriptPath, 'utf-8');

    // Enter guard for inputs/textareas/contenteditable
    expect(source).toContain("tagName === 'input'");
    expect(source).toContain("tagName === 'textarea'");
    expect(source).toContain('Boolean(target?.isContentEditable)');

    // Active intervention cleanup tracking on cancel
    expect(source).toContain('activeInterventionCleanup');
    expect(source).toContain('window.removeEventListener');
  });

  it('verifies action note passing and last cursor position tracking in background', async () => {
    let sentMoveMessage: any = null;
    let sentClickMessage: any = null;
    let sentNoteMessage: any = null;
    (globalThis as any).chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn().mockImplementation(async (_tabId, msg) => {
          if (msg.type === 'AGENT_CURSOR_MOVE') sentMoveMessage = msg;
          if (msg.type === 'AGENT_CURSOR_CLICK') sentClickMessage = msg;
          if (msg.type === 'AGENT_CURSOR_SET_NOTE') sentNoteMessage = msg;
          return { ok: true };
        }),
      },
    };

    const { animateAgentCursorClick, getLastKnownCursorPosition, setAgentCursorNote } =
      await import('../entrypoints/background/tools/browser/agent-cursor');

    await animateAgentCursor(105, 520, 640, {
      immediate: true,
      actionNote: 'Clicking submit button',
    });

    expect(sentMoveMessage).toBeTruthy();
    expect(sentMoveMessage.type).toBe('AGENT_CURSOR_MOVE');
    expect(sentMoveMessage.x).toBe(520);
    expect(sentMoveMessage.y).toBe(640);
    expect(sentMoveMessage.actionNote).toBe('Clicking submit button');

    const lastPos = getLastKnownCursorPosition(105);
    expect(lastPos).toEqual({ x: 520, y: 640 });

    // Subsequent move forwards previous coordinates (fromX, fromY) to eliminate teleportation
    let sentSecondMove: any = null;
    (globalThis as any).chrome.tabs.sendMessage.mockImplementationOnce(
      async (_tabId: number, msg: any) => {
        sentSecondMove = msg;
        return { ok: true };
      },
    );
    await animateAgentCursor(105, 700, 800, { immediate: true });
    expect(sentSecondMove.fromX).toBe(520);
    expect(sentSecondMove.fromY).toBe(640);
    expect(sentSecondMove.x).toBe(700);
    expect(sentSecondMove.y).toBe(800);

    await animateAgentCursorClick(105, 520, 640, 'Clicking submit button');
    expect(sentClickMessage).toBeTruthy();
    expect(sentClickMessage.type).toBe('AGENT_CURSOR_CLICK');
    expect(sentClickMessage.actionNote).toBe('Clicking submit button');

    await setAgentCursorNote(105, 'Scrolling timeline', 3000);
    expect(sentNoteMessage).toBeTruthy();
    expect(sentNoteMessage.type).toBe('AGENT_CURSOR_SET_NOTE');
    expect(sentNoteMessage.note).toBe('Scrolling timeline');
    expect(sentNoteMessage.durationMs).toBe(3000);
  });

  it('verifies content script contains actionTooltip pill badge, typewriter effect and zero-teleportation mechanics', () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const source = fs.readFileSync(contentScriptPath, 'utf-8');

    // Tooltip badge element and styling (1:1 with reference video pCfdTz2KS1i7qtOM.mp4)
    expect(source).toContain('codex-agent-tooltip');
    expect(source).toContain("actionTooltip.style.borderRadius = '8px'");
    expect(source).toContain('codex-agent-caret');
    expect(source).toContain('showActionNote');
    expect(source).toContain('hideActionNote');
    expect(source).toContain('updateTooltipPosition');

    // Cross-navigation position persistence via background fromX/fromY (anti-bot stealth: no sessionStorage)
    expect(source).not.toContain('browserpaw_agent_cursor_last_pos');
    expect(source).not.toContain('sessionStorage.setItem');
    expect(source).toContain('fromX');
    expect(source).toContain('fromY');

    // Strictly prohibited mouse teleportation: natural entry gliding instead of instant snapping
    expect(source).toContain('hasInteracted = true');

    // Auto mode intelligence: attentive standby, idle auto-fade timer (3.5s) and user takeover filter with wheel
    expect(source).toContain('autoIdleTimer');
    expect(source).toContain('resetAutoIdleTimer');
    expect(source).toContain('userMoveAccumulatedDist > 18');
    expect(source).toContain("window.addEventListener('wheel'");
    expect(source).toContain('AGENT_CURSOR_SET_NOTE');
  });

  it('verifies smart-scroll incorporates cursor gliding, note support, and progressive multi-step wheel easing', () => {
    const smartScrollPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/smart-scroll.ts',
    );
    const source = fs.readFileSync(smartScrollPath, 'utf-8');

    // Animate cursor before scrolling
    expect(source).toContain('animateAgentCursor');
    expect(source).toContain('actionNote: scrollLabel');
    expect(source).toContain('Scrolling down timeline');

    // Progressive multi-step wheel easing with exact accumulated step tracking
    expect(source).toContain('Math.cos((Math.PI * i) / STEPS)');
    expect(source).toContain('accumulatedX += stepX');
    expect(source).toContain('accumulatedY += stepY');
  });

  it('verifies content script distinguishes CDP events from user takeover and avoids stalling when cursor is off', () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const source = fs.readFileSync(contentScriptPath, 'utf-8');

    // Agent active window tracking
    expect(source).toContain('let agentActiveUntil = 0;');
    expect(source).toContain('agentActiveUntil = Math.max(agentActiveUntil, Date.now() + 2500);');

    // CDP mouseMoved proximity filter (<= 60px)
    expect(source).toContain('dToCursor < 60 || dToTarget < 60');

    // CDP click & wheel proximity filter
    expect(source).toContain('d < 50) return; // CDP click at agent cursor location');
    expect(source).toContain('d < 120) return; // CDP wheel scroll around target container');

    // Keydown protection during agent execution
    expect(source).toContain("if (e.type === 'keydown')");

    // cursorMode === 'off' sends arrival callback to prevent stalling
    expect(source).toContain("if (cursorMode === 'off')");
    expect(source).toContain('triggerArrivalCallback(moveSequence);');

    // Superseded moveSequence acknowledges previous sequence immediately
    expect(source).toContain(
      'if (pendingMoveSequence !== null && pendingMoveSequence !== moveSequence)',
    );
  });

  it('verifies strict synchronization between click ripple and physical CDP mousePressed across tools', () => {
    // 1. interact-index.ts
    const interactPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/interact-index.ts',
    );
    const interactSrc = fs.readFileSync(interactPath, 'utf-8');
    expect(interactSrc).toContain('await animateAgentCursorClick(tabId, x, y, actNote);');
    expect(interactSrc).not.toMatch(/void animateAgentCursorClick\(/);
    // Drag launches concurrent virtual cursor glide and strictly awaits arrival before mouseReleased
    expect(interactSrc).toContain('animateAgentCursor(tabId, endPoint.x, endPoint.y,');
    expect(interactSrc).toContain('waitForArrival: true,');
    expect(interactSrc).toContain('await dragCursorArrivalPromise;');

    // 2. fill-core.ts
    const fillCorePath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/fill-core.ts',
    );
    const fillCoreSrc = fs.readFileSync(fillCorePath, 'utf-8');
    // Click ripple must NOT be fired before occlusion/trajectory
    expect(fillCoreSrc).not.toMatch(
      /await animateAgentCursor\([\s\S]*?\);\s*void animateAgentCursorClick\(/,
    );
    // Click ripple is awaited right before mouse click to focus
    expect(fillCoreSrc).toContain(
      'await animateAgentCursorClick(tabId, targetX, targetY, fillNote);',
    );

    // 3. batch-actions.ts
    const batchPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/batch-actions.ts',
    );
    const batchSrc = fs.readFileSync(batchPath, 'utf-8');
    expect(batchSrc).not.toMatch(/void animateAgentCursorClick\(/);
    expect(batchSrc).toContain(
      'await animateAgentCursorClick(tabId, targetX, targetY, batchActNote);',
    );

    // 4. form-pipeline.ts
    const formPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/form-pipeline.ts',
    );
    const formSrc = fs.readFileSync(formPath, 'utf-8');
    expect(formSrc).not.toMatch(/void animateAgentCursorClick\(/);
    expect(formSrc).toContain(
      'await animateAgentCursorClick(tabId, coords.x, coords.y, clickNote);',
    );

    // 5. computer.ts
    const computerPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/computer.ts',
    );
    const computerSrc = fs.readFileSync(computerPath, 'utf-8');
    expect(computerSrc).not.toMatch(/void animateAgentCursorClick\(/);
    expect(computerSrc).toContain(
      'await animateAgentCursorClick(tabId, coord.x, coord.y, clickNote);',
    );
    expect(computerSrc).toContain('animateAgentCursor(tabId, end.x, end.y,');
    expect(computerSrc).toContain('await cursorDragArrivalPromise;');
    expect(computerSrc).toContain('await setAgentCursorNote(tabId, typeNote);');
    expect(computerSrc).toContain('await setAgentCursorNote(tabId, keyNote);');
  });

  it('verifies background agent-cursor lifecycle cleanup on tab removal and reload', async () => {
    (globalThis as any).chrome = {
      runtime: {
        onMessage: { addListener: vi.fn() },
      },
      tabs: {
        sendMessage: vi.fn().mockResolvedValue({ ok: true }),
      },
    };

    const { animateAgentCursor, getLastKnownCursorPosition, cleanupTabCursorState } =
      await import('../entrypoints/background/tools/browser/agent-cursor');

    // Seed a position
    await animateAgentCursor(999, 150, 250, { immediate: true });
    expect(getLastKnownCursorPosition(999)).toEqual({ x: 150, y: 250 });

    // When tab 999 navigates/loads or is closed, cached position and pending arrivals are evicted
    cleanupTabCursorState(999);
    expect(getLastKnownCursorPosition(999)).toBeNull();

    // Verify background agent-cursor contains onRemoved and onUpdated listeners
    const agentCursorPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/agent-cursor.ts',
    );
    const source = fs.readFileSync(agentCursorPath, 'utf-8');
    expect(source).toContain('chrome.tabs.onRemoved?.addListener');
    expect(source).toContain('chrome.tabs.onUpdated?.addListener');
    expect(source).toContain('cleanupTabCursorState(closedTabId)');
    expect(source).toContain('cleanupTabCursorState(updatedTabId, true)');
  });

  it('verifies double-click and multi-click dispatches animateAgentCursorClick per click across all tools', () => {
    // 1. interact-index.ts
    const interactPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/interact-index.ts',
    );
    const interactSrc = fs.readFileSync(interactPath, 'utf-8');
    // Ensure second click in double_click has animateAgentCursorClick
    const dblMatch = interactSrc.match(/action === 'double_click'[\s\S]*?clickCount: 2/);
    expect(dblMatch).toBeTruthy();
    expect(dblMatch![0].match(/await animateAgentCursorClick\(/g)?.length).toBe(2);

    // 2. batch-actions.ts
    const batchPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/batch-actions.ts',
    );
    const batchSrc = fs.readFileSync(batchPath, 'utf-8').replace(/\r\n/g, '\n');
    const batchDblMatch = batchSrc.match(
      /else if \(item\.type === 'double_click'\)[\s\S]*?clickCount: 2/,
    );
    expect(batchDblMatch).toBeTruthy();
    expect(batchDblMatch![0].match(/await animateAgentCursorClick\(/g)?.length).toBe(2);
    // Double click second click must enforce 35ms physical hold
    expect(batchDblMatch![0]).toContain('setTimeout(r, 35)');

    // 3. interaction.ts ClickTool
    const interactionPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/interaction.ts',
    );
    const interactionSrc = fs.readFileSync(interactionPath, 'utf-8').replace(/\r\n/g, '\n');
    // Inside ClickTool click loop, animateAgentCursorClick is called before each mousePressed
    expect(interactionSrc).toContain(
      'for (let i = 1; i <= clickCount; i++) {\n              await animateAgentCursorClick(tabId, loc.x, loc.y, clickNote);',
    );

    // 4. computer.ts double_click / triple_click
    const computerPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/computer.ts',
    );
    const computerSrc = fs.readFileSync(computerPath, 'utf-8').replace(/\r\n/g, '\n');
    expect(computerSrc).toContain(
      'for (let i = 1; i <= clickCount; i++) {\n              await animateAgentCursorClick(tabId, coord.x, coord.y, clickNote);',
    );
  });

  it('verifies safe 350ms arrival timeout ceiling is enforced across tools without premature clipping', () => {
    const interactSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/background/tools/browser/interact-index.ts'),
      'utf-8',
    );
    expect(interactSrc).not.toContain('timeoutMs: 200');
    expect(interactSrc).not.toContain('timeoutMs: 250');

    const fillCoreSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/background/tools/browser/fill-core.ts'),
      'utf-8',
    );
    expect(fillCoreSrc).not.toContain('timeoutMs: 200');

    const computerSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/background/tools/browser/computer.ts'),
      'utf-8',
    );
    expect(computerSrc).not.toContain('timeoutMs: 250');

    const batchSrc = fs.readFileSync(
      path.resolve(__dirname, '../entrypoints/background/tools/browser/batch-actions.ts'),
      'utf-8',
    );
    expect(batchSrc).not.toContain('timeoutMs: 200');
    expect(batchSrc).not.toContain('timeoutMs: 250');
  });

  it('verifies content script supports dynamic multi-ripple clone and silences notes and ripples when cursor is off', () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const source = fs.readFileSync(contentScriptPath, 'utf-8').replace(/\r\n/g, '\n');

    // Multi-ripple clone for concurrent concentric ripples
    expect(source).toContain('clickRipple.cloneNode(true)');

    // cursorMode === 'off' guard in showActionNote and triggerClickAnimation
    expect(source).toContain("if (cursorMode === 'off') {\n      hideActionNote();\n      return;");
    expect(source).toContain(
      "const triggerClickAnimation = (clickX?: number, clickY?: number, note?: string) => {\n    if (cursorMode === 'off') return;",
    );

    // Trajectory corridor protection with distToSegment & caret timer cleanup
    expect(source).toContain('distToSegment');
    expect(source).toContain('caretRemoveTimer');
  });

  it('verifies 90% cursor scaling and cross-tab seamless physical Bezier trajectory', async () => {
    const contentScriptPath = path.resolve(__dirname, '../entrypoints/agent-cursor.content.ts');
    const contentSrc = fs.readFileSync(contentScriptPath, 'utf-8');
    expect(contentSrc).toContain('const CURSOR_BASE_SCALE = 0.9;');
    expect(contentSrc).toContain('CURSOR_BASE_SCALE');
    expect(contentSrc).toContain("mode: 'bezier'");
    expect(contentSrc).toContain('buildArcCandidates');

    const backgroundScriptPath = path.resolve(
      __dirname,
      '../entrypoints/background/tools/browser/agent-cursor.ts',
    );
    const bgSrc = fs.readFileSync(backgroundScriptPath, 'utf-8');
    expect(bgSrc).toContain('lastGlobalCursorPosition');
    expect(bgSrc).toContain('lastTabCursorPositions.get(tabId) || lastGlobalCursorPosition');
    expect(bgSrc).toContain('cleanupTabCursorState(updatedTabId, true)');
  });
});
