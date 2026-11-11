import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_NAMES, TOOL_SCHEMAS, parseUnifiedCoordinate } from '../packages/shared/dist/index.mjs';
import {
  smartCompressForTransport,
  normalizeImageToCssDimensions,
  overlayCoordinateGrid,
} from '../app/chrome-extension/utils/image-utils.ts';
import { inPageSnapCoordinate } from '../app/chrome-extension/entrypoints/background/tools/browser/dom-indexer.ts';
import { scaleCoordinates } from '../app/chrome-extension/utils/screenshot-context.ts';

describe('Visual Drift & Coordinate Precision Verification Suite', () => {
  describe('1. Smart Transport Compression (Zero Downscale Blur for Standard Viewports)', () => {
    it('preserves 1:1 CSS dimensions at scale 1.0 when payload fits transport budget', async () => {
      // Mock OffscreenCanvas, FileReader, createImageBitmap
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).createImageBitmap = async () => ({
        width: 1692,
        height: 898,
        close() {},
      });

      let requestedQuality = 0.82;

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage() {},
          };
        }
        async convertToBlob(options: { type: string; quality?: number }) {
          requestedQuality = options.quality ?? 0.8;
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          // Generate simulated base64 of ~300KB (well within 450KB budget)
          this.result = `data:image/webp;base64,${'A'.repeat(300 * 1024)}`;
          this.onloadend?.();
        }
      };

      try {
        // Feed in a large uncompressed base64 data URL (e.g. 800KB raw PNG)
        const fakeDataUrl = `data:image/png;base64,${'X'.repeat(800 * 1024)}`;
        const result = await smartCompressForTransport(fakeDataUrl, {
          maxBytes: 450 * 1024,
          preferredFormat: 'image/webp',
          quality: 0.82,
        });

        assert.strictEqual(result.width, 1692, 'Width must remain exactly 1692 CSS px (no downscale)');
        assert.strictEqual(result.height, 898, 'Height must remain exactly 898 CSS px (no downscale)');
        assert.strictEqual(result.scaleRatio, 1.0, 'Scale ratio must be exactly 1.0');
        assert.strictEqual(result.wasDownscaled, false, 'wasDownscaled must be false');
        assert.strictEqual(result.mimeType, 'image/webp');
      } finally {
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });

    it('falls back to proportional dimension scaling only for massive pages that cannot fit at lowest quality', async () => {
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).createImageBitmap = async () => ({
        width: 1920,
        height: 6000,
        close() {},
      });

      let canvasW = 0;
      let canvasH = 0;

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
          canvasW = w;
          canvasH = h;
        }
        getContext() {
          return { drawImage() {} };
        }
        async convertToBlob() {
          return {};
        }
      };

      let callCount = 0;
      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          callCount++;
          // For the first 4 quality attempts at scale 1.0, simulate huge payload (600KB > 450KB)
          // For the 5th attempt (scaled down), simulate 350KB payload
          if (callCount <= 4) {
            this.result = `data:image/webp;base64,${'B'.repeat(600 * 1024)}`;
          } else {
            this.result = `data:image/webp;base64,${'C'.repeat(350 * 1024)}`;
          }
          this.onloadend?.();
        }
      };

      try {
        const fakeDataUrl = `data:image/png;base64,${'Y'.repeat(1200 * 1024)}`;
        const result = await smartCompressForTransport(fakeDataUrl, {
          maxBytes: 450 * 1024,
          preferredFormat: 'image/webp',
          allowDimensionScaling: true,
        });

        assert.strictEqual(result.wasDownscaled, true, 'Massive fullPage image must trigger downscaling');
        assert.ok(result.scaleRatio < 1.0, 'scaleRatio must be < 1.0');
        assert.strictEqual(result.width, canvasW);
        assert.strictEqual(result.height, canvasH);
      } finally {
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });
  });

  describe('2. Magnetic Coordinate Auto-Snapping (inPageSnapCoordinate)', () => {
    it('returns snapped: false when click lands directly on an interactive button', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      const mockButton = {
        tagName: 'BUTTON',
        getAttribute: () => null,
        hasAttribute: () => false,
        getBoundingClientRect: () => ({ left: 100, top: 100, right: 200, bottom: 140, width: 100, height: 40 }),
        parentElement: null,
      };

      (globalThis as any).window = {
        innerWidth: 1280,
        innerHeight: 800,
        getComputedStyle: () => ({ cursor: 'pointer' }),
      };

      (globalThis as any).document = {
        documentElement: { clientWidth: 1280, clientHeight: 800 },
        body: {},
        elementFromPoint: (x: number, y: number) => {
          if (x >= 100 && x <= 200 && y >= 100 && y <= 140) return mockButton;
          return null;
        },
      };

      try {
        // Direct click inside the button at (150, 120)
        const snap = inPageSnapCoordinate(150, 120, 24);
        assert.strictEqual(snap.snapped, false, 'Direct interactive click must not snap');
        assert.strictEqual(snap.x, 150);
        assert.strictEqual(snap.y, 120);
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });

    it('magnetically snaps to closest button center when clicking whitespace 15px outside target (dice scenario)', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      // Dice/Button located at [1150..1185, 400..435]
      // Model clicked x=1200, y=415 (15px to the right on blank space due to ruler line confusion)
      const mockDice = {
        tagName: 'BUTTON',
        getAttribute: (attr: string) => (attr === 'role' ? 'button' : null),
        hasAttribute: () => false,
        getBoundingClientRect: () => ({
          left: 1150,
          top: 400,
          right: 1185,
          bottom: 435,
          width: 35,
          height: 35,
        }),
        parentElement: null,
      };

      const mockBody = {
        tagName: 'BODY',
        getAttribute: () => null,
        hasAttribute: () => false,
        parentElement: null,
      };

      (globalThis as any).window = {
        innerWidth: 1692,
        innerHeight: 898,
        getComputedStyle: () => ({ cursor: 'default' }),
      };

      (globalThis as any).document = {
        documentElement: { clientWidth: 1692, clientHeight: 898 },
        body: mockBody,
        elementFromPoint: (x: number, y: number) => {
          // Hits whitespace at (1200, 415)
          if (x >= 1150 && x <= 1185 && y >= 400 && y <= 435) return mockDice;
          return mockBody;
        },
      };

      try {
        const snap = inPageSnapCoordinate(1200, 415, 24);
        assert.strictEqual(snap.snapped, true, 'Must magnetically snap when 15px off target');
        assert.strictEqual(snap.originalX, 1200);
        assert.strictEqual(snap.originalY, 415);
        assert.strictEqual(snap.x, Math.round((1150 + 1185) / 2), 'Snapped X must be button center');
        assert.strictEqual(snap.y, Math.round((400 + 435) / 2), 'Snapped Y must be button center');
        assert.strictEqual(snap.targetTag, 'button');
        assert.ok(snap.distance! <= 24, 'Distance must be within snapRadius');
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });

    it('does not snap when clicked whitespace is farther than snapRadius (> 24px)', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      const mockBody = {
        tagName: 'BODY',
        getAttribute: () => null,
        hasAttribute: () => false,
        parentElement: null,
      };

      (globalThis as any).window = {
        innerWidth: 1280,
        innerHeight: 800,
        getComputedStyle: () => ({ cursor: 'default' }),
      };

      (globalThis as any).document = {
        documentElement: { clientWidth: 1280, clientHeight: 800 },
        body: mockBody,
        elementFromPoint: () => mockBody,
      };

      try {
        // Far away blank area click
        const snap = inPageSnapCoordinate(500, 500, 24);
        assert.strictEqual(snap.snapped, false);
        assert.strictEqual(snap.x, 500);
        assert.strictEqual(snap.y, 500);
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });
  });

  describe('3. DPR 1:1 High-DPI Image Normalization (normalizeImageToCssDimensions)', () => {
    it('resamples physical device pixels (e.g. 2.0x DPR) to exact CSS viewport dimensions', async () => {
      const originalFetch = globalThis.fetch;
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).fetch = async () => ({
        blob: async () => ({}),
      });

      let drawArgs: any[] = [];
      let canvasW = 0;
      let canvasH = 0;

      // CDP capture at 2.0x DPR: 1600x1200 for an 800x600 CSS viewport
      (globalThis as any).createImageBitmap = async () => ({
        width: 1600,
        height: 1200,
        close() {},
      });

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
          canvasW = w;
          canvasH = h;
        }
        getContext() {
          return {
            drawImage: (...args: any[]) => {
              drawArgs = args;
            },
          };
        }
        async convertToBlob(options: { type: string; quality?: number }) {
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          this.result = 'data:image/png;base64,normalized_css_data';
          this.onloadend?.();
        }
      };

      try {
        const out = await normalizeImageToCssDimensions(
          'data:image/png;base64,physical_pixels',
          800,
          600,
          'image/png',
          1.0,
        );

        assert.strictEqual(canvasW, 800, 'Canvas width must be 800 CSS px');
        assert.strictEqual(canvasH, 600, 'Canvas height must be 600 CSS px');
        assert.strictEqual(drawArgs[1], 0);
        assert.strictEqual(drawArgs[2], 0);
        assert.strictEqual(drawArgs[3], 800);
        assert.strictEqual(drawArgs[4], 600);
        assert.strictEqual(out, 'data:image/png;base64,normalized_css_data');
      } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });

    it('returns original dataUrl untouched if dimensions already match target CSS dimensions', async () => {
      const originalFetch = globalThis.fetch;
      const originalBitmap = (globalThis as any).createImageBitmap;

      (globalThis as any).fetch = async () => ({
        blob: async () => ({}),
      });

      (globalThis as any).createImageBitmap = async () => ({
        width: 800,
        height: 600,
        close() {},
      });

      try {
        const inputDataUrl = 'data:image/webp;base64,already_css_dimensions';
        const out = await normalizeImageToCssDimensions(
          inputDataUrl,
          800,
          600,
          'image/webp',
          0.8,
        );
        assert.strictEqual(out, inputDataUrl, 'Should return dataUrl directly with zero extra processing');
      } finally {
        globalThis.fetch = originalFetch;
        (globalThis as any).createImageBitmap = originalBitmap;
      }
    });
  });

  describe('4. Perimeter Tape Measure Ruler & Enhanced Grid Overlay (overlayCoordinateGrid)', () => {
    it('draws perimeter rulers with ticks and intersection pills without throwing on standard canvas mocks', async () => {
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).createImageBitmap = async () => ({
        width: 1200,
        height: 800,
        close() {},
      });

      let fillRectCalls: any[] = [];
      let fillTextCalls: string[] = [];

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            fillRect: (...args: any[]) => fillRectCalls.push(args),
            fillText: (txt: string) => fillTextCalls.push(txt),
            measureText: (txt: string) => ({ width: txt.length * 6 }),
            setLineDash() {},
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            font: '',
          };
        }
        async convertToBlob() {
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          this.result = 'data:image/png;base64,grid_data';
          this.onloadend?.();
        }
      };

      try {
        const result = await overlayCoordinateGrid(
          'data:image/png;base64,sample',
          1,
          100,
          'image/png',
          0.8,
          { style: 'ruler', originX: 0, originY: 0 },
        );

        assert.ok(result.startsWith('data:image/png;base64,'));
        assert.ok(fillRectCalls.length > 10, 'Must draw perimeter ruler bars and ticks');
        assert.ok(fillTextCalls.includes('0,0'), 'Must draw origin 0,0 label');
        assert.ok(fillTextCalls.some((t) => t.includes('100')), 'Must label 100px increments on rulers');
      } finally {
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });
  });

  describe('5. Tool Schemas Alignment for Pure Visual & Coordinate Operations', () => {
    it('verifies chrome_computer schema contains autoSnap boolean parameter', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.COMPUTER);
      assert.ok(tool);
      assert.ok(tool.inputSchema.properties.autoSnap, 'autoSnap must exist in chrome_computer');
      assert.strictEqual(tool.inputSchema.properties.autoSnap.type, 'boolean');
    });

    it('verifies chrome_interact_index schema contains autoSnap boolean parameter', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.INTERACT_INDEX);
      assert.ok(tool);
      assert.ok(tool.inputSchema.properties.autoSnap, 'autoSnap must exist in chrome_interact_index');
      assert.strictEqual(tool.inputSchema.properties.autoSnap.type, 'boolean');
    });

    it('verifies chrome_screenshot schema contains region, crop, and highClarity properties', () => {
      const tool = TOOL_SCHEMAS.find((t: any) => t.name === TOOL_NAMES.BROWSER.SCREENSHOT);
      assert.ok(tool);
      assert.ok(tool.inputSchema.properties.region, 'region must exist in chrome_screenshot');
      assert.strictEqual(tool.inputSchema.properties.region.type, 'object');
      assert.ok(tool.inputSchema.properties.crop, 'crop must exist in chrome_screenshot');
      assert.ok(
        tool.inputSchema.properties.grid.oneOf || tool.inputSchema.properties.grid.type === 'boolean',
        'grid must support boolean or string style',
      );
      assert.ok(tool.inputSchema.properties.highClarity, 'highClarity must exist in chrome_screenshot');
      assert.strictEqual(tool.inputSchema.properties.highClarity.type, 'boolean');
    });
  });

  describe('6. Sub-Region ROI Crop & Zoom Coordinate Drift Immunity', () => {
    it('scaleCoordinates maps crop center (75, 40) accurately to viewport (1175, 420)', () => {
      const ctx = {
        screenshotWidth: 150,
        screenshotHeight: 80,
        viewportWidth: 1920,
        viewportHeight: 1080,
        originX: 1100,
        originY: 380,
        timestamp: Date.now(),
      };
      const result = scaleCoordinates(75, 40, ctx);
      assert.strictEqual(result.x, 1175, 'X must map to 1100 + 75 = 1175, NOT explode by 1920/150');
      assert.strictEqual(result.y, 420, 'Y must map to 380 + 40 = 420, NOT explode by 1080/80');
    });

    it('parseUnifiedCoordinate maps crop-relative pixels { x: 75, y: 40 } to { x: 1175, y: 420 }', () => {
      const result = parseUnifiedCoordinate(
        { x: 75, y: 40 },
        {
          viewportWidth: 1920,
          viewportHeight: 1080,
          screenshotWidth: 150,
          screenshotHeight: 80,
          originX: 1100,
          originY: 380,
        },
      );
      assert.ok(result);
      assert.strictEqual(result.x, 1175);
      assert.strictEqual(result.y, 420);
    });

    it('parseUnifiedCoordinate maps normalized 0-1000 per-mille [500, 500] on crop to { x: 1175, y: 420 }', () => {
      const result = parseUnifiedCoordinate([500, 500], {
        viewportWidth: 1920,
        viewportHeight: 1080,
        screenshotWidth: 150,
        screenshotHeight: 80,
        originX: 1100,
        originY: 380,
        scale: '1000',
      });
      assert.ok(result);
      assert.strictEqual(result.x, 1175, 'Normalized 500/1000 must scale to crop width 150 -> 75 + 1100 = 1175');
      assert.strictEqual(result.y, 420, 'Normalized 500/1000 must scale to crop height 80 -> 40 + 380 = 420');
    });

    it('parseUnifiedCoordinate maps Gemini bounding box [250, 250, 750, 750] on crop to { x: 1175, y: 420 }', () => {
      const result = parseUnifiedCoordinate([250, 250, 750, 750], {
        viewportWidth: 1920,
        viewportHeight: 1080,
        screenshotWidth: 150,
        screenshotHeight: 80,
        originX: 1100,
        originY: 380,
        pointFormat: 'gemini',
      });
      assert.ok(result);
      assert.strictEqual(result.x, 1175);
      assert.strictEqual(result.y, 420);
    });
  });

  describe('7. Perimeter Tape Measure Ruler Corner Origin & Crosshair Style', () => {
    it('displays actual origin 1100,380 on corner badge instead of hardcoded 0,0', async () => {
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).createImageBitmap = async () => ({
        width: 150,
        height: 80,
        close() {},
      });

      const fillTextCalls: string[] = [];

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo() {},
            stroke() {},
            fillRect() {},
            fillText: (txt: string) => fillTextCalls.push(txt),
            measureText: (txt: string) => ({ width: txt.length * 6 }),
            setLineDash() {},
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            font: '',
          };
        }
        async convertToBlob() {
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          this.result = 'data:image/png;base64,ruler_data';
          this.onloadend?.();
        }
      };

      try {
        await overlayCoordinateGrid(
          'data:image/png;base64,sample',
          1,
          50,
          'image/png',
          0.8,
          { style: 'crosshair', originX: 1100, originY: 380 },
        );

        assert.ok(fillTextCalls.includes('1100,380'), 'Corner badge must show real ROI origin 1100,380');
        assert.ok(!fillTextCalls.includes('0,0'), 'Corner badge must NOT show 0,0 when origin is (1100, 380)');
      } finally {
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });

    it('crosshair style avoids full-canvas line-crossing strokes', async () => {
      const originalBitmap = (globalThis as any).createImageBitmap;
      const originalCanvas = (globalThis as any).OffscreenCanvas;
      const originalReader = (globalThis as any).FileReader;

      (globalThis as any).createImageBitmap = async () => ({
        width: 400,
        height: 300,
        close() {},
      });

      let lineToCalls = 0;

      (globalThis as any).OffscreenCanvas = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(w: number, h: number) {
          this.width = w;
          this.height = h;
        }
        getContext() {
          return {
            drawImage() {},
            save() {},
            restore() {},
            beginPath() {},
            moveTo() {},
            lineTo: () => lineToCalls++,
            stroke() {},
            fillRect() {},
            fillText() {},
            measureText: (txt: string) => ({ width: txt.length * 6 }),
            setLineDash() {},
            strokeStyle: '',
            fillStyle: '',
            lineWidth: 1,
            font: '',
          };
        }
        async convertToBlob() {
          return {};
        }
      };

      (globalThis as any).FileReader = class MockFileReader {
        onloadend: any;
        result: string = '';
        readAsDataURL() {
          this.result = 'data:image/png;base64,crosshair_data';
          this.onloadend?.();
        }
      };

      try {
        await overlayCoordinateGrid(
          'data:image/png;base64,sample',
          1,
          100,
          'image/png',
          0.8,
          { style: 'crosshair' },
        );

        // Reticle crosshairs draw 2 line segments per intersection (+ arm)
        // 3 x 2 intersections = 6 intersections * 2 = 12 lineTo calls.
        // Full screen guide lines would have added 2 * (3 + 2) = 10 full lineTo calls.
        assert.ok(lineToCalls > 0, 'Must draw reticle crosshairs');
        assert.ok(lineToCalls < 20, 'Must NOT draw full-canvas crossing guide lines in crosshair style');
      } finally {
        (globalThis as any).createImageBitmap = originalBitmap;
        (globalThis as any).OffscreenCanvas = originalCanvas;
        (globalThis as any).FileReader = originalReader;
      }
    });
  });

  describe('8. Magnetic Snapping: Large Elements & SVG Elements', () => {
    it('clamps safely within large element boundary (width > 120px) instead of jumping hundreds of pixels to center', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      // 500px wide card from [100..600, 100..400]
      const mockCard = {
        tagName: 'DIV',
        getAttribute: (a: string) => (a === 'role' ? 'button' : null),
        hasAttribute: (a: string) => a === 'role',
        getBoundingClientRect: () => ({
          left: 100,
          top: 100,
          right: 600,
          bottom: 400,
          width: 500,
          height: 300,
        }),
        parentElement: null,
      };

      const mockBody = {
        tagName: 'BODY',
        getAttribute: () => null,
        hasAttribute: () => false,
        parentElement: null,
      };

      (globalThis as any).window = {
        innerWidth: 1920,
        innerHeight: 1080,
        getComputedStyle: () => ({ cursor: 'pointer' }),
      };

      (globalThis as any).document = {
        documentElement: { clientWidth: 1920, clientHeight: 1080 },
        body: mockBody,
        elementFromPoint: (x: number, y: number) => {
          if (x >= 100 && x <= 600 && y >= 100 && y <= 400) return mockCard;
          return mockBody;
        },
      };

      try {
        // Click 10px to the left of the card: (90, 200)
        const snap = inPageSnapCoordinate(90, 200, 24);
        assert.strictEqual(snap.snapped, true);
        // Geometric center would be (350, 250) - 260px away!
        // Clamped snap must be near left boundary (100 + margin = 112)
        assert.ok(snap.x < 150, `Snapped X (${snap.x}) must remain near the left edge, not jump to 350 center`);
        assert.strictEqual(snap.y, 200, 'Snapped Y must remain at 200');
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });

    it('recognizes interactive SVG element via ownerSVGElement and snaps cleanly', () => {
      const origDoc = globalThis.document;
      const origWin = globalThis.window;

      const mockSvgRoot = {
        tagName: 'SVG',
        getAttribute: (a: string) => (a === 'role' ? 'button' : null),
        hasAttribute: (a: string) => a === 'onclick',
        onclick: () => {},
      };

      const mockSvgPath = {
        tagName: 'path',
        getAttribute: () => null,
        hasAttribute: () => false,
        ownerSVGElement: mockSvgRoot,
        getBoundingClientRect: () => ({
          left: 300,
          top: 300,
          right: 340,
          bottom: 340,
          width: 40,
          height: 40,
        }),
        parentElement: mockSvgRoot,
      };

      const mockBody = {
        tagName: 'BODY',
        getAttribute: () => null,
        hasAttribute: () => false,
        parentElement: null,
      };

      (globalThis as any).window = {
        innerWidth: 1280,
        innerHeight: 800,
        getComputedStyle: () => ({ cursor: 'default' }),
      };

      (globalThis as any).document = {
        documentElement: { clientWidth: 1280, clientHeight: 800 },
        body: mockBody,
        elementFromPoint: (x: number, y: number) => {
          if (x >= 300 && x <= 340 && y >= 300 && y <= 340) return mockSvgPath as any;
          return mockBody;
        },
      };

      try {
        // Click 10px below the SVG path at (320, 350)
        const snap = inPageSnapCoordinate(320, 350, 24);
        assert.strictEqual(snap.snapped, true);
        assert.strictEqual(snap.x, 320);
        assert.strictEqual(snap.y, 320);
      } finally {
        globalThis.document = origDoc;
        globalThis.window = origWin;
      }
    });
  });

  describe('9. Gemini Point Normalization & Extended Schema Contract', () => {
    it('parseUnifiedCoordinate automatically scales Gemini [y, x] points on full viewport without explicit scale option', () => {
      // Gemini sends [500, 500] meaning center of the screen
      const result = parseUnifiedCoordinate([500, 500], {
        viewportWidth: 1920,
        viewportHeight: 1080,
        pointFormat: 'gemini',
      });
      assert.ok(result);
      assert.strictEqual(result.x, 960, 'X must scale to 50% of 1920 = 960');
      assert.strictEqual(result.y, 540, 'Y must scale to 50% of 1080 = 540');
    });

    it('parseUnifiedCoordinate automatically scales Gemini point object { x: 500, y: 500 } on full viewport', () => {
      const result = parseUnifiedCoordinate(
        { x: 500, y: 500 },
        {
          viewportWidth: 1920,
          viewportHeight: 1080,
          pointFormat: 'gemini',
        },
      );
      assert.ok(result);
      assert.strictEqual(result.x, 960, 'X must scale to 50% of 1920 = 960');
      assert.strictEqual(result.y, 540, 'Y must scale to 50% of 1080 = 540');
    });

    it('chrome_screenshot and chrome_computer schemas accept visual drift parameters', () => {
      const screenshotSchema = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_screenshot');
      assert.ok(screenshotSchema);
      const sProps = screenshotSchema.inputSchema.properties;
      assert.ok(sProps.highClarity, 'highClarity must be in chrome_screenshot');
      assert.ok(sProps.grid, 'grid must be in chrome_screenshot');

      const computerSchema = TOOL_SCHEMAS.find((t: any) => t.name === 'chrome_computer');
      assert.ok(computerSchema);
      const cProps = computerSchema.inputSchema.properties;
      assert.ok(cProps.highClarity, 'highClarity must be in chrome_computer');
      assert.ok(cProps.grid, 'grid must be in chrome_computer');
      assert.ok(cProps.crop, 'crop must be in chrome_computer');
      assert.ok(cProps.region, 'region must be in chrome_computer');
    });
  });
});

