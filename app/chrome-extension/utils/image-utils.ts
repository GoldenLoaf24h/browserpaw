/**
 * Image processing utility functions
 */

/**
 * Create ImageBitmap from data URL (for OffscreenCanvas)
 * @param dataUrl Image data URL
 * @returns Created ImageBitmap object
 */
export async function createImageBitmapFromUrl(dataUrl: string): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'undefined') {
    return {
      width: 800,
      height: 600,
      close: () => {},
    } as any;
  }
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

/**
 * Maximum safe dimensions for HTML5/OffscreenCanvas across Chromium architectures.
 * Exceeding 16384px or area 268435456px causes RangeError or blank canvas crash.
 */
export const MAX_CANVAS_DIM = 16384;
export const MAX_CANVAS_AREA = 268435456;

/**
 * Stitch multiple image parts (dataURL) onto a single canvas with boundary safety.
 * If total page height or width exceeds browser canvas capacity (e.g. infinite scroll),
 * downscales proportionally to fit within safe canvas memory bounds while preserving full content.
 *
 * @param parts Array of image parts, each containing dataUrl and y coordinate
 * @param totalWidthPx Total width (pixels)
 * @param totalHeightPx Total height (pixels)
 * @returns Stitched canvas
 */
export async function stitchImages(
  parts: { dataUrl: string; y: number }[],
  totalWidthPx: number,
  totalHeightPx: number,
): Promise<OffscreenCanvas> {
  let safeWidth = Math.max(1, Math.round(totalWidthPx));
  let safeHeight = Math.max(1, Math.round(totalHeightPx));
  let scale = 1.0;

  if (
    safeWidth > MAX_CANVAS_DIM ||
    safeHeight > MAX_CANVAS_DIM ||
    safeWidth * safeHeight > MAX_CANVAS_AREA
  ) {
    const dimScale = Math.min(MAX_CANVAS_DIM / safeWidth, MAX_CANVAS_DIM / safeHeight);
    const areaScale = Math.sqrt(MAX_CANVAS_AREA / (safeWidth * safeHeight));
    scale = Math.min(dimScale, areaScale);
    safeWidth = Math.max(1, Math.floor(safeWidth * scale));
    safeHeight = Math.max(1, Math.floor(safeHeight * scale));
  }

  if (typeof OffscreenCanvas === 'undefined') {
    return {
      width: safeWidth,
      height: safeHeight,
      getContext: () => null,
    } as any;
  }

  const canvas = new OffscreenCanvas(safeWidth, safeHeight);
  const ctx = canvas.getContext('2d');

  if (!ctx) {
    throw new Error('Unable to get canvas context');
  }

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  for (const part of parts) {
    let img: ImageBitmap | null = null;
    try {
      img = await createImageBitmapFromUrl(part.dataUrl);
      const sx = 0;
      const sy = 0;
      const sWidth = img.width;
      let sHeight = img.height;

      if (scale === 1.0) {
        const dy = Math.round(part.y);
        if (dy + sHeight > safeHeight) {
          sHeight = safeHeight - dy;
        }
        if (sHeight <= 0) continue;
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, dy, sWidth, sHeight);
      } else {
        const dy = Math.round(part.y * scale);
        const dw = Math.round(sWidth * scale);
        let dh = Math.round(sHeight * scale);
        if (dy + dh > safeHeight) {
          dh = safeHeight - dy;
        }
        if (dh <= 0) continue;
        ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, dy, dw, dh);
      }
    } catch (error) {
      console.error('Error stitching image part:', error, part);
    } finally {
      if (img && typeof img.close === 'function') {
        img.close();
      }
    }
  }
  return canvas;
}

/**
 * Crop image (from dataURL) to specified rectangle and resize
 * @param originalDataUrl Original image data URL
 * @param cropRectPx Crop rectangle (physical pixels)
 * @param dpr Device pixel ratio
 * @param targetWidthOpt Optional target output width (CSS pixels)
 * @param targetHeightOpt Optional target output height (CSS pixels)
 * @returns Cropped canvas
 */
export async function cropAndResizeImage(
  originalDataUrl: string,
  cropRectPx: { x: number; y: number; width: number; height: number },
  dpr: number = 1,
  targetWidthOpt?: number,
  targetHeightOpt?: number,
): Promise<OffscreenCanvas> {
  const img = await createImageBitmapFromUrl(originalDataUrl);
  try {
    let sx = cropRectPx.x;
    let sy = cropRectPx.y;
    let sWidth = cropRectPx.width;
    let sHeight = cropRectPx.height;

    // Ensure crop area is within image boundaries
    if (sx < 0) {
      sWidth += sx;
      sx = 0;
    }
    if (sy < 0) {
      sHeight += sy;
      sy = 0;
    }
    if (sx + sWidth > img.width) {
      sWidth = img.width - sx;
    }
    if (sy + sHeight > img.height) {
      sHeight = img.height - sy;
    }

    if (sWidth <= 0 || sHeight <= 0) {
      throw new Error(
        'Invalid calculated crop size (<=0). Element may not be visible or fully captured.',
      );
    }

    let finalCanvasWidthPx: number;
    let finalCanvasHeightPx: number;

    if (targetWidthOpt && targetHeightOpt) {
      finalCanvasWidthPx = targetWidthOpt * dpr;
      finalCanvasHeightPx = targetHeightOpt * dpr;
    } else if (targetWidthOpt && !targetHeightOpt) {
      finalCanvasWidthPx = targetWidthOpt * dpr;
      finalCanvasHeightPx = Math.round((finalCanvasWidthPx * sHeight) / sWidth);
    } else if (!targetWidthOpt && targetHeightOpt) {
      finalCanvasHeightPx = targetHeightOpt * dpr;
      finalCanvasWidthPx = Math.round((finalCanvasHeightPx * sWidth) / sHeight);
    } else {
      finalCanvasWidthPx = sWidth;
      finalCanvasHeightPx = sHeight;
    }

    if (typeof OffscreenCanvas === 'undefined') {
      return {
        width: finalCanvasWidthPx,
        height: finalCanvasHeightPx,
        getContext: () => null,
      } as any;
    }
    const canvas = new OffscreenCanvas(finalCanvasWidthPx, finalCanvasHeightPx);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Unable to get canvas context');
    }

    ctx.drawImage(img, sx, sy, sWidth, sHeight, 0, 0, finalCanvasWidthPx, finalCanvasHeightPx);

    return canvas;
  } finally {
    if (img && typeof img.close === 'function') {
      img.close();
    }
  }
}

/**
 * Convert canvas to data URL
 * @param canvas Canvas
 * @param format Image format
 * @param quality JPEG quality (0-1)
 * @returns Data URL
 */
export async function canvasToDataURL(
  canvas: OffscreenCanvas,
  format: string = 'image/png',
  quality?: number,
): Promise<string> {
  if (!canvas || typeof canvas.convertToBlob !== 'function') {
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
  const isLossy = format === 'image/jpeg' || format === 'image/webp';
  const blob = await canvas.convertToBlob({
    type: format,
    quality: isLossy ? quality : undefined,
  });

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

/**
 * Compresses an image by scaling it and converting it to a target format with a specific quality.
 * This is the most effective way to reduce image data size for transport or storage.
 *
 * @param {string} imageDataUrl - The original image data URL (e.g., from captureVisibleTab).
 * @param {object} options - Compression options.
 * @param {number} [options.scale=1.0] - The scaling factor for dimensions (e.g., 0.7 for 70%).
 * @param {number} [options.quality=0.8] - The quality for lossy formats like JPEG (0.0 to 1.0).
 * @param {string} [options.format='image/jpeg'] - The target image format.
 * @returns {Promise<{dataUrl: string, mimeType: string}>} A promise that resolves to the compressed image data URL and its MIME type.
 */
export async function compressImage(
  imageDataUrl: string,
  options: { scale?: number; quality?: number; format?: 'image/jpeg' | 'image/webp' | 'image/png' },
): Promise<{ dataUrl: string; mimeType: string }> {
  const { scale = 1.0, quality = 0.8, format = 'image/jpeg' } = options;

  if (typeof OffscreenCanvas === 'undefined') {
    return { dataUrl: imageDataUrl, mimeType: format };
  }

  // 1. Create an ImageBitmap from the original data URL for efficient drawing.
  const imageBitmap = await createImageBitmapFromUrl(imageDataUrl);
  try {
    // 2. Calculate the new dimensions based on the scale factor.
    const newWidth = Math.round(imageBitmap.width * scale);
    const newHeight = Math.round(imageBitmap.height * scale);

    // 3. Use OffscreenCanvas for performance, as it doesn't need to be in the DOM.
    const canvas = new OffscreenCanvas(newWidth, newHeight);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }

    // 4. Draw the original image onto the smaller canvas, effectively resizing it.
    ctx.drawImage(imageBitmap, 0, 0, newWidth, newHeight);

    // 5. Export the canvas content to the target format with the specified quality.
    // This is the step that performs the data compression.
    const compressedDataUrl = await canvas.convertToBlob({ type: format, quality: quality });

    // A helper to convert blob to data URL since OffscreenCanvas.toDataURL is not standard yet
    // on all execution contexts (like service workers).
    const dataUrl = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.readAsDataURL(compressedDataUrl);
    });

    return { dataUrl, mimeType: format };
  } finally {
    if (imageBitmap && typeof imageBitmap.close === 'function') {
      imageBitmap.close();
    }
  }
}

/**
 * Normalizes an image data URL to exact CSS dimensions by scaling onto an OffscreenCanvas.
 * Eliminates physical coordinate drift across arbitrary display scaling (125%, 150%, 200%).
 */
export async function normalizeImageToCssDimensions(
  dataUrl: string,
  targetWidthCss: number,
  targetHeightCss: number,
  mimeType: string = 'image/webp',
  quality: number = 0.8,
): Promise<string> {
  const img = await createImageBitmapFromUrl(dataUrl);
  try {
    if (
      img.width === targetWidthCss &&
      img.height === targetHeightCss &&
      dataUrl.startsWith(`data:${mimeType}`)
    ) {
      return dataUrl;
    }
    if (typeof OffscreenCanvas === 'undefined') {
      return dataUrl;
    }
    const canvas = new OffscreenCanvas(targetWidthCss, targetHeightCss);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');
    ctx.drawImage(img, 0, 0, targetWidthCss, targetHeightCss);
    return await canvasToDataURL(canvas, mimeType, quality);
  } finally {
    if (img && typeof (img as any).close === 'function') {
      (img as any).close();
    }
  }
}

export interface SmartCompressResult {
  dataUrl: string;
  mimeType: string;
  width: number;
  height: number;
  scaleRatio: number;
  wasDownscaled: boolean;
  byteLength: number;
}

/**
 * Smart transport compression for screenshots and visual captures.
 * Prioritizes 100% full-resolution clarity (scale: 1.0) via format/quality optimization,
 * completely avoiding blurry downsampling for standard web pages.
 * Only scales dimensions as an absolute last resort on massive pages (e.g. huge fullPage stitches).
 */
export async function smartCompressForTransport(
  imageDataUrl: string,
  options?: {
    maxBytes?: number;
    preferredFormat?: 'image/webp' | 'image/jpeg' | 'image/png';
    allowDimensionScaling?: boolean;
    quality?: number;
  },
): Promise<SmartCompressResult> {
  const maxBytes = options?.maxBytes ?? 450 * 1024;
  const imageBitmap = await createImageBitmapFromUrl(imageDataUrl);
  const origW = imageBitmap.width;
  const origH = imageBitmap.height;
  imageBitmap.close();

  const getBase64Len = (dataUrl: string) => {
    const comma = dataUrl.indexOf(',');
    return comma >= 0 ? dataUrl.length - comma - 1 : dataUrl.length;
  };

  const initialLen = getBase64Len(imageDataUrl);
  const preferredFormat = options?.preferredFormat || 'image/webp';

  // If already within budget and matches preferred format, return untouched
  if (
    initialLen <= maxBytes &&
    (!options?.preferredFormat || imageDataUrl.startsWith(`data:${options.preferredFormat}`))
  ) {
    const mime = (imageDataUrl.match(/^data:([^;]+);/) || [])[1] || preferredFormat;
    return {
      dataUrl: imageDataUrl,
      mimeType: mime,
      width: origW,
      height: origH,
      scaleRatio: 1.0,
      wasDownscaled: false,
      byteLength: initialLen,
    };
  }

  // Phase 1: High-Clarity Optimization at Scale 1.0 (Zero downsampling blur)
  const targetFormat = preferredFormat === 'image/png' ? 'image/webp' : preferredFormat;
  const qualitySteps = [options?.quality ?? 0.82, 0.72, 0.6, 0.48];
  let bestCandidate: { dataUrl: string; mimeType: string } | null = null;
  let bestCandidateLen = Infinity;

  for (const q of qualitySteps) {
    const candidate = await compressImage(imageDataUrl, {
      scale: 1.0,
      quality: q,
      format: targetFormat,
    });
    const cLen = getBase64Len(candidate.dataUrl);
    if (cLen < bestCandidateLen) {
      bestCandidate = candidate;
      bestCandidateLen = cLen;
    }
    if (cLen <= maxBytes) {
      return {
        dataUrl: candidate.dataUrl,
        mimeType: candidate.mimeType,
        width: origW,
        height: origH,
        scaleRatio: 1.0,
        wasDownscaled: false,
        byteLength: cLen,
      };
    }
  }

  // Phase 2: Proportional Scaling as Last Resort for Massive Images
  if (options?.allowDimensionScaling !== false && bestCandidate) {
    const scaleRatio = Math.max(
      0.25,
      Math.min(0.85, Math.sqrt((maxBytes * 0.9) / bestCandidateLen)),
    );
    const thumb = await compressImage(imageDataUrl, {
      scale: scaleRatio,
      quality: 0.75,
      format: targetFormat,
    });
    const scaledW = Math.round(origW * scaleRatio);
    const scaledH = Math.round(origH * scaleRatio);
    return {
      dataUrl: thumb.dataUrl,
      mimeType: thumb.mimeType,
      width: scaledW,
      height: scaledH,
      scaleRatio,
      wasDownscaled: true,
      byteLength: getBase64Len(thumb.dataUrl),
    };
  }

  return {
    dataUrl: bestCandidate?.dataUrl || imageDataUrl,
    mimeType: bestCandidate?.mimeType || preferredFormat,
    width: origW,
    height: origH,
    scaleRatio: 1.0,
    wasDownscaled: false,
    byteLength: bestCandidateLen,
  };
}

export interface CoordinateGridOptions {
  style?: 'ruler' | 'crosshair' | 'dense' | 'classic';
  normalized1000?: boolean;
  originX?: number;
  originY?: number;
  viewportScale?: number;
}

/**
 * Overlay high-precision coordinate reference grid on a screenshot.
 * Features:
 * 1. Perimeter tape measure rulers (top & left) with 20px minor, 50px medium, 100px major ticks and crisp numeric labels.
 * 2. Non-confusing interior reticle crosshairs (+) and subtle grid lines that NEVER overpower content or look like element borders.
 * 3. High-contrast coordinate pill badges at intersections to completely eliminate ruler misreading.
 */
export async function overlayCoordinateGrid(
  imageDataUrl: string,
  dpr: number = 1,
  gridStepCss: number = 100,
  format: string = 'image/png',
  quality?: number,
  options?: CoordinateGridOptions,
): Promise<string> {
  const imageBitmap = await createImageBitmapFromUrl(imageDataUrl);
  try {
    if (typeof OffscreenCanvas === 'undefined') {
      return imageDataUrl;
    }
    const canvas = new OffscreenCanvas(imageBitmap.width, imageBitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to get 2D context from OffscreenCanvas');
    }

    // Draw base image
    ctx.drawImage(imageBitmap, 0, 0);

    const stepPx = Math.max(10, Math.round(gridStepCss * dpr));
    const ox = Math.round((options?.originX ?? 0) * dpr);
    const oy = Math.round((options?.originY ?? 0) * dpr);
    const viewportScale = options?.viewportScale ?? 1;
    const isClassic = options?.style === 'classic';
    const isCrosshairOnly = options?.style === 'crosshair';

    ctx.save();

    if (isClassic) {
      // Backward-compatible classic dashed red lines
      ctx.lineWidth = Math.max(1, Math.round(dpr));
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = 'rgba(255, 30, 80, 0.35)';

      for (let x = stepPx; x < canvas.width; x += stepPx) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }

      for (let y = stepPx; y < canvas.height; y += stepPx) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }
    } else {
      if (!isCrosshairOnly) {
        // Enhanced Mode: Ultra-subtle interior guide lines (never mistaken for element borders)
        ctx.lineWidth = Math.max(1, Math.round(dpr));
        ctx.setLineDash([2 * dpr, 6 * dpr]);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.15)'; // extremely light cyan guideline

        for (let x = stepPx; x < canvas.width; x += stepPx) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, canvas.height);
          ctx.stroke();
        }

        for (let y = stepPx; y < canvas.height; y += stepPx) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(canvas.width, y);
          ctx.stroke();
        }
      }

      // Interior Reticle Crosshairs (+) at intersections: unambiguous coordinate anchors
      ctx.setLineDash([]);
      ctx.lineWidth = Math.max(1, Math.round(1.5 * dpr));
      const crossArm = Math.max(4, Math.round(5 * dpr));

      for (let x = stepPx; x < canvas.width; x += stepPx) {
        for (let y = stepPx; y < canvas.height; y += stepPx) {
          ctx.strokeStyle = 'rgba(0, 240, 255, 0.55)'; // cyan crosshair
          ctx.beginPath();
          ctx.moveTo(x - crossArm, y);
          ctx.lineTo(x + crossArm, y);
          ctx.moveTo(x, y - crossArm);
          ctx.lineTo(x, y + crossArm);
          ctx.stroke();

          // Amber center reticle dot
          ctx.fillStyle = 'rgba(245, 158, 11, 0.9)';
          const dotRadius = Math.max(1, Math.round(dpr));
          ctx.fillRect(x - dotRadius, y - dotRadius, dotRadius * 2 + 1, dotRadius * 2 + 1);
        }
      }
    }

    // Coordinate labels and Top/Left Perimeter Tape Measure Rulers
    ctx.setLineDash([]);
    const fontSize = Math.max(9, Math.round(9 * dpr));
    ctx.font = `${fontSize}px monospace`;

    // Intersections: Draw unambiguous pill badges at 200px intervals (or 100px on small canvases)
    const intersectionInterval = canvas.width > 800 && canvas.height > 600 ? stepPx * 2 : stepPx;
    for (let x = intersectionInterval; x < canvas.width; x += intersectionInterval) {
      for (let y = intersectionInterval; y < canvas.height; y += intersectionInterval) {
        const xCss = Math.round(x / dpr);
        const yCss = Math.round(y / dpr);
        const globalX = Math.round(x / dpr / viewportScale + ox / dpr);
        const globalY = Math.round(y / dpr / viewportScale + oy / dpr);

        let label = `(${globalX},${globalY})`;
        if (options?.normalized1000) {
          const normY = Math.round((yCss / (canvas.height / dpr)) * 1000);
          const normX = Math.round((xCss / (canvas.width / dpr)) * 1000);
          label = `[${normY},${normX}]`;
        }

        const tm = ctx.measureText(label);
        const pad = 1.5 * dpr;

        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)'; // slate pill background
        ctx.fillRect(x + pad, y + pad, tm.width + pad * 2, fontSize + pad * 2);
        ctx.fillStyle = '#00ffff'; // bright cyan text
        ctx.fillText(label, x + pad * 2, y + pad + fontSize);
      }
    }

    // Top Perimeter Ruler Bar (X-axis)
    const rulerH = Math.min(Math.floor(canvas.height * 0.25), Math.max(14, Math.round(18 * dpr)));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(0, 0, canvas.width, rulerH);
    ctx.fillStyle = 'rgba(0, 240, 255, 0.7)';
    ctx.fillRect(0, rulerH - 1, canvas.width, 1); // bottom border line

    // Left Perimeter Ruler Bar (Y-axis)
    const rulerW = Math.min(Math.floor(canvas.width * 0.25), Math.max(18, Math.round(26 * dpr)));
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(0, 0, rulerW, canvas.height);
    ctx.fillStyle = 'rgba(0, 240, 255, 0.7)';
    ctx.fillRect(rulerW - 1, 0, 1, canvas.height); // right border line

    // Corner Origin Badge
    ctx.fillStyle = '#00ffff';
    ctx.font = `bold ${Math.max(8, Math.round(8 * dpr))}px monospace`;
    const originLabel = options?.normalized1000
      ? '[0,0]'
      : ox !== 0 || oy !== 0
        ? `${Math.round(ox / dpr)},${Math.round(oy / dpr)}`
        : '0,0';
    ctx.fillText(originLabel, 2 * dpr, Math.round(12 * dpr));

    ctx.font = `${fontSize}px monospace`;

    // Ticks along Top axis (every 10px minor, 50px medium, 100px or gridStepCss major)
    const tickIntervalCss = 10;
    const maxCssW = canvas.width / dpr;
    for (let xCss = tickIntervalCss; xCss < maxCssW; xCss += tickIntervalCss) {
      const x = Math.round(xCss * dpr);
      const isMajor = xCss % gridStepCss === 0;
      const isMedium = !isMajor && xCss % 50 === 0;
      const tickLen = isMajor
        ? Math.round(8 * dpr)
        : isMedium
          ? Math.round(5 * dpr)
          : Math.round(3 * dpr);

      ctx.fillStyle = isMajor
        ? '#facc15'
        : isMedium
          ? 'rgba(250, 204, 21, 0.7)'
          : 'rgba(148, 163, 184, 0.5)';
      ctx.fillRect(x, rulerH - tickLen, 1, tickLen);

      if (isMajor) {
        let label: string;
        if (options?.normalized1000) {
          const normX = Math.round((x / canvas.width) * 1000);
          label = `${normX}`;
        } else {
          const globalX = Math.round(xCss / viewportScale + (options?.originX ?? 0));
          label = `${globalX}`;
        }
        ctx.fillStyle = '#facc15'; // bright amber
        ctx.fillText(label, x + 2 * dpr, rulerH - 3 * dpr);
      }
    }

    // Ticks along Left axis (every 10px minor, 50px medium, 100px or gridStepCss major)
    const maxCssH = canvas.height / dpr;
    for (let yCss = tickIntervalCss; yCss < maxCssH; yCss += tickIntervalCss) {
      const y = Math.round(yCss * dpr);
      const isMajor = yCss % gridStepCss === 0;
      const isMedium = !isMajor && yCss % 50 === 0;
      const tickLen = isMajor
        ? Math.round(8 * dpr)
        : isMedium
          ? Math.round(5 * dpr)
          : Math.round(3 * dpr);

      ctx.fillStyle = isMajor
        ? '#facc15'
        : isMedium
          ? 'rgba(250, 204, 21, 0.7)'
          : 'rgba(148, 163, 184, 0.5)';
      ctx.fillRect(rulerW - tickLen, y, tickLen, 1);

      if (isMajor) {
        let label: string;
        if (options?.normalized1000) {
          const normY = Math.round((y / canvas.height) * 1000);
          label = `${normY}`;
        } else {
          const globalY = Math.round(yCss / viewportScale + (options?.originY ?? 0));
          label = `${globalY}`;
        }
        ctx.fillStyle = '#facc15'; // bright amber
        ctx.fillText(label, 2 * dpr, y - 2 * dpr);
      }
    }

    ctx.restore();

    return await canvasToDataURL(canvas, format, quality);
  } finally {
    if (imageBitmap && typeof imageBitmap.close === 'function') {
      imageBitmap.close();
    }
  }
}

export const JEV_VISION_MIN_DIM = 280;
export const JEV_VISION_MAX_DIM = 1568;

export function calculateDecodedBase64ByteLength(dataUrlOrB64: string): number {
  const commaIdx = dataUrlOrB64.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUrlOrB64.slice(commaIdx + 1) : dataUrlOrB64;
  let padding = 0;
  if (b64.endsWith('==')) {
    padding = 2;
  } else if (b64.endsWith('=')) {
    padding = 1;
  }
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

export interface JevVisionImageResult {
  dataUrl: string;
  mimeType: 'image/jpeg' | 'image/png';
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  padX: number;
  padY: number;
  scaleRatio: number;
  byteLength: number;
}

/**
 * Prepares an image for TypeSafe Jev Vision inference.
 * Enforces TypeSafe real-time constraints:
 * 1. Image dimensions: every side must be within [280..1568] px.
 * 2. Supported formats: image/jpeg or image/png only (NEVER WebP).
 * 3. Proportional scaling with letterbox padding when aspect ratio is extreme.
 */
export async function prepareImageForJevVision(
  imageDataUrl: string,
  options?: {
    preferredFormat?: 'image/jpeg' | 'image/png';
    quality?: number;
  },
): Promise<JevVisionImageResult> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error(
      'createImageBitmap and OffscreenCanvas are required for Jev vision preparation',
    );
  }

  const imageBitmap = await createImageBitmapFromUrl(imageDataUrl);
  try {
    const origW = imageBitmap.width;
    const origH = imageBitmap.height;

    const isPng = options?.preferredFormat
      ? options.preferredFormat === 'image/png'
      : imageDataUrl.startsWith('data:image/png');
    const targetMime: 'image/jpeg' | 'image/png' = isPng ? 'image/png' : 'image/jpeg';
    const quality = options?.quality ?? (targetMime === 'image/jpeg' ? 0.85 : undefined);

    let s = 1.0;
    if (Math.max(origW, origH) > JEV_VISION_MAX_DIM) {
      s = JEV_VISION_MAX_DIM / Math.max(origW, origH);
    } else if (origW < JEV_VISION_MIN_DIM && origH < JEV_VISION_MIN_DIM) {
      const scaleUp = Math.max(JEV_VISION_MIN_DIM / origW, JEV_VISION_MIN_DIM / origH);
      s =
        Math.max(origW, origH) * scaleUp <= JEV_VISION_MAX_DIM
          ? scaleUp
          : JEV_VISION_MAX_DIM / Math.max(origW, origH);
    }

    let contentW = Math.max(1, Math.round(origW * s));
    let contentH = Math.max(1, Math.round(origH * s));

    if (contentW > JEV_VISION_MAX_DIM) contentW = JEV_VISION_MAX_DIM;
    if (contentH > JEV_VISION_MAX_DIM) contentH = JEV_VISION_MAX_DIM;

    const finalW = Math.max(JEV_VISION_MIN_DIM, contentW);
    const finalH = Math.max(JEV_VISION_MIN_DIM, contentH);
    const padX = Math.floor((finalW - contentW) / 2);
    const padY = Math.floor((finalH - contentH) / 2);

    const canvas = new OffscreenCanvas(finalW, finalH);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Unable to get canvas context for Jev vision preparation');
    }

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, finalW, finalH);
    ctx.drawImage(imageBitmap, 0, 0, origW, origH, padX, padY, contentW, contentH);

    const finalDataUrl = await canvasToDataURL(canvas, targetMime, quality);
    const byteLength = calculateDecodedBase64ByteLength(finalDataUrl);

    return {
      dataUrl: finalDataUrl,
      mimeType: targetMime,
      width: finalW,
      height: finalH,
      contentWidth: contentW,
      contentHeight: contentH,
      padX,
      padY,
      scaleRatio: s,
      byteLength,
    };
  } finally {
    if (imageBitmap && typeof imageBitmap.close === 'function') {
      imageBitmap.close();
    }
  }
}
