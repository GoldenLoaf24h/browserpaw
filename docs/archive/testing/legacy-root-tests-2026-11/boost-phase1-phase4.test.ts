import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import {
  parseUnifiedCoordinate,
  type PolymorphicCoordinate,
  type UnifiedCoordinateOptions,
  TOOL_NAMES,
  TOOL_SCHEMAS,
} from '../packages/shared/dist/index.mjs';
import { inPageRenderHighlights } from '../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts';

describe('Boost Phase 1 - Phase 4 Comprehensive Verification Suite', () => {
  describe('Phase 3: Polymorphic Coordinate Inference Engine (PCIE)', () => {
    const defaultOpts: UnifiedCoordinateOptions = {
      viewportWidth: 1000,
      viewportHeight: 800,
    };

    it('1. Parses absolute pixel coordinates { x, y }', () => {
      const parsed = parseUnifiedCoordinate({ x: 250, y: 350 }, defaultOpts);
      assert.deepStrictEqual(parsed, { x: 250, y: 350 });
    });

    it('2. Parses normalized 0~1.0 float coordinates { x, y } and scales by viewport', () => {
      const parsed = parseUnifiedCoordinate({ x: 0.5, y: 0.25 }, defaultOpts);
      assert.deepStrictEqual(parsed, { x: 500, y: 200 });
    });

    it('3. Parses 0~1000 per-mille integer coordinates with scale: 1000', () => {
      const parsed = parseUnifiedCoordinate({ x: 500, y: 250 }, { ...defaultOpts, scale: '1000' });
      assert.deepStrictEqual(parsed, { x: 500, y: 200 });
    });

    it('4. Parses Gemini/Qwen bounding box [ymin, xmin, ymax, xmax] normalized 0~1.0 to center', () => {
      // Bounding box from y: 0.2 to 0.4, x: 0.1 to 0.5.
      // Geometric center: y = 0.3, x = 0.3. Viewport 1000x800 -> x: 300, y: 240.
      const parsed = parseUnifiedCoordinate([0.2, 0.1, 0.4, 0.5], defaultOpts);
      assert.deepStrictEqual(parsed, { x: 300, y: 240 });
    });

    it('5. Parses per-mille bounding box [ymin, xmin, ymax, xmax] 0~1000 to center', () => {
      // Box from y: 200 to 400, x: 100 to 500.
      // Geometric center: y = 300, x = 300. Viewport 1000x800 -> x: 300, y: 240.
      const parsed = parseUnifiedCoordinate([200, 100, 400, 500], { ...defaultOpts, scale: '1000' });
      assert.deepStrictEqual(parsed, { x: 300, y: 240 });
    });

    it('6. Parses explicit box_2d object { box_2d: [ymin, xmin, ymax, xmax] }', () => {
      const parsed = parseUnifiedCoordinate({ box_2d: [0.1, 0.2, 0.3, 0.4] }, defaultOpts);
      // y center = 0.2 * 800 = 160, x center = 0.3 * 1000 = 300
      assert.deepStrictEqual(parsed, { x: 300, y: 160 });
    });

    it('7. Parses named bounding box { xmin, ymin, xmax, ymax }', () => {
      const parsed = parseUnifiedCoordinate(
        { xmin: 100, ymin: 200, xmax: 300, ymax: 400 },
        { ...defaultOpts, scale: 'pixel' },
      );
      assert.deepStrictEqual(parsed, { x: 200, y: 300 });
    });

    it('8. Distinguishes Gemini point [y, x] vs OpenAI point [x, y]', () => {
      const geminiPixel = parseUnifiedCoordinate([300, 500], {
        ...defaultOpts,
        pointFormat: 'gemini',
        scale: 'pixel',
      });
      assert.deepStrictEqual(geminiPixel, { x: 500, y: 300 });

      const openai = parseUnifiedCoordinate([500, 300], {
        ...defaultOpts,
        pointFormat: 'openai',
        scale: 'pixel',
      });
      assert.deepStrictEqual(openai, { x: 500, y: 300 });

      // Default without scale: 'pixel' automatically scales Gemini per-mille coordinates to viewport (1000x800)
      const geminiAuto = parseUnifiedCoordinate([300, 500], {
        ...defaultOpts,
        pointFormat: 'gemini',
      });
      assert.deepStrictEqual(geminiAuto, { x: 500, y: 240 });
    });

    it('9. Automatically applies ROI origin offsets (originX, originY) for local crops', () => {
      // Zoomed into region starting at (150, 200), user clicks relative point (50, 60)
      const parsed = parseUnifiedCoordinate(
        { x: 50, y: 60 },
        { ...defaultOpts, originX: 150, originY: 200 },
      );
      assert.deepStrictEqual(parsed, { x: 200, y: 260 });
    });

    it('10. Handles screenshot to viewport scaling when screenshot dimensions differ', () => {
      // Screenshot captured at 2000x1600 (e.g. 2x DPR), viewport is 1000x800
      const parsed = parseUnifiedCoordinate(
        { x: 1000, y: 800 },
        { ...defaultOpts, screenshotWidth: 2000, screenshotHeight: 1600, scale: 'pixel' },
      );
      assert.deepStrictEqual(parsed, { x: 500, y: 400 });
    });

    it('11. Parses stringified JSON coordinates safely', () => {
      const parsedObj = parseUnifiedCoordinate('{"x": 120, "y": 240}', defaultOpts);
      assert.deepStrictEqual(parsedObj, { x: 120, y: 240 });

      const parsedArr = parseUnifiedCoordinate('[0.5, 0.5]', defaultOpts);
      assert.deepStrictEqual(parsedArr, { x: 500, y: 400 });
    });

    it('12. Safely returns null on invalid or empty coordinate formats', () => {
      assert.strictEqual(parseUnifiedCoordinate(null), null);
      assert.strictEqual(parseUnifiedCoordinate(undefined), null);
      assert.strictEqual(parseUnifiedCoordinate(''), null);
      assert.strictEqual(parseUnifiedCoordinate('not a coordinate'), null);
      assert.strictEqual(parseUnifiedCoordinate({}), null);
    });

    it('13. Parses Gemini box_2d object with per-mille 0~1000 coordinates scaling to viewport (1920x1080)', () => {
      const parsed = parseUnifiedCoordinate(
        { box_2d: [200, 100, 400, 500] },
        { viewportWidth: 1920, viewportHeight: 1080 },
      );
      // y center = 300 / 1000 * 1080 = 324, x center = 300 / 1000 * 1920 = 576
      assert.deepStrictEqual(parsed, { x: 576, y: 324 });
    });

    it('14. Parses Gemini point object with per-mille 0~1000 coordinates scaling to viewport (1920x1080)', () => {
      const parsed = parseUnifiedCoordinate(
        { point: [300, 500] },
        { viewportWidth: 1920, viewportHeight: 1080 },
      );
      // [y, x] -> y: 300 / 1000 * 1080 = 324, x: 500 / 1000 * 1920 = 960
      assert.deepStrictEqual(parsed, { x: 960, y: 324 });
    });

    it('15. Parses object with string numbers {"x": "250", "y": "350"}', () => {
      const parsed = parseUnifiedCoordinate({ x: '250', y: '350' }, defaultOpts);
      assert.deepStrictEqual(parsed, { x: 250, y: 350 });
    });

    it('16. Distinguishes OpenAI bounding box [xmin, ymin, xmax, ymax] vs Gemini [ymin, xmin, ymax, xmax] via pointFormat', () => {
      const openai = parseUnifiedCoordinate([100, 200, 300, 400], {
        ...defaultOpts,
        pointFormat: 'openai',
        scale: 'pixel',
      });
      // x: (100+300)/2 = 200, y: (200+400)/2 = 300
      assert.deepStrictEqual(openai, { x: 200, y: 300 });

      const gemini = parseUnifiedCoordinate([100, 200, 300, 400], {
        ...defaultOpts,
        pointFormat: 'gemini',
        scale: 'pixel',
      });
      // y: (100+300)/2 = 200, x: (200+400)/2 = 300
      assert.deepStrictEqual(gemini, { x: 300, y: 200 });
    });
  });

  describe('Phase 1 & Phase 2: Computer & Screenshot Architecture Hardening', () => {
    it('1. Verifies computer.ts eradicated double-scaling on DOM ref resolution', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/computer.ts',
        'utf-8',
      );
      // Double scaling was: project({ x: resolved.center.x, y: resolved.center.y })
      assert.strictEqual(
        src.includes('project({ x: resolved.center.x'),
        false,
        'DOM resolved.center must not be wrapped in project()',
      );
      assert.strictEqual(
        src.includes('project({ x: ensured.center.x'),
        false,
        'DOM ensured.center must not be wrapped in project()',
      );
      assert.strictEqual(
        src.includes('project({ x: reResolved.center.x'),
        false,
        'DOM reResolved.center must not be wrapped in project()',
      );
    });

    it('2. Verifies zoom action returns { type: "image" } and updates screenshotContextManager', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/computer.ts',
        'utf-8',
      );
      assert.ok(src.includes("action: 'zoom'"), 'zoom action must exist');
      assert.ok(
        src.includes('screenshotContextManager.setContext(tabId,'),
        'zoom must register ROI context with screenshotContextManager',
      );
      assert.ok(
        src.includes("type: 'image'"),
        'zoom must return multimodal { type: "image" } content block',
      );
      assert.ok(
        src.includes('screenshotRingBuffer.push('),
        'zoom must push captured crop to screenshotRingBuffer',
      );
    });

    it('3. Verifies screenshot.ts enforces DPR 1:1 and anti-blinding 450KB budget', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/screenshot.ts',
        'utf-8',
      );
      assert.ok(
        src.includes('normalizeImageToCssDimensions'),
        'Must normalize images to exact CSS viewport dimensions (DPR 1:1)',
      );
      assert.ok(
        src.includes('450 * 1024'),
        'Must enforce 450KB safety budget for Native Messaging pipe',
      );
      assert.ok(
        src.includes('compressImage'),
        'Must generate preview thumbnail when saving large image to disk',
      );
      // Must maintain backward-compatible regexes
      assert.ok(src.includes('storeBase64 = false'));
      assert.ok(src.includes('storeBase64 === true ? { base64Data } : {}'));
    });

    it('4. Verifies computer.ts directly dispatches native CDP mouse events for coordinate clicks', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/computer.ts',
        'utf-8',
      );
      assert.ok(
        src.includes('CDPHelper.dispatchMouseEvent(tabId,') && src.includes('project(params.coordinates)'),
        'computer.ts must project coordinates and dispatch native CDP mouse events',
      );
    });

    it('5. Verifies computer.ts zoom parses bounding boxes without coordinate inversion and avoids duplicate base64 in text block', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/computer.ts',
        'utf-8',
      );
      assert.strictEqual(
        src.includes('project([region[0], region[1]])'),
        false,
        'zoom must not pass [ymin, xmin] directly to project() as it causes X/Y coordinate inversion',
      );
      assert.ok(
        src.includes('rawYmin = isYminFirst ? Math.min(a, c) : Math.min(b, d)'),
        'zoom must correctly map ymin and xmin based on orientation',
      );
    });
  });

  describe('Phase 4: Set-of-Mark 2.0 (SoM 2.0) Upgrade', () => {
    it('1. Frustum Culling skips elements outside visible viewport', () => {
      const mockDocument: any = {
        createElement: () => ({
          style: {},
          setAttribute: () => {},
          appendChild: () => {},
        }),
        body: { appendChild: () => {} },
        documentElement: { clientWidth: 1000, clientHeight: 800 },
        getElementById: () => null,
      };
      const originalDoc = (globalThis as any).document;
      const originalWin = (globalThis as any).window;

      (globalThis as any).document = mockDocument;
      (globalThis as any).window = { innerWidth: 1000, innerHeight: 800 };

      const elements = [
        // Inside viewport
        { index: 1, rect: { x: 100, y: 100, width: 50, height: 20 }, tagName: 'BUTTON' },
        // Strictly outside viewport (far right)
        { index: 2, rect: { x: 1500, y: 100, width: 50, height: 20 }, tagName: 'BUTTON' },
        // Strictly outside viewport (far bottom)
        { index: 3, rect: { x: 100, y: 1200, width: 50, height: 20 }, tagName: 'BUTTON' },
      ];

      const appendedBadges: any[] = [];
      mockDocument.createElement = (tag: string) => {
        const node: any = { style: {}, setAttribute: () => {}, appendChild: () => {} };
        if (tag === 'div') {
          node.appendChild = (child: any) => {
            if (child.textContent) appendedBadges.push(child.textContent);
          };
        }
        return node;
      };

      try {
        inPageRenderHighlights(elements as any);
        // Only element 1 is inside the viewport! Elements 2 and 3 must be culled.
        assert.deepStrictEqual(appendedBadges, ['1']);
      } finally {
        (globalThis as any).document = originalDoc;
        (globalThis as any).window = originalWin;
      }
    });

    it('2. Anti-Collision shifts adjacent badges (< 25px)', () => {
      const mockDocument: any = {
        createElement: () => ({
          style: {},
          setAttribute: () => {},
          appendChild: () => {},
        }),
        body: { appendChild: () => {} },
        documentElement: { clientWidth: 1000, clientHeight: 800 },
        getElementById: () => null,
      };
      const originalDoc = (globalThis as any).document;
      const originalWin = (globalThis as any).window;

      (globalThis as any).document = mockDocument;
      (globalThis as any).window = { innerWidth: 1000, innerHeight: 800 };

      const elements = [
        // Two buttons right next to each other at the exact same location
        { index: 1, rect: { x: 100, y: 100, width: 40, height: 20 }, tagName: 'BUTTON' },
        { index: 2, rect: { x: 105, y: 102, width: 40, height: 20 }, tagName: 'BUTTON' },
      ];

      const badgeStyles: any[] = [];
      mockDocument.createElement = (tag: string) => {
        const node: any = { style: {}, setAttribute: () => {}, appendChild: () => {} };
        if (tag === 'div') {
          node.appendChild = (child: any) => {
            if (child.textContent) {
              badgeStyles.push({ index: child.textContent, css: child.style.cssText });
            }
          };
        }
        return node;
      };

      try {
        inPageRenderHighlights(elements as any);
        assert.strictEqual(badgeStyles.length, 2);
        // Badges must have different top positions due to anti-collision offset!
        assert.notStrictEqual(badgeStyles[0].css, badgeStyles[1].css);
      } finally {
        (globalThis as any).document = originalDoc;
        (globalThis as any).window = originalWin;
      }
    });

    it('3. Verifies Micro-Pill semi-transparent style in dom-indexer source', () => {
      const src = fs.readFileSync(
        'app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts',
        'utf-8',
      );
      assert.ok(src.includes('rgba(250, 204, 21, 0.9)'), 'Must use Micro-Pill semi-transparent yellow');
      assert.ok(src.includes('border-radius: 9999px'), 'Must use pill border-radius');
      assert.ok(src.includes('font-size: 9px'), 'Must use 9px font size');
      assert.ok(src.includes('line-height: 11px'), 'Must use 11px line height');
    });
  });

  describe('Phase 4: Legacy Asset Cleanup & Namespace Purification', () => {
    it('1. Confirms app/native-server/dist/agent directory is physically deleted', () => {
      assert.strictEqual(
        fs.existsSync('app/native-server/dist/agent'),
        false,
        'app/native-server/dist/agent must be deleted',
      );
    });

    it('2. Confirms prompt/modify-web.md removed raw HTML dump and anti-screenshot rules', () => {
      const content = fs.readFileSync('prompt/modify-web.md', 'utf-8');
      assert.strictEqual(content.includes('禁止使用截图工具'), false);
      assert.strictEqual(content.includes('htmlContent: true'), false);
      assert.ok(content.includes('chrome_read_dom'));
      assert.ok(content.includes('chrome_screenshot'));
    });

    it('3. Confirms prompt/excalidraw-prompt.md fixed syntax bug and removed anti-screenshot rule', () => {
      const content = fs.readFileSync('prompt/excalidraw-prompt.md', 'utf-8');
      assert.strictEqual(content.includes('禁止使用截图工具'), false);
      assert.strictEqual(content.includes('resIds.push[idx]'), false);
      assert.ok(content.includes('resIds.push(existingElements[idx].id)'));
    });

    it('4. Confirms inject-scripts use window.__mcpElementMap as primary storage with backward alias', () => {
      const treeSrc = fs.readFileSync('app/chrome-extension/inject-scripts/accessibility-tree-helper.js', 'utf-8');
      assert.ok(treeSrc.includes('window.__mcpElementMap = window.__claudeElementMap || {}'));
      assert.ok(treeSrc.includes('window.__claudeElementMap = window.__mcpElementMap'));

      const waitSrc = fs.readFileSync('app/chrome-extension/inject-scripts/wait-helper.js', 'utf-8');
      assert.ok(waitSrc.includes('window.__mcpElementMap = window.__claudeElementMap || {}'));
      assert.ok(waitSrc.includes('window.__claudeElementMap = window.__mcpElementMap'));

      const interactionSrc = fs.readFileSync('app/chrome-extension/entrypoints/background/tools/browser/interaction.ts', 'utf-8');
      assert.ok(interactionSrc.includes('interactIndexTool'));
      assert.ok(interactionSrc.includes('performPhysicalFill'));

      const fillCoreSrc = fs.readFileSync('app/chrome-extension/entrypoints/background/tools/browser/fill-core.ts', 'utf-8');
      assert.ok(fillCoreSrc.includes('performPhysicalFill'));
    });
  });

  describe('Tool Schemas: Polymorphic Coordinate Support & chrome_read_dom Alignment', () => {
    it('1. Verifies schemas support object and array for coordinates across canonical tools', () => {
      const computerTool = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_computer');
      assert.ok(computerTool);
      assert.ok(computerTool.inputSchema.properties.coordinates.oneOf);

      const interactTool = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_interact_index');
      assert.ok(interactTool);
      assert.ok(interactTool.inputSchema.properties.coordinate.oneOf);

      const smartScrollTool = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_smart_scroll');
      assert.ok(smartScrollTool);
      assert.ok(smartScrollTool.inputSchema.properties.coordinate.oneOf);

      const batchTool = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_batch_actions');
      assert.ok(batchTool);
      assert.ok(batchTool.inputSchema.properties.actions.items.properties.coordinate.oneOf);
    });
  });
});
