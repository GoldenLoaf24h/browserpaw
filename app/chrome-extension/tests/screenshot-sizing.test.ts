import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREENSHOT_MAX_DIMENSION,
  DEFAULT_SCREENSHOT_MAX_PIXELS,
  fitScreenshotToBudget,
} from '../entrypoints/background/tools/browser/screenshot';

describe('screenshot vision sizing', () => {
  it.each([
    ['landscape', 1920, 1080, 1429, 804],
    ['portrait', 1000, 1600, 847, 1356],
    ['ultrawide', 3440, 1440, 1568, 656],
  ])(
    'preserves aspect ratio for %s viewports',
    (_label, width, height, expectedWidth, expectedHeight) => {
      const fitted = fitScreenshotToBudget(width, height);

      expect(fitted).toMatchObject({ width: expectedWidth, height: expectedHeight });
      expect(fitted.width).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_MAX_DIMENSION);
      expect(fitted.height).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_MAX_DIMENSION);
      expect(fitted.width * fitted.height).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_MAX_PIXELS);
      expect(fitted.width / fitted.height).toBeCloseTo(width / height, 2);
    },
  );

  it('never upscales a small viewport', () => {
    expect(fitScreenshotToBudget(800, 600)).toEqual({ width: 800, height: 600, scale: 1 });
  });

  it('stays within the pixel budget when a viewport is only slightly over it', () => {
    const fitted = fitScreenshotToBudget(743, 1548);

    expect(fitted).toMatchObject({ width: 742, height: 1547 });
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(DEFAULT_SCREENSHOT_MAX_PIXELS);
  });

  it('honors high clarity and explicit budgets', () => {
    expect(fitScreenshotToBudget(1920, 1080, { highClarity: true })).toMatchObject({
      width: 1920,
      height: 1080,
    });
    expect(fitScreenshotToBudget(1920, 1080, { maxDimension: 768 })).toMatchObject({
      width: 768,
      height: 432,
    });
    expect(fitScreenshotToBudget(1000, 1000, { maxPixels: 400_000 })).toMatchObject({
      width: 632,
      height: 632,
    });
    expect(fitScreenshotToBudget(1600, 900, { maxWidth: 640 })).toMatchObject({
      width: 640,
      height: 360,
    });
  });
});
