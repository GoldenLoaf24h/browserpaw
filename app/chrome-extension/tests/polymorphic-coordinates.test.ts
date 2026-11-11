import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { parseUnifiedCoordinate, type UnifiedCoordinateOptions } from 'chrome-mcp-shared';
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
