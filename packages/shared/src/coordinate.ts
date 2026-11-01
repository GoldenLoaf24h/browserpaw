/**
 * Polymorphic Coordinate Inference Engine (PCIE)
 *
 * Model-agnostic coordinate parsing across universal multimodal spatial protocols:
 * 1. Bounding box [ymin, xmin, ymax, xmax] (row-first spatial grounding) -> safe geometric center
 * 2. Normalized 0~1.0 float, 0~1000 per-mille integer, and absolute CSS pixels
 * 3. Row-first point format [y, x] vs Cartesian point format [x, y]
 * 4. Object formats { x, y }, { left, top }, { xmin, ymin, xmax, ymax }, { point }, { box_2d }
 * 5. Viewport and ROI (originX, originY) offset mapping
 */

export type PolymorphicCoordinate =
  | { x: number; y: number }
  | { left?: number; top?: number }
  | { xmin?: number; ymin?: number; xmax?: number; ymax?: number }
  | { point?: [number, number] | { x: number; y: number } }
  | { box_2d?: [number, number, number, number] }
  | [number, number]
  | [number, number, number, number]
  | string
  | null
  | undefined
  | any;

export interface UnifiedCoordinateOptions {
  viewportWidth?: number;
  viewportHeight?: number;
  screenshotWidth?: number;
  screenshotHeight?: number;
  cropWidth?: number;
  cropHeight?: number;
  originX?: number; // ROI origin offset X
  originY?: number; // ROI origin offset Y
  pointFormat?: 'xy' | 'yx' | 'gemini' | 'openai' | 'auto';
  scale?: 'fraction' | '1000' | 'pixel' | 'auto';
}

export interface ParsedCoordinate {
  x: number;
  y: number;
}

/**
 * Parse any polymorphic multimodal coordinate into standard CSS viewport pixels { x, y }.
 */
export function parseUnifiedCoordinate(
  raw: PolymorphicCoordinate,
  options?: UnifiedCoordinateOptions,
): ParsedCoordinate | null {
  if (raw === null || raw === undefined) {
    return null;
  }

  // Handle string input (e.g. JSON string "[100, 200]" or "100, 200")
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parseUnifiedCoordinate(parsed, options);
    } catch {
      const parts = trimmed
        .split(/[\s,]+/)
        .map((s) => parseFloat(s))
        .filter((n) => !isNaN(n));
      if (parts.length === 2 || parts.length === 4) {
        return parseUnifiedCoordinate(parts as any, options);
      }
      return null;
    }
  }

  const vw =
    typeof options?.viewportWidth === 'number' && options.viewportWidth > 0
      ? options.viewportWidth
      : 1280;
  const vh =
    typeof options?.viewportHeight === 'number' && options.viewportHeight > 0
      ? options.viewportHeight
      : 800;
  const ox = options?.originX || 0;
  const oy = options?.originY || 0;
  const isCropped = Boolean(
    options?.originX || options?.originY || options?.cropWidth || options?.cropHeight,
  );
  const targetW =
    options?.cropWidth ?? (isCropped ? (options?.cropWidth ?? options?.screenshotWidth ?? vw) : vw);
  const targetH =
    options?.cropHeight ??
    (isCropped ? (options?.cropHeight ?? options?.screenshotHeight ?? vh) : vh);
  const pointFormat = options?.pointFormat || 'auto';
  const roundedPoint = (x: number, y: number): ParsedCoordinate | null => {
    const point = { x: Math.round(x + ox), y: Math.round(y + oy) };
    return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
  };

  // Handle nested wrapper objects
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    if (Array.isArray(raw.box_2d) && raw.box_2d.length === 4) {
      const maxVal = Math.max(...raw.box_2d.map(Number));
      const boxOpts: UnifiedCoordinateOptions = {
        ...options,
        pointFormat: options?.pointFormat || 'gemini',
        scale: options?.scale || (maxVal > 1 ? '1000' : 'fraction'),
      };
      return parseUnifiedCoordinate(raw.box_2d, boxOpts);
    }
    if (raw.point) {
      const isArr = Array.isArray(raw.point);
      const maxVal = isArr ? Math.max(...raw.point.map(Number)) : 0;
      const pointOpts: UnifiedCoordinateOptions = {
        ...options,
        pointFormat: options?.pointFormat || 'gemini',
        scale: options?.scale || (isArr && maxVal > 1 ? '1000' : undefined),
      };
      return parseUnifiedCoordinate(raw.point, pointOpts);
    }
    if (
      typeof raw.xmin === 'number' &&
      typeof raw.xmax === 'number' &&
      typeof raw.ymin === 'number' &&
      typeof raw.ymax === 'number'
    ) {
      // Explicit named bounding box
      return parseUnifiedCoordinate([raw.ymin, raw.xmin, raw.ymax, raw.xmax], options);
    }

    const rawX =
      typeof raw.x === 'number'
        ? raw.x
        : typeof raw.left === 'number'
          ? raw.left
          : typeof raw.x === 'string' && !isNaN(Number(raw.x))
            ? Number(raw.x)
            : typeof raw.left === 'string' && !isNaN(Number(raw.left))
              ? Number(raw.left)
              : undefined;
    const rawY =
      typeof raw.y === 'number'
        ? raw.y
        : typeof raw.top === 'number'
          ? raw.top
          : typeof raw.y === 'string' && !isNaN(Number(raw.y))
            ? Number(raw.y)
            : typeof raw.top === 'string' && !isNaN(Number(raw.top))
              ? Number(raw.top)
              : undefined;

    if (
      typeof rawX === 'number' &&
      Number.isFinite(rawX) &&
      typeof rawY === 'number' &&
      Number.isFinite(rawY)
    ) {
      let finalX = rawX;
      let finalY = rawY;

      if (
        options?.scale === 'fraction' ||
        (options?.scale !== 'pixel' &&
          options?.scale !== '1000' &&
          rawX <= 1.0 &&
          rawY <= 1.0 &&
          (rawX > 0 || rawY > 0) &&
          targetW > 1)
      ) {
        finalX = rawX * targetW;
        finalY = rawY * targetH;
      } else if (
        options?.scale === '1000' ||
        (options?.scale !== 'pixel' &&
          (rawX > 1 || rawY > 1) &&
          rawX <= 1000 &&
          rawY <= 1000 &&
          (pointFormat === 'gemini' || rawX > targetW || rawY > targetH))
      ) {
        finalX = (rawX / 1000) * targetW;
        finalY = (rawY / 1000) * targetH;
      } else {
        if (
          options?.screenshotWidth &&
          options.screenshotWidth > 0 &&
          options.screenshotWidth !== targetW
        ) {
          finalX = (rawX / options.screenshotWidth) * targetW;
        }
        if (
          options?.screenshotHeight &&
          options.screenshotHeight > 0 &&
          options.screenshotHeight !== targetH
        ) {
          finalY = (rawY / options.screenshotHeight) * targetH;
        }
      }

      return roundedPoint(finalX, finalY);
    }

    return null;
  }

  // Handle 4-number Bounding Box [ymin, xmin, ymax, xmax] or [xmin, ymin, xmax, ymax]
  if (Array.isArray(raw) && raw.length === 4) {
    const [a, b, c, d] = raw.map((n) => Number(n));
    if (![a, b, c, d].every(Number.isFinite)) return null;

    // Detect orientation: Row-first [ymin, xmin, ymax, xmax] vs Cartesian [xmin, ymin, xmax, ymax]
    let isYminFirst = true;
    if (pointFormat === 'openai' || pointFormat === 'xy') {
      isYminFirst = false;
    } else if (pointFormat === 'gemini' || pointFormat === 'yx') {
      isYminFirst = true;
    } else {
      if ((a > vh || c > vh) && a <= vw && c <= vw) {
        isYminFirst = false; // [xmin, ymin, xmax, ymax]
      } else if ((b > vh || d > vh) && b <= vw && d <= vw) {
        isYminFirst = true; // [ymin, xmin, ymax, xmax]
      }
    }

    const ymin = isYminFirst ? Math.min(a, c) : Math.min(b, d);
    const ymax = isYminFirst ? Math.max(a, c) : Math.max(b, d);
    const xmin = isYminFirst ? Math.min(b, d) : Math.min(a, c);
    const xmax = isYminFirst ? Math.max(b, d) : Math.max(a, c);

    const cx = (xmin + xmax) / 2;
    const cy = (ymin + ymax) / 2;
    const maxVal = Math.max(a, b, c, d);

    let finalX = cx;
    let finalY = cy;

    if (
      options?.scale === 'fraction' ||
      (options?.scale !== 'pixel' && options?.scale !== '1000' && maxVal <= 1.0 && maxVal > 0)
    ) {
      // 0~1.0 normalized
      finalX = cx * targetW;
      finalY = cy * targetH;
    } else if (
      options?.scale === '1000' ||
      (options?.scale !== 'pixel' &&
        (pointFormat === 'gemini' || (maxVal <= 1000 && (ymax > targetH || xmax > targetW))))
    ) {
      // 0~1000 per-mille
      finalX = (cx / 1000) * targetW;
      finalY = (cy / 1000) * targetH;
    } else {
      // Absolute pixels
      if (
        options?.screenshotWidth &&
        options.screenshotWidth > 0 &&
        options.screenshotWidth !== targetW
      ) {
        finalX = (cx / options.screenshotWidth) * targetW;
      } else {
        finalX = cx;
      }
      if (
        options?.screenshotHeight &&
        options.screenshotHeight > 0 &&
        options.screenshotHeight !== targetH
      ) {
        finalY = (cy / options.screenshotHeight) * targetH;
      } else {
        finalY = cy;
      }
    }

    return roundedPoint(finalX, finalY);
  }

  // Handle 2-number Point [x, y] or [y, x]
  if (Array.isArray(raw) && raw.length === 2) {
    const [a, b] = raw.map((n) => Number(n));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

    let rawX = a;
    let rawY = b;

    const pointFormat = options?.pointFormat || 'auto';
    if (pointFormat === 'yx' || pointFormat === 'gemini') {
      rawX = b;
      rawY = a;
    } else if (pointFormat === 'xy' || pointFormat === 'openai') {
      rawX = a;
      rawY = b;
    } else {
      // Auto heuristic detection
      if (a > vh && a <= vw) {
        // a cannot be y, so it is x -> [x, y] (OpenAI)
        rawX = a;
        rawY = b;
      } else if (b > vh && b <= vw) {
        // b cannot be y, so b is x -> [y, x] (Gemini)
        rawX = b;
        rawY = a;
      } else if (a > vw && a <= vh) {
        // a cannot be x, so a is y -> [y, x] (Gemini)
        rawX = b;
        rawY = a;
      } else if (b > vw && b <= vh) {
        // b cannot be x, so b is y -> [x, y] (OpenAI)
        rawX = a;
        rawY = b;
      } else {
        // Default standard Cartesian [x, y]
        rawX = a;
        rawY = b;
      }
    }

    let finalX = rawX;
    let finalY = rawY;

    if (
      options?.scale === 'fraction' ||
      (options?.scale !== 'pixel' &&
        options?.scale !== '1000' &&
        rawX <= 1.0 &&
        rawY <= 1.0 &&
        (rawX > 0 || rawY > 0))
    ) {
      finalX = rawX * targetW;
      finalY = rawY * targetH;
    } else if (
      options?.scale === '1000' ||
      (options?.scale !== 'pixel' &&
        (rawX > 1 || rawY > 1) &&
        rawX <= 1000 &&
        rawY <= 1000 &&
        (pointFormat === 'gemini' || rawX > targetW || rawY > targetH))
    ) {
      finalX = (rawX / 1000) * targetW;
      finalY = (rawY / 1000) * targetH;
    } else {
      if (
        options?.screenshotWidth &&
        options.screenshotWidth > 0 &&
        options.screenshotWidth !== targetW
      ) {
        finalX = (rawX / options.screenshotWidth) * targetW;
      }
      if (
        options?.screenshotHeight &&
        options.screenshotHeight > 0 &&
        options.screenshotHeight !== targetH
      ) {
        finalY = (rawY / options.screenshotHeight) * targetH;
      }
    }

    return roundedPoint(finalX, finalY);
  }

  return null;
}
