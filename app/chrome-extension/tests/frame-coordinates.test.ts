import { describe, expect, it } from 'vitest';
import { projectPointThroughQuad } from '../utils/frame-coordinates';

describe('frame viewport homography', () => {
  it('preserves fractional coordinates through translation and nonuniform scaling', () => {
    expect(
      projectPointThroughQuad(
        { x: 25.5, y: 40.25 },
        100,
        100,
        [10, 20, 210, 20, 210, 320, 10, 320],
      ),
    ).toEqual({ x: 61, y: 140.75 });
  });

  it('handles rotation instead of adding the top-left offset', () => {
    expect(
      projectPointThroughQuad({ x: 25, y: 40 }, 100, 100, [100, 20, 100, 220, 0, 220, 0, 20]),
    ).toEqual({ x: 60, y: 70 });
  });

  it('projects perspective rather than interpolating a bounding rectangle', () => {
    const point = projectPointThroughQuad(
      { x: 50, y: 50 },
      100,
      100,
      [0, 0, 200, 0, 150, 100, 50, 100],
    );
    expect(point.x).toBeCloseTo(100);
    expect(point.y).toBeCloseTo(200 / 3);
  });

  it('maps all viewport corners to their corresponding perspective corners', () => {
    const quad = [10, 20, 210, 40, 170, 130, 30, 110];
    for (const [x, y, corner] of [
      [0, 0, 0],
      [100, 0, 1],
      [100, 100, 2],
      [0, 100, 3],
    ]) {
      const projected = projectPointThroughQuad({ x, y }, 100, 100, quad);
      expect(projected.x).toBeCloseTo(quad[corner * 2]);
      expect(projected.y).toBeCloseTo(quad[corner * 2 + 1]);
    }
  });

  it('composes nested renderer projections in order', () => {
    const local = projectPointThroughQuad(
      { x: 20, y: 30 },
      100,
      100,
      [10, 20, 210, 20, 210, 220, 10, 220],
    );
    const top = projectPointThroughQuad(local, 400, 300, [100, 50, 300, 50, 300, 200, 100, 200]);
    expect(top).toEqual({ x: 125, y: 90 });
  });

  it.each([
    [0, 100, [0, 0, 100, 0, 100, 100, 0, 100]],
    [100, 100, [0, 0, 100, 100, 0, 100, 100, 0]],
    [100, 100, [0, 0, 0, 0, 0, 0, 0, 0]],
    [100, 100, [0, NaN, 100, 0, 100, 100, 0, 100]],
  ])('rejects invalid, folded or zero-area geometry', (width, height, quad) => {
    expect(() =>
      projectPointThroughQuad(
        { x: 50, y: 50 },
        width as number,
        height as number,
        quad as number[],
      ),
    ).toThrow(/geometry|quad/);
  });
});
