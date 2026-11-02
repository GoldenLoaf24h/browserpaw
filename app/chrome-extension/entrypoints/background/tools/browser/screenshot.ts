import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { projectFramePoint } from '@/utils/frame-coordinates';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, resolveToolName } from 'chrome-mcp-shared';
import { TOOL_MESSAGE_TYPES } from '@/common/message-types';
import {
  canvasToDataURL,
  createImageBitmapFromUrl,
  cropAndResizeImage,
  stitchImages,
  compressImage,
  overlayCoordinateGrid,
  smartCompressForTransport,
  prepareImageForJevVision,
} from '../../../../utils/image-utils';
import { screenshotContextManager } from '@/utils/screenshot-context';
import {
  assertScreenshotCaptureStable,
  createScreenshotCapture,
  readScreenshotPageState,
  SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
  type ScreenshotPageStateProbe,
} from '@/utils/screenshot-validity';
import { diffPerceptiveSignatures } from '@/utils/screenshot-guard';
import { executeInPage } from './in-page-engine';
import { screenshotRingBuffer } from '@/utils/screenshot-ring-buffer';
import { isRestrictedChromeUrl, logUnexpectedToolError } from '@/utils/restricted-url';
import { scrubUrl } from '@/utils/url-sanitizer';
import { snapshotCacheManager } from '@/utils/snapshot-cache-manager';

// Screenshot-specific constants
export const MAX_CANVAS_DIM = 16384;
export const MAX_CANVAS_AREA = 268435456;
export const DEFAULT_SCREENSHOT_MAX_DIMENSION = 1568;
export const DEFAULT_SCREENSHOT_MAX_PIXELS = 1_150_000;
const BACKGROUND_CAPTURE_WARMUP_TIMEOUT_MS = 1500;
const BACKGROUND_CAPTURE_RETRY_TIMEOUT_MS = 5000;

export function clampCanvasDimensions(
  width: number,
  height: number,
): { width: number; height: number } {
  const safeW = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 1;
  const safeH = typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : 1;
  let w = Math.max(1, Math.round(safeW));
  let h = Math.max(1, Math.round(safeH));
  if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM || w * h > MAX_CANVAS_AREA) {
    const dimScale = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h);
    const areaScale = Math.sqrt(MAX_CANVAS_AREA / (w * h));
    const scale = Math.min(dimScale, areaScale);
    w = Math.max(1, Math.floor(w * scale));
    h = Math.max(1, Math.floor(h * scale));
  }
  return { width: w, height: h };
}

export interface ScreenshotSizeBudget {
  maxWidth?: number;
  maxDimension?: number;
  maxPixels?: number;
  highClarity?: boolean;
}

/**
 * Fit screenshots to a vision-model budget while preserving aspect ratio.
 * The defaults track the conservative long-edge and total-pixel limits used by
 * current computer-use models; callers can request a larger or smaller budget.
 */
export function fitScreenshotToBudget(
  width: number,
  height: number,
  options: ScreenshotSizeBudget = {},
): { width: number; height: number; scale: number } {
  const sourceWidth = Number.isFinite(width) && width > 0 ? width : 1;
  const sourceHeight = Number.isFinite(height) && height > 0 ? height : 1;
  const positive = (value: number | undefined): number | undefined =>
    Number.isFinite(value) && (value as number) > 0 ? value : undefined;
  const maxWidth = positive(options.maxWidth);
  const maxDimension =
    positive(options.maxDimension) ??
    (options.highClarity === true ? undefined : DEFAULT_SCREENSHOT_MAX_DIMENSION);
  const maxPixels =
    positive(options.maxPixels) ??
    (options.highClarity === true ? undefined : DEFAULT_SCREENSHOT_MAX_PIXELS);

  let scale = 1;
  if (maxWidth !== undefined) scale = Math.min(scale, maxWidth / sourceWidth);
  if (maxDimension !== undefined) {
    scale = Math.min(scale, maxDimension / Math.max(sourceWidth, sourceHeight));
  }
  if (maxPixels !== undefined) {
    scale = Math.min(scale, Math.sqrt(maxPixels / (sourceWidth * sourceHeight)));
  }
  scale = Math.max(0.0001, Math.min(1, scale));

  // Floor rounding keeps every result at or below the requested pixel budget.
  const targetWidth = Math.max(1, Math.floor(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.floor(sourceHeight * scale));
  return {
    width: targetWidth,
    height: targetHeight,
    scale: Math.min(1, targetWidth / sourceWidth, targetHeight / sourceHeight),
  };
}

const SCREENSHOT_CONSTANTS = {
  SCROLL_DELAY_MS: 350, // Time to wait after scroll for rendering and lazy loading
  CAPTURE_STITCH_DELAY_MS: 50, // Small delay between captures in a scroll sequence
  MAX_CAPTURE_PARTS: 50, // Maximum number of parts to capture (for infinite scroll pages)
  MAX_CAPTURE_HEIGHT_PX: 50000, // Maximum height in pixels to capture
  PIXEL_TOLERANCE: 1,
  SCRIPT_INIT_DELAY: 100, // Delay for script initialization
} as {
  readonly SCROLL_DELAY_MS: number;
  CAPTURE_STITCH_DELAY_MS: number; // This one is mutable
  readonly MAX_CAPTURE_PARTS: number;
  readonly MAX_CAPTURE_HEIGHT_PX: number;
  readonly PIXEL_TOLERANCE: number;
  readonly SCRIPT_INIT_DELAY: number;
};

// Adjust CAPTURE_STITCH_DELAY_MS to respect Chrome's capture rate if available in runtime
// Some TS typings don't expose MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND; use a safe cast with a sane fallback.
const __MAX_CAP_RATE: number | undefined = (chrome.tabs as any)
  ?.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND;
if (typeof __MAX_CAP_RATE === 'number' && __MAX_CAP_RATE > 0) {
  // Minimum interval between consecutive captureVisibleTab calls (ms)
  const minIntervalMs = Math.ceil(1000 / __MAX_CAP_RATE);
  // Our capture loop already waits SCROLL_DELAY_MS between scroll and capture; add any extra delay needed
  const requiredExtraDelay = Math.max(0, minIntervalMs - SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS);
  SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS = Math.max(
    requiredExtraDelay,
    SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS,
  );
}

interface ScreenshotToolParams {
  name?: string;
  selector?: string;
  targetIndex?: number;
  index?: number; // Alias for targetIndex
  padding?: number;
  format?: 'png' | 'jpeg';
  quality?: number; // 0-100
  tabId?: number;
  background?: boolean;
  windowId?: number;
  width?: number;
  height?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  savePng?: boolean;
  saveToDisk?: boolean;
  maxHeight?: number; // Maximum height to capture in pixels (for infinite scroll pages)
  maxWidth?: number; // Maximum width to capture in pixels
  maxDimension?: number; // Maximum long edge in pixels for vision output
  maxPixels?: number; // Maximum total pixels for vision output
  zoom?: number; // Super-sampling / zoom factor for element crop
  grid?: boolean | string; // Overlay coordinate reference grid ('ruler' | 'crosshair' | 'classic' | '1000' | true)
  enableGrid?: boolean | string; // Alias for grid
  expandSearchArea?: boolean; // Adaptively expand crop box for small elements (<100x100)
  autoExpand?: boolean;
  som?: boolean; // Overlay Set-of-Mark numbered badges on interactive elements before capture
  highlight?: boolean; // Alias for som
  setOfMark?: boolean; // Alias for som
  /** Internal flag for TypeSafe Jev Vision preparation and frame-binding */
  _jevVision?: boolean;
  /** View a single visual asset listed by chrome_read_dom (1-based asset index). Bytes first, viewport-crop fallback */
  assetIndex?: number;
  /** Sub-region ROI crop (lossless zoom into specified bounding box [ymin, xmin, ymax, xmax] or { x0, y0, x1, y1 }) */
  region?:
    | {
        x0?: number;
        y0?: number;
        x1?: number;
        y1?: number;
        xmin?: number;
        ymin?: number;
        xmax?: number;
        ymax?: number;
      }
    | [number, number, number, number]
    | any;
  crop?:
    | {
        x0?: number;
        y0?: number;
        x1?: number;
        y1?: number;
        xmin?: number;
        ymin?: number;
        xmax?: number;
        ymax?: number;
      }
    | [number, number, number, number]
    | any;
  highClarity?: boolean; // Prioritize 100% full-resolution clarity without downsampling
  allowDimensionScaling?: boolean; // Allow downscaling image dimensions for transport budget
  sessionId?: string;
  sessionContext?: string;
}

/** Page details returned by screenshot-helper content script */
interface ScreenshotPageDetails {
  totalWidth: number;
  totalHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  devicePixelRatio: number;
  currentScrollX: number;
  currentScrollY: number;
}

const PAGE_DETAILS_REQUIRED_FIELDS: Array<keyof ScreenshotPageDetails> = [
  'totalWidth',
  'totalHeight',
  'viewportWidth',
  'viewportHeight',
  'devicePixelRatio',
  'currentScrollX',
  'currentScrollY',
];

/**
 * Validates and asserts that the response from content script contains valid page details
 */
function assertValidPageDetails(details: unknown): ScreenshotPageDetails {
  if (!details || typeof details !== 'object') {
    throw new Error(
      'Screenshot helper did not respond. The content script may not be injected or cannot run on this page.',
    );
  }

  const candidate = details as Partial<ScreenshotPageDetails>;
  const invalidFields = PAGE_DETAILS_REQUIRED_FIELDS.filter(
    (field) => typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]),
  );

  if (invalidFields.length > 0) {
    throw new Error(
      `Screenshot helper returned invalid page details (missing/invalid: ${invalidFields.join(', ')}).`,
    );
  }

  return candidate as ScreenshotPageDetails;
}

/**
 * Normalizes an image data URL to exact CSS dimensions by scaling onto an OffscreenCanvas.
 * Eliminates physical coordinate drift across arbitrary display scaling (125%, 150%, 200%).
 */
export async function normalizeImageToCssDimensions(
  dataUrl: string,
  targetWidthCss: number,
  targetHeightCss: number,
  mimeType: string = 'image/jpeg',
  quality: number = 0.85,
): Promise<string> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return dataUrl;
  }
  try {
    const img = await createImageBitmapFromUrl(dataUrl);
    if (
      img.width === targetWidthCss &&
      img.height === targetHeightCss &&
      dataUrl.startsWith(`data:${mimeType}`)
    ) {
      return dataUrl;
    }
    const { width: boundedW, height: boundedH } = clampCanvasDimensions(
      targetWidthCss,
      targetHeightCss,
    );
    const canvas = new OffscreenCanvas(boundedW, boundedH);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');
    ctx.drawImage(img, 0, 0, boundedW, boundedH);
    return await canvasToDataURL(canvas, mimeType, quality);
  } catch {
    return dataUrl;
  }
}

/**
 * Detect window-transition black bars (right/bottom edges fully near-black).
 * Samples 1px lines at the right and bottom edges; >92% black on EITHER edge
 * after activation means the compositor had not presented the real frame.
 */
async function hasBlackBars(dataUrl: string): Promise<boolean> {
  let img: ImageBitmap | undefined;
  try {
    img = await createImageBitmapFromUrl(dataUrl);
    if (img.width < 64 || img.height < 64) return false;
    const samples = 48;
    const canvas = new OffscreenCanvas(samples, samples);
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, samples, samples);
    const data = ctx.getImageData(0, 0, samples, samples).data;
    if (data.length < samples * samples * 4) return false;
    const isBlack = (x: number, y: number): boolean => {
      const offset = (y * samples + x) * 4;
      return data[offset] + data[offset + 1] + data[offset + 2] < 18;
    };
    let right = 0;
    let bottom = 0;
    for (let i = 0; i < samples; i++) {
      if (isBlack(samples - 1, i)) right++;
      if (isBlack(i, samples - 1)) bottom++;
    }
    return right / samples > 0.92 || bottom / samples > 0.92;
  } catch {
    return false;
  } finally {
    if (typeof (img as any)?.close === 'function') (img as any).close();
  }
}

// Do not register global chrome.downloads.onDeterminingFilename listener to prevent conflicts with download managers (e.g. IDM)

/**
 * Saves screenshot base64 data to the system temporary directory via Native Messaging Host.
 * Strictly avoids polluting the user's personal Downloads folder.
 */
async function saveScreenshotToNativeTemp(
  base64Data: string,
  filename: string,
): Promise<{ filename?: string; fullPath?: string } | undefined> {
  try {
    const { sendFileOperationToNative, cancelFileOperation, ensureNativeConnected } =
      await import('../../native-host');
    if (typeof ensureNativeConnected === 'function') {
      await ensureNativeConnected('save_screenshot').catch(() => false);
    }
    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, '');

    const requestId = `screenshot-temp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    // Full-page PNGs can be tens of megabytes; Native messaging is chunked.
    const timeoutMs = 60000;
    const resp = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        cancelFileOperation(requestId);
        reject(new Error('Native temp save timed out'));
      }, timeoutMs);

      const ok = sendFileOperationToNative(
        {
          type: 'file_operation',
          requestId,
          payload: {
            action: 'prepareFile',
            base64Data: cleanBase64,
            fileName: filename,
          },
        },
        (message: any) => {
          clearTimeout(timer);
          resolve(message?.payload);
        },
      );

      if (!ok) {
        clearTimeout(timer);
        reject(new Error('Native host not connected'));
      }
    });

    if (resp && resp.success && resp.filePath) {
      return { filename, fullPath: resp.filePath };
    }
  } catch (err) {
    console.warn('saveScreenshotToNativeTemp failed, falling back:', err);
  }
  return undefined;
}

async function convertImageToPng(
  dataUrl: string,
  targetWidth?: number,
  targetHeight?: number,
): Promise<string | undefined> {
  const sourceMime = dataUrl.match(/^data:(image\/[^;]+);base64,/)?.[1];
  // Preserve captured PNG bytes exactly instead of needlessly re-encoding them.
  if (sourceMime === 'image/png') {
    return dataUrl;
  }
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    return sourceMime === 'image/png' ? dataUrl : undefined;
  }
  try {
    const bitmap = await createImageBitmapFromUrl(dataUrl);
    try {
      const width = targetWidth ?? bitmap.width;
      const height = targetHeight ?? bitmap.height;
      const bounded = clampCanvasDimensions(width, height);
      const canvas = new OffscreenCanvas(bounded.width, bounded.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(bitmap, 0, 0, bounded.width, bounded.height);
      return await canvasToDataURL(canvas, 'image/png');
    } finally {
      if (typeof (bitmap as any).close === 'function') (bitmap as any).close();
    }
  } catch {
    return sourceMime === 'image/png' ? dataUrl : undefined;
  }
}

/**
 * Tool for capturing screenshots of web pages
 */
class ScreenshotTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.SCREENSHOT;

  /**
   * Execute screenshot operation
   */
  async execute(rawArgs: ScreenshotToolParams): Promise<ToolResult> {
    const targetIndex =
      typeof rawArgs.targetIndex === 'number'
        ? rawArgs.targetIndex
        : typeof (rawArgs as any).index === 'number'
          ? (rawArgs as any).index
          : undefined;
    const grid = rawArgs.grid ?? (rawArgs as any).enableGrid;
    const som =
      rawArgs.som === true ||
      (rawArgs as any).highlight === true ||
      (rawArgs as any).setOfMark === true;
    const isJevVision = rawArgs._jevVision === true;

    const args: ScreenshotToolParams = {
      ...rawArgs,
      targetIndex,
      grid,
      som,
      ...(isJevVision
        ? {
            fullPage: false,
            saveToDisk: false,
            savePng: false,
            format: rawArgs.format === 'png' ? 'png' : 'jpeg',
          }
        : {}),
    };

    const {
      name = 'screenshot',
      selector,
      storeBase64 = false,
      fullPage = false,
      savePng = false,
      saveToDisk = false,
    } = args;
    // Legacy clients may still send "webp"; screenshots now only emit PNG/JPEG.
    const format: 'png' | 'jpeg' = args.format === 'png' ? 'png' : 'jpeg';
    args.format = format;
    const saveRequested =
      !isJevVision &&
      (savePng === true || saveToDisk === true || (args as any).saveToDisk === true) &&
      args.savePng !== false &&
      (args as any).saveToDisk !== false;

    console.log(`Starting screenshot with options:`, args);

    // Resolve target tab with Session Tab Affinity support
    const tab = await this.resolveAffinityTab({
      tabId: args.tabId,
      windowId: args.windowId,
      sessionId: args.sessionId || args.sessionContext,
    });

    // Check URL restrictions (shared with every content-script tool)
    if (isRestrictedChromeUrl(tab.url)) {
      return createErrorResponse(
        'Cannot capture special browser pages or web store pages due to security restrictions.',
      );
    }

    let finalImageDataUrl: string | undefined;
    let fullResolutionPngDataUrl: string | undefined;
    let finalImageWidthCss: number | undefined;
    let finalImageHeightCss: number | undefined;
    let jevVisionFrame: { id: string; width: number; height: number } | undefined = undefined;
    const results: any = { base64: null, fileSaved: false };
    let originalScroll: { x: number; y: number } | null = null;
    let didPreparePage = false;
    let didInjectSoM = false;
    let pageDetails: ScreenshotPageDetails | undefined;
    let captureViewport: { viewportWidth: number; viewportHeight: number } | undefined;
    let capturedDocWidth: number | undefined;
    let capturedDocHeight: number | undefined;
    let captureState: ScreenshotPageStateProbe | undefined;
    let captureDomRevision: number | undefined;
    let coordinateValidationSupported = false;
    let coordinateValidationUnsupportedReason: string | undefined;
    let pageStateProbeAvailable = true;
    let viewportScale = 1;
    let captureMetadata:
      | {
          captureId: string;
          capturedAt: number;
          documentId: string;
          viewport: {
            width: number;
            height: number;
            dpr: number;
            scrollX: number;
            scrollY: number;
          };
          coordinateValidation:
            { supported: true; boundary: string } | { supported: false; reason: string };
        }
      | undefined;

    let elementCropOrigin: { x: number; y: number } | undefined;
    let elementOriginalCrop: { width: number; height: number } | undefined;
    const qualityFraction =
      typeof args.quality === 'number' ? Math.max(0, Math.min(1, args.quality / 100)) : 0.85;

    try {
      let preUrl: string = '';
      let preSig: any = null;

      let preCaptureState: ScreenshotPageStateProbe | undefined;
      try {
        preCaptureState = await readScreenshotPageState(tab.id!);
        preUrl = preCaptureState.documentURL || tab.url || '';
      } catch {
        pageStateProbeAvailable = false;
        if (isJevVision) {
          const fallback = await executeInPage(
            { tabId: tab.id! },
            'inPageGetScrollState',
            [],
          ).catch(() => null);
          const state = fallback?.[0]?.result;
          const documentId = fallback?.[0]?.documentId || state?.documentId;
          if (state && documentId) {
            preCaptureState = {
              documentId,
              documentURL: state.documentURL,
              width: state.viewportWidth,
              height: state.viewportHeight,
              dpr: 1,
              scrollX: state.scrollX,
              scrollY: state.scrollY,
              domRevision: -1,
              observerInitializedNow: true,
            };
          }
        }
        preUrl = preCaptureState?.documentURL || tab.url || '';
      }

      if (isJevVision) {
        if (!preCaptureState) {
          throw new Error('Failed to capture initial page probes for TypeSafe Jev vision frame');
        }
        const preSigRes = await executeInPage(
          { tabId: tab.id! },
          'inPageDetectPerceptiveSignature',
          [],
        ).catch(() => null);
        preSig = preSigRes?.[0]?.result;
        const preSigDocId = preSigRes?.[0]?.documentId;
        preUrl = preSig?.url || preCaptureState.documentURL || tab.url || '';

        if (!preSig || !preUrl) {
          throw new Error('Failed to capture initial page probes for TypeSafe Jev vision frame');
        }
        if (preSigDocId && preSigDocId !== preCaptureState.documentId) {
          throw new Error(
            `Document changed during screenshot probes: pre="${preCaptureState.documentId}" signature="${preSigDocId}"`,
          );
        }
      }

      const enableSoM = args.som === true || args.highlight === true || args.setOfMark === true;
      const unsupportedCaptureReason = fullPage
        ? 'Coordinate validation is unavailable for full-page screenshots'
        : selector || typeof args.targetIndex === 'number'
          ? 'Coordinate validation is unavailable for element screenshots'
          : typeof args.assetIndex === 'number'
            ? 'Coordinate validation is unavailable for asset screenshots'
            : args.region || args.crop
              ? 'Coordinate validation is unavailable for cropped screenshots'
              : enableSoM
                ? 'Coordinate validation is unavailable when Set-of-Mark overlays are enabled'
                : undefined;
      coordinateValidationSupported = !unsupportedCaptureReason && pageStateProbeAvailable;
      coordinateValidationUnsupportedReason =
        unsupportedCaptureReason ||
        (!pageStateProbeAvailable
          ? 'DOM mutation revision is unavailable for this page'
          : undefined);
      const preDomRevision = pageStateProbeAvailable ? preCaptureState?.domRevision : undefined;
      if (coordinateValidationSupported) {
        if (preDomRevision === undefined) {
          coordinateValidationSupported = false;
          coordinateValidationUnsupportedReason =
            'DOM mutation revision is unavailable for this page';
        }
      }
      if (enableSoM) {
        try {
          const somResults = await executeInPage(
            { tabId: tab.id!, allFrames: true },
            'inPageDOMPruner',
            [{ highlight: true }],
          );
          didInjectSoM = true;
        } catch (somErr) {
          console.warn('Failed to render Set-of-Mark badges for screenshot:', somErr);
        }
      }

      const background = args.background === true;
      const targetMimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

      // === Path 0: named asset (from chrome_read_dom assets[]) ===
      // Primary: fetch real bytes in page (canvas toDataURL / img+bg fetch).
      // Fallback: crop the viewport capture by the asset rect.
      let assetHandled = false;
      if (typeof args.assetIndex === 'number') {
        const cachedSnap = tab.id ? snapshotCacheManager.getSnapshot(tab.id) : undefined;
        const route = cachedSnap?.valid ? cachedSnap.assetRoutes?.get(args.assetIndex) : undefined;
        if (!route) {
          return createErrorResponse(
            `Asset ${args.assetIndex} route not found in snapshot cache. Run ${resolveToolName('read_dom')} to refresh assets.`,
          );
        }
        const assetResults = await executeInPage(
          { tabId: tab.id!, frameIds: [route.frameId] },
          'inPageGetAssetImage',
          [route.localIndex + 1],
        );
        const asset = assetResults?.find((r) => r.frameId === route.frameId)?.result;
        if (!asset?.rect) {
          return createErrorResponse(
            asset?.reason ||
              `Asset ${args.assetIndex} not found. Run ${resolveToolName('read_dom')} to list assets.`,
          );
        }
        if (asset.dataUrl && asset.dataUrl.startsWith('data:')) {
          const img = await createImageBitmapFromUrl(asset.dataUrl);
          finalImageWidthCss = img.width;
          finalImageHeightCss = img.height;
          if (saveRequested) {
            fullResolutionPngDataUrl = await convertImageToPng(
              asset.dataUrl,
              img.width,
              img.height,
            );
          }
          finalImageDataUrl = await normalizeImageToCssDimensions(
            asset.dataUrl,
            img.width,
            img.height,
            targetMimeType,
            qualityFraction,
          );
          if (typeof (img as any).close === 'function') (img as any).close();
          assetHandled = true;
          results.assetKind = asset.kind;
          results.assetSrc = scrubUrl(asset.src || '');
          results.assetSource = 'bytes';
        } else {
          // Match the bitmap's actual scale; capture providers can differ at the same DPR.
          const viewport = (
            await executeInPage({ tabId: tab.id! }, 'inPageGetScrollState', [])
          )?.[0]?.result;
          if (
            !viewport ||
            !Number.isFinite(viewport.viewportWidth) ||
            viewport.viewportWidth <= 0 ||
            !Number.isFinite(viewport.viewportHeight) ||
            viewport.viewportHeight <= 0
          ) {
            throw new Error('Invalid viewport dimensions for asset fallback');
          }
          captureViewport = viewport;
          originalScroll = { x: viewport.scrollX, y: viewport.scrollY };
          const pad = Math.max(0, args.padding ?? 0);
          const assetRect = asset.rect as { x: number; y: number; width: number; height: number };
          const corners = [
            { x: assetRect.x, y: assetRect.y },
            { x: assetRect.x + assetRect.width, y: assetRect.y },
            { x: assetRect.x, y: assetRect.y + assetRect.height },
            { x: assetRect.x + assetRect.width, y: assetRect.y + assetRect.height },
          ];
          const projected = await Promise.all(
            corners.map((point) => projectFramePoint(tab.id!, route.frameId, point)),
          );
          const assetX = Math.round(Math.min(...projected.map((point) => point.x)));
          const assetY = Math.round(Math.min(...projected.map((point) => point.y)));
          const assetRight = Math.max(...projected.map((point) => point.x));
          const assetBottom = Math.max(...projected.map((point) => point.y));
          const crop = {
            x: Math.max(0, assetX - pad),
            y: Math.max(0, assetY - pad),
            w: 0,
            h: 0,
          };
          crop.w = Math.min(viewport.viewportWidth, assetRight + pad) - crop.x;
          crop.h = Math.min(viewport.viewportHeight, assetBottom + pad) - crop.y;
          if (crop.w <= 0 || crop.h <= 0) throw new Error('Asset crop is outside viewport');
          const visibleDataUrl = await this.captureTabPng(tab);
          if (!visibleDataUrl)
            throw new Error('captureTabPng returned empty image (asset fallback)');
          const raw = await createImageBitmapFromUrl(visibleDataUrl);
          const scaleX = raw.width / viewport.viewportWidth;
          const scaleY = raw.height / viewport.viewportHeight;
          const { width: cropW, height: cropH } = clampCanvasDimensions(crop.w, crop.h);
          const cropped = new OffscreenCanvas(cropW, cropH);
          const cctx = cropped.getContext('2d');
          if (!cctx) throw new Error('OffscreenCanvas 2d context failed (asset fallback)');
          cctx.drawImage(
            raw,
            crop.x * scaleX,
            crop.y * scaleY,
            crop.w * scaleX,
            crop.h * scaleY,
            0,
            0,
            cropW,
            cropH,
          );
          finalImageDataUrl = await canvasToDataURL(
            cropped,
            targetMimeType as any,
            qualityFraction,
          );
          if (saveRequested) {
            const fullCrop = clampCanvasDimensions(
              Math.round(crop.w * scaleX),
              Math.round(crop.h * scaleY),
            );
            const fullCanvas = new OffscreenCanvas(fullCrop.width, fullCrop.height);
            const fullCtx = fullCanvas.getContext('2d');
            if (fullCtx) {
              fullCtx.drawImage(
                raw,
                crop.x * scaleX,
                crop.y * scaleY,
                crop.w * scaleX,
                crop.h * scaleY,
                0,
                0,
                fullCrop.width,
                fullCrop.height,
              );
              fullResolutionPngDataUrl = await canvasToDataURL(fullCanvas, 'image/png');
            }
          }
          if (typeof (raw as any).close === 'function') (raw as any).close();
          finalImageWidthCss = cropW;
          finalImageHeightCss = cropH;
          elementCropOrigin = {
            x: crop.x,
            y: crop.y,
          };
          elementOriginalCrop = {
            width: crop.w,
            height: crop.h,
          };
          assetHandled = true;
          results.assetKind = asset.kind;
          results.assetSrc = scrubUrl(asset.src || '');
          results.assetSource = 'viewport-crop';
          results.assetFallbackReason = asset.reason;
        }
      }

      // === Path -1: Sub-region ROI crop (lossless zoom / crop) ===
      const roiInput = args.region || (args as any).crop;
      if (!assetHandled && roiInput) {
        try {
          const tabId = tab.id!;
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          await cdpSessionManager.withSession(tabId, 'screenshot-roi', async () => {
            const metrics: any = await cdpSessionManager.sendCommand(
              tabId,
              'Page.getLayoutMetrics',
              {},
            );
            const viewport = metrics?.cssVisualViewport ||
              metrics?.cssLayoutViewport ||
              metrics?.layoutViewport ||
              metrics?.visualViewport || {
                clientWidth: 1280,
                clientHeight: 800,
                pageX: 0,
                pageY: 0,
              };
            const vw = Math.round(viewport.clientWidth || 1280);
            const vh = Math.round(viewport.clientHeight || 800);
            const pageX = Number(viewport.pageX || 0);
            const pageY = Number(viewport.pageY || 0);

            let rx0 = 0,
              ry0 = 0,
              rx1 = vw,
              ry1 = vh;
            if (Array.isArray(roiInput) && roiInput.length === 4) {
              const [a, b, c, d] = roiInput.map(Number);
              let isYminFirst = true;
              if ((a > vh || c > vh) && a <= vw && c <= vw) isYminFirst = false;
              else if ((b > vh || d > vh) && b <= vw && d <= vw) isYminFirst = true;
              const ymin = isYminFirst ? Math.min(a, c) : Math.min(b, d);
              const ymax = isYminFirst ? Math.max(a, c) : Math.max(b, d);
              const xmin = isYminFirst ? Math.min(b, d) : Math.min(a, c);
              const xmax = isYminFirst ? Math.max(b, d) : Math.max(a, c);
              const maxVal = Math.max(a, b, c, d);
              if (maxVal <= 1.0 && maxVal > 0) {
                rx0 = Math.round(xmin * vw);
                rx1 = Math.round(xmax * vw);
                ry0 = Math.round(ymin * vh);
                ry1 = Math.round(ymax * vh);
              } else if (maxVal <= 1000 && (ymax > vh || xmax > vw)) {
                rx0 = Math.round((xmin / 1000) * vw);
                rx1 = Math.round((xmax / 1000) * vw);
                ry0 = Math.round((ymin / 1000) * vh);
                ry1 = Math.round((ymax / 1000) * vh);
              } else {
                rx0 = Math.round(xmin);
                rx1 = Math.round(xmax);
                ry0 = Math.round(ymin);
                ry1 = Math.round(ymax);
              }
            } else if (typeof roiInput === 'object' && roiInput !== null) {
              const rawX0 = roiInput.x0 ?? roiInput.xmin ?? roiInput.left ?? 0;
              const rawY0 = roiInput.y0 ?? roiInput.ymin ?? roiInput.top ?? 0;
              const rawX1 =
                roiInput.x1 ??
                roiInput.xmax ??
                (typeof roiInput.width === 'number' ? rawX0 + roiInput.width : vw);
              const rawY1 =
                roiInput.y1 ??
                roiInput.ymax ??
                (typeof roiInput.height === 'number' ? rawY0 + roiInput.height : vh);
              rx0 = Math.round(Number(rawX0));
              rx1 = Math.round(Number(rawX1));
              ry0 = Math.round(Number(rawY0));
              ry1 = Math.round(Number(rawY1));
            }
            rx0 = Math.max(0, Math.min(vw - 1, rx0));
            ry0 = Math.max(0, Math.min(vh - 1, ry0));
            rx1 = Math.max(rx0 + 1, Math.min(vw, rx1));
            ry1 = Math.max(ry0 + 1, Math.min(vh, ry1));
            const w = rx1 - rx0;
            const h = ry1 - ry0;

            const cdpFormat = saveRequested || format === 'png' ? 'png' : 'jpeg';
            const cdpQuality =
              cdpFormat === 'jpeg' && typeof args.quality === 'number'
                ? Math.max(0, Math.min(100, Math.round(args.quality)))
                : 85;

            const shot: any = await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
              format: cdpFormat,
              quality: cdpQuality,
              captureBeyondViewport: false,
              fromSurface: true,
              clip: {
                x: pageX + rx0,
                y: pageY + ry0,
                width: w,
                height: h,
                scale: 1,
              },
            });
            if (shot?.data) {
              const rawDataUrl = `data:${shot.mimeType || targetMimeType};base64,${shot.data}`;
              if (saveRequested) {
                fullResolutionPngDataUrl = await convertImageToPng(rawDataUrl);
              }
              finalImageDataUrl = await normalizeImageToCssDimensions(
                rawDataUrl,
                w,
                h,
                targetMimeType,
                qualityFraction,
              );
              finalImageWidthCss = w;
              finalImageHeightCss = h;
              elementCropOrigin = { x: rx0, y: ry0 };
              elementOriginalCrop = { width: w, height: h };
              assetHandled = true;
              results.roi = { x0: rx0, y0: ry0, x1: rx1, y1: ry1, width: w, height: h };
            }
          });
        } catch (roiErr) {
          console.warn('ROI crop capture failed, falling through:', roiErr);
        }
      }

      // CDP path: simple viewport capture (no fullPage, no selector, no targetIndex, no som)
      const canUseCdpCapture =
        !assetHandled &&
        !fullPage &&
        !selector &&
        typeof args.targetIndex !== 'number' &&
        !enableSoM;

      // === Path 1: CDP viewport capture (no content script needed) ===
      if (canUseCdpCapture) {
        try {
          const tabId = tab.id!;
          const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
          await cdpSessionManager.withSession(tabId, 'screenshot', async () => {
            // Wait two compositor frames so a just-activated/just-navigated
            // tab has presented its real content; otherwise captureScreenshot
            // races the window-transition frame and returns black bars.
            try {
              if (tab.active) {
                const frames = cdpSessionManager
                  .sendCommand(tabId, 'Runtime.evaluate', {
                    expression:
                      'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))',
                    awaitPromise: true,
                  })
                  .catch(() => {});
                await Promise.race([frames, new Promise((r) => setTimeout(r, 300))]);
              } else {
                await new Promise((r) => setTimeout(r, 50));
              }
            } catch (rafErr) {
              console.warn('rAF settle wait failed (capturing anyway):', rafErr);
            }
            const metrics: any = await cdpSessionManager.sendCommand(
              tabId,
              'Page.getLayoutMetrics',
              {},
            );
            const viewport = metrics?.cssVisualViewport ||
              metrics?.cssLayoutViewport ||
              metrics?.layoutViewport ||
              metrics?.visualViewport || {
                clientWidth: 800,
                clientHeight: 600,
                pageX: 0,
                pageY: 0,
              };
            const cdpFormat = saveRequested || format === 'png' ? 'png' : 'jpeg';
            const cdpQuality =
              cdpFormat === 'jpeg' && typeof args.quality === 'number'
                ? Math.max(0, Math.min(100, Math.round(args.quality)))
                : cdpFormat === 'jpeg'
                  ? 80
                  : undefined;

            const clientWidth = Math.round(viewport.clientWidth || 800);
            const clientHeight = Math.round(viewport.clientHeight || 600);
            originalScroll = { x: viewport.pageX || 0, y: viewport.pageY || 0 };
            const previewSize = fitScreenshotToBudget(clientWidth, clientHeight, {
              maxWidth: args.maxWidth,
              maxDimension: args.maxDimension,
              maxPixels: args.maxPixels,
              highClarity: args.highClarity === true,
            });

            const captureParams = {
              format: cdpFormat,
              quality: cdpQuality,
              captureBeyondViewport: false,
              fromSurface: true,
              clip: {
                x: viewport.pageX || 0,
                y: viewport.pageY || 0,
                width: clientWidth,
                height: clientHeight,
                scale: 1,
              },
            };
            // A clipped compositor capture can stall; Jev must reach the existing fallback promptly.
            let shot: any;
            if (isJevVision) {
              shot = await cdpSessionManager.sendDebuggerCommand(
                tabId,
                'Page.captureScreenshot',
                captureParams,
                1500,
              );
            } else if (tab.active === false) {
              try {
                shot = await cdpSessionManager.sendDebuggerCommand(
                  tabId,
                  'Page.captureScreenshot',
                  captureParams,
                  BACKGROUND_CAPTURE_WARMUP_TIMEOUT_MS,
                );
              } catch (warmupError) {
                const message =
                  warmupError instanceof Error ? warmupError.message : String(warmupError);
                if (!message.includes('CDP_SEND_TIMEOUT')) throw warmupError;
                results.cdpCaptureWarmupRetry = true;
                shot = await cdpSessionManager.sendDebuggerCommand(
                  tabId,
                  'Page.captureScreenshot',
                  captureParams,
                  BACKGROUND_CAPTURE_RETRY_TIMEOUT_MS,
                );
              }
            } else {
              shot = await cdpSessionManager.sendCommand(
                tabId,
                'Page.captureScreenshot',
                captureParams,
              );
            }
            const base64Data = typeof shot?.data === 'string' ? shot.data : '';
            if (!base64Data) {
              throw new Error('CDP Page.captureScreenshot returned empty data');
            }
            const rawDataUrl = `data:${shot.mimeType || targetMimeType};base64,${base64Data}`;
            if (saveRequested) {
              fullResolutionPngDataUrl = await convertImageToPng(rawDataUrl);
            }
            // Decode once into the final vision budget instead of CSS size and then scaling again.
            finalImageDataUrl = await normalizeImageToCssDimensions(
              rawDataUrl,
              previewSize.width,
              previewSize.height,
              targetMimeType,
              qualityFraction,
            );
            finalImageWidthCss = previewSize.width;
            finalImageHeightCss = previewSize.height;
            viewportScale = previewSize.scale;
            captureViewport = { viewportWidth: clientWidth, viewportHeight: clientHeight };
            if (await hasBlackBars(finalImageDataUrl)) {
              // Window-transition frame: wait two more presented frames and
              // retry exactly once before accepting the capture.
              await new Promise((r) => setTimeout(r, 250));
              try {
                // Background/minimized tabs can suspend animation frames indefinitely.
                if (tab.active) {
                  const frames = cdpSessionManager
                    .sendCommand(tabId, 'Runtime.evaluate', {
                      expression:
                        'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())))',
                      awaitPromise: true,
                    })
                    .catch(() => {});
                  await Promise.race([frames, new Promise((r) => setTimeout(r, 300))]);
                }
              } catch {}
              const retryCapture = cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
                format: cdpFormat,
                quality: cdpQuality,
                captureBeyondViewport: false,
                fromSurface: true,
                clip: {
                  x: viewport.pageX || 0,
                  y: viewport.pageY || 0,
                  width: clientWidth,
                  height: clientHeight,
                  scale: 1,
                },
              });
              // Keep the first capture if an optional compositor retry stops acknowledging.
              let retryTimer: ReturnType<typeof setTimeout> | undefined;
              let retry: any;
              try {
                retry = await Promise.race([
                  retryCapture,
                  new Promise<null>((resolve) => {
                    retryTimer = setTimeout(() => resolve(null), 1000);
                  }),
                ]);
              } finally {
                clearTimeout(retryTimer);
              }
              if (!retry)
                results.cdpCaptureWarning =
                  'Black-bar recapture exceeded 1000ms; using initial frame';
              const retryData = typeof retry?.data === 'string' ? retry.data : '';
              if (retryData) {
                finalImageDataUrl = await normalizeImageToCssDimensions(
                  `data:${retry.mimeType || targetMimeType};base64,${retryData}`,
                  previewSize.width,
                  previewSize.height,
                  targetMimeType,
                  qualityFraction,
                );
              }
            }
          });
        } catch (e) {
          results.cdpCaptureWarning = e instanceof Error ? e.message : String(e);
          console.warn('CDP viewport capture failed, falling back to helper path:', e);
        }
      }

      // === Path 2: Helper-assisted capture (requires content script) ===
      if (!assetHandled && !finalImageDataUrl) {
        // Always inject helper when we need pageDetails
        await this.injectScreenshotHelper(tab.id!);
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

        // Hiding scrollbars changes the layout that viewport coordinates must describe.
        const skipPrepareForViewport =
          !fullPage && !selector && typeof args.targetIndex !== 'number';

        // Prepare page (hide scrollbars, handle fixed elements)
        // Helper messages can die with a stale listener after extension
        // reloads or renderer swaps. One re-inject + retry recovers them;
        // a second failure surfaces as the original error.
        if (!skipPrepareForViewport) {
          didPreparePage = true;
          const prepareResp = await this.sendToHelperWithRetry(tab.id!, {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE,
            options: { fullPage },
          });
          if (!prepareResp || prepareResp.success !== true) {
            throw new Error(
              'Screenshot helper did not acknowledge page preparation. The content script may not be injected or cannot run on this page.',
            );
          }
        }

        // Get page details with validation
        const rawPageDetails = await this.sendToHelperWithRetry(tab.id!, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_PAGE_DETAILS,
        });
        pageDetails = assertValidPageDetails(rawPageDetails);
        originalScroll = { x: pageDetails.currentScrollX, y: pageDetails.currentScrollY };

        if (fullPage) {
          this.logInfo('Capturing full page...');
          const fullCapture = await this._captureFullPage(tab.id!, args, pageDetails, tab.windowId);
          finalImageDataUrl = fullCapture.dataUrl;
          finalImageWidthCss = fullCapture.widthCss;
          finalImageHeightCss = fullCapture.heightCss;
          capturedDocWidth = fullCapture.originalCaptureWidth;
          capturedDocHeight = fullCapture.originalCaptureHeight;
          fullResolutionPngDataUrl = fullCapture.fullResolutionDataUrl;
        } else if (selector || typeof args.targetIndex === 'number') {
          this.logInfo(`Capturing element (selector=${selector}, targetIndex=${args.targetIndex})`);
          const elementCapture = await this._captureElement(
            tab.id!,
            args,
            pageDetails.devicePixelRatio,
            tab.windowId,
          );
          finalImageDataUrl = elementCapture.dataUrl;
          finalImageWidthCss = elementCapture.widthCss;
          finalImageHeightCss = elementCapture.heightCss;
          elementCropOrigin = { x: elementCapture.originX, y: elementCapture.originY };
          elementOriginalCrop = {
            width: (elementCapture as any).originalCropWidth,
            height: (elementCapture as any).originalCropHeight,
          };
          fullResolutionPngDataUrl = elementCapture.fullResolutionDataUrl;
        } else {
          // Visible area only
          this.logInfo('Capturing visible area...');
          const rawVisibleDataUrl = await this.captureTabPngWithRetry(tab);
          if (!rawVisibleDataUrl) throw new Error('captureVisibleTab returned empty image');
          if (saveRequested) {
            fullResolutionPngDataUrl = await convertImageToPng(rawVisibleDataUrl);
          }
          // Enforce DPR 1:1 Normalization: resample from physical pixels to exact CSS viewport dimensions
          finalImageDataUrl = await normalizeImageToCssDimensions(
            rawVisibleDataUrl,
            pageDetails.viewportWidth,
            pageDetails.viewportHeight,
            targetMimeType,
            qualityFraction,
          );
          finalImageWidthCss = pageDetails.viewportWidth;
          finalImageHeightCss = pageDetails.viewportHeight;
        }
      }

      if (!finalImageDataUrl) {
        throw new Error('Failed to capture image data');
      }

      // Fit the model-facing preview to an aspect-ratio-preserving vision budget.
      if (finalImageWidthCss && finalImageHeightCss && finalImageDataUrl) {
        const fitted = fitScreenshotToBudget(finalImageWidthCss, finalImageHeightCss, {
          maxWidth: args.maxWidth,
          maxDimension: args.maxDimension,
          maxPixels: args.maxPixels,
          highClarity: args.highClarity === true,
        });
        if (fitted.width !== finalImageWidthCss || fitted.height !== finalImageHeightCss) {
          const targetW = fitted.width;
          const targetH = fitted.height;
          try {
            const scaledUrl = await normalizeImageToCssDimensions(
              finalImageDataUrl,
              targetW,
              targetH,
              targetMimeType,
              qualityFraction,
            );
            if (scaledUrl && scaledUrl !== finalImageDataUrl) {
              finalImageDataUrl = scaledUrl;
              viewportScale = fitted.scale;
              finalImageWidthCss = targetW;
              finalImageHeightCss = targetH;
            }
          } catch (maxWErr) {
            console.warn('Failed to fit screenshot to vision budget:', maxWErr);
          }
        }
      }

      // 1.5. Coordinate reference grid overlay
      if ((args.grid === true || typeof args.grid === 'string') && finalImageDataUrl) {
        try {
          const gridStyle = typeof args.grid === 'string' ? (args.grid as any) : 'ruler';
          // Output canvas is 1:1 normalized to CSS pixels, so effective DPR is 1
          finalImageDataUrl = await overlayCoordinateGrid(
            finalImageDataUrl,
            1,
            100,
            targetMimeType,
            qualityFraction,
            {
              style:
                gridStyle === 'classic'
                  ? 'classic'
                  : gridStyle === 'crosshair'
                    ? 'crosshair'
                    : 'ruler',
              originX: elementCropOrigin?.x,
              originY: elementCropOrigin?.y,
              viewportScale,
              normalized1000: gridStyle === '1000',
            },
          );
        } catch (gridErr) {
          console.warn('Failed to overlay coordinate reference grid on screenshot:', gridErr);
        }
      }

      // 2. Process output
      if (finalImageDataUrl && preCaptureState) {
        if (pageStateProbeAvailable) {
          captureState = await readScreenshotPageState(tab.id!);
        } else if (isJevVision) {
          const fallback = await executeInPage(
            { tabId: tab.id! },
            'inPageGetScrollState',
            [],
          ).catch(() => null);
          const state = fallback?.[0]?.result;
          const documentId = fallback?.[0]?.documentId || state?.documentId;
          if (state && documentId) {
            captureState = {
              documentId,
              documentURL: state.documentURL,
              width: state.viewportWidth,
              height: state.viewportHeight,
              dpr: 1,
              scrollX: state.scrollX,
              scrollY: state.scrollY,
              domRevision: -1,
              observerInitializedNow: true,
            };
          }
        }
        if (!captureState) {
          throw new Error('Failed to capture post-screenshot page state');
        }
        assertScreenshotCaptureStable(preCaptureState, captureState, {
          allowScrollChange: fullPage,
          compareDpr: false,
        });
        if (coordinateValidationSupported) {
          if (captureState.observerInitializedNow) {
            coordinateValidationSupported = false;
            coordinateValidationUnsupportedReason =
              'DOM mutation observer continuity was lost during capture';
          } else if (preDomRevision === undefined || captureState.domRevision !== preDomRevision) {
            throw new Error(
              `DOM changed during screenshot capture: pre=${preDomRevision ?? 'unknown'} post=${captureState.domRevision}`,
            );
          } else {
            captureDomRevision = captureState.domRevision;
          }
        }
      }

      if (isJevVision && finalImageDataUrl && captureState) {
        const postSigRes = await executeInPage(
          { tabId: tab.id! },
          'inPageDetectPerceptiveSignature',
          [],
        ).catch(() => null);
        const postSig = postSigRes?.[0]?.result;
        const postSigDocId = postSigRes?.[0]?.documentId;
        const postUrl = postSig?.url || captureState.documentURL || tab.url || '';

        if (!postSig || !postUrl) {
          throw new Error(
            'Failed to capture post-screenshot verification probes for TypeSafe Jev vision frame',
          );
        }

        if (postSigDocId && postSigDocId !== captureState.documentId) {
          throw new Error(
            `Document changed during screenshot probes: state="${captureState.documentId}" signature="${postSigDocId}"`,
          );
        }

        if (preUrl !== postUrl) {
          throw new Error(
            `Page URL changed during screenshot capture: pre="${preUrl}" vs post="${postUrl}"`,
          );
        }

        if (preSig && postSig) {
          const sigDrift = diffPerceptiveSignatures(preSig, postSig);
          if (sigDrift) {
            throw new Error(`Perceptive signature changed during screenshot capture: ${sigDrift}`);
          }
        }

        const preferredMime = args.format === 'png' ? 'image/png' : 'image/jpeg';
        const jevImg = await prepareImageForJevVision(finalImageDataUrl, {
          preferredFormat: preferredMime,
          quality: qualityFraction,
        });
        finalImageDataUrl = jevImg.dataUrl;
        finalImageWidthCss = jevImg.width;
        finalImageHeightCss = jevImg.height;

        const isRoiOrElement = Boolean(elementCropOrigin);
        const cropW =
          elementOriginalCrop?.width ?? (isRoiOrElement ? finalImageWidthCss : undefined);
        const cropH =
          elementOriginalCrop?.height ?? (isRoiOrElement ? finalImageHeightCss : undefined);
        const viewportWidth = captureState.width;
        const viewportHeight = captureState.height;
        const captureMode: 'viewport' | 'fullpage' | 'element' = isRoiOrElement
          ? 'element'
          : 'viewport';
        const scrollX = captureState.scrollX;
        const scrollY = captureState.scrollY;

        const documentId = captureState.documentId;
        const frameUrl = postSig?.url || postUrl || tab.url || '';

        const visionFrameId =
          'vf_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
        const frame = screenshotContextManager.createVisionFrame({
          id: visionFrameId,
          tabId: tab.id!,
          url: frameUrl,
          documentId,
          title: tab.title,
          width: jevImg.width,
          height: jevImg.height,
          contentWidth: jevImg.contentWidth,
          contentHeight: jevImg.contentHeight,
          padX: jevImg.padX,
          padY: jevImg.padY,
          scaleRatio: jevImg.scaleRatio,
          viewportWidth,
          viewportHeight,
          scrollX,
          scrollY,
          devicePixelRatio: captureState.dpr,
          captureMode,
          originX: elementCropOrigin?.x,
          originY: elementCropOrigin?.y,
          cropWidth: cropW,
          cropHeight: cropH,
          perceptiveSignature: postSig,
        });

        jevVisionFrame = {
          id: frame.id,
          width: frame.width,
          height: frame.height,
        };
      } else {
        // Update screenshot context for coordinate scaling by tools like chrome_computer
        try {
          if (typeof finalImageWidthCss === 'number' && typeof finalImageHeightCss === 'number') {
            let hostname = '';
            try {
              hostname = tab.url ? new URL(tab.url).hostname : '';
            } catch {
              // ignore
            }
            // For element captures or ROI crops, keep crop bounds and origin offset
            const isRoiOrElement = Boolean(elementCropOrigin);
            const cropW =
              elementOriginalCrop?.width ?? (isRoiOrElement ? finalImageWidthCss : undefined);
            const cropH =
              elementOriginalCrop?.height ?? (isRoiOrElement ? finalImageHeightCss : undefined);
            const viewportWidth =
              captureState?.width ??
              pageDetails?.viewportWidth ??
              captureViewport?.viewportWidth ??
              finalImageWidthCss;
            const viewportHeight =
              captureState?.height ??
              pageDetails?.viewportHeight ??
              captureViewport?.viewportHeight ??
              finalImageHeightCss;
            const captureMode: 'viewport' | 'fullpage' | 'element' = isRoiOrElement
              ? 'element'
              : fullPage
                ? 'fullpage'
                : 'viewport';
            const scrollX = originalScroll?.x ?? pageDetails?.currentScrollX ?? 0;
            const scrollY = originalScroll?.y ?? pageDetails?.currentScrollY ?? 0;
            const docWidth =
              captureMode === 'fullpage'
                ? (capturedDocWidth ?? pageDetails?.totalWidth ?? finalImageWidthCss)
                : undefined;
            const docHeight =
              captureMode === 'fullpage'
                ? (capturedDocHeight ?? pageDetails?.totalHeight ?? finalImageHeightCss)
                : undefined;
            screenshotContextManager.setContext(tab.id!, {
              screenshotWidth: finalImageWidthCss,
              screenshotHeight: finalImageHeightCss,
              viewportWidth,
              viewportHeight,
              cropWidth: cropW,
              cropHeight: cropH,
              originX: elementCropOrigin?.x,
              originY: elementCropOrigin?.y,
              devicePixelRatio: captureState?.dpr,
              hostname,
              documentId: captureState?.documentId,
              scrollX,
              scrollY,
              captureMode,
              docWidth,
              docHeight,
            });
          }
        } catch (e) {
          console.warn('Failed to set screenshot context:', e);
        }
      }

      if (saveRequested) {
        this.logInfo('Saving full-resolution PNG to temporary storage...');
        try {
          const outputPng =
            fullResolutionPngDataUrl ??
            (finalImageDataUrl ? await convertImageToPng(finalImageDataUrl) : undefined);
          if (!outputPng) {
            throw new Error('Could not encode a full-resolution PNG for saving');
          }
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeName = (name || 'screenshot').replace(/[^a-z0-9_-]/gi, '_');
          const filename = `${safeName}_${timestamp}.png`;
          const rawBase64 = outputPng.replace(/^data:[^;]+;base64,/, '');

          // Primary: save to system temporary directory via native messaging host (zero Downloads pollution)
          const tempSaved = await saveScreenshotToNativeTemp(rawBase64, filename);

          if (tempSaved && tempSaved.fullPath) {
            results.filename = tempSaved.filename;
            results.fullPath = tempSaved.fullPath;
            results.fileSaved = true;
            results.savedTo = 'system_temp';
            results.savedMimeType = 'image/png';
          } else if (typeof chrome !== 'undefined' && chrome.downloads?.download) {
            // Secondary fallback: only if native host is unreachable and user explicitly requested disk save
            const downloadId = await chrome.downloads.download({
              url: outputPng,
              filename: filename,
              saveAs: false,
              conflictAction: 'uniquify',
            });
            // filename specified directly in chrome.downloads.download

            results.downloadId = downloadId;
            results.filename = filename;
            results.fileSaved = true;
            results.savedTo = 'downloads';
            results.savedMimeType = 'image/png';

            try {
              await new Promise((resolve) => setTimeout(resolve, 100));
              const [downloadItem] = await chrome.downloads.search({ id: downloadId });
              if (downloadItem && downloadItem.filename) {
                results.fullPath = downloadItem.filename;
              }
            } catch (pathError) {
              console.warn('Could not get full file path:', pathError);
            }
          }
        } catch (error) {
          console.error('Error saving screenshot file:', error);
          results.saveError = String(error instanceof Error ? error.message : error);
        }
      }
    } catch (error) {
      logUnexpectedToolError('Error during screenshot execution:', error);
      return createErrorResponse(
        `Screenshot error: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
      );
    } finally {
      // 3. Reset page only if we prepared it
      if (didPreparePage) {
        try {
          // Only include scroll position if we successfully captured it
          const resetMessage: Record<string, unknown> = {
            action: TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE,
          };
          if (originalScroll) {
            resetMessage.scrollX = originalScroll.x;
            resetMessage.scrollY = originalScroll.y;
          }
          await this.sendToHelperWithRetry(tab.id!, resetMessage);
        } catch (err) {
          console.warn('Failed to reset page, tab might have closed:', err);
        }
      }

      // 4. Remove Set-of-Mark overlay if we injected it for screenshot
      if (didInjectSoM && tab.id) {
        try {
          const { inPageRemoveHighlights } = await import('./dom-indexer');
          await this.safeExecuteScript(tab.id, {
            target: { tabId: tab.id, allFrames: true },
            func: inPageRemoveHighlights,
          });
        } catch (err) {
          console.warn('Failed to remove Set-of-Mark highlights after screenshot:', err);
        }
      }
    }

    this.logInfo('Screenshot completed!');

    let finalBase64 =
      results.base64 ||
      (finalImageDataUrl ? finalImageDataUrl.replace(/^data:[^;]+;base64,/, '') : undefined);
    let finalMime: 'image/png' | 'image/jpeg' = isJevVision
      ? args.format === 'png'
        ? 'image/png'
        : 'image/jpeg'
      : format === 'png'
        ? 'image/png'
        : 'image/jpeg';
    let isThumbnailFinal = false;

    if (!isJevVision && finalBase64 && finalBase64.length > 450 * 1024 && finalImageDataUrl) {
      try {
        const isHighClarity =
          args.highClarity === true || fullPage === true || Boolean(results.roi);
        const maxBudget = fullPage
          ? args.highClarity
            ? 2000 * 1024
            : 1500 * 1024
          : args.highClarity
            ? 800 * 1024
            : 450 * 1024;
        const compressed = await smartCompressForTransport(finalImageDataUrl, {
          maxBytes: maxBudget,
          preferredFormat: finalMime,
          quality: isHighClarity ? 0.92 : qualityFraction,
          allowDimensionScaling:
            fullPage && !results.roi ? Boolean(args.allowDimensionScaling) : !isHighClarity,
        });
        finalBase64 = compressed.dataUrl.replace(/^data:[^;]+;base64,/, '');
        finalMime = compressed.mimeType as any;
        if (compressed.wasDownscaled) {
          isThumbnailFinal = true;
          finalImageWidthCss = compressed.width;
          finalImageHeightCss = compressed.height;
          if (tab.id) {
            const curCtx = screenshotContextManager.getContext(tab.id);
            if (curCtx) {
              screenshotContextManager.setContext(tab.id, {
                ...curCtx,
                screenshotWidth: compressed.width,
                screenshotHeight: compressed.height,
              });
            }
          }
        }
      } catch (smartErr) {
        // Fallback to legacy compressImage if smart transport compression encountered error
        try {
          const scaleRatio = Math.min(
            0.75,
            Math.max(0.2, Math.sqrt((350 * 1024) / finalBase64.length)),
          );
          const thumb = await compressImage(finalImageDataUrl, {
            scale: scaleRatio,
            quality: 0.75,
            format: finalMime,
          });
          const thumbBase64 = thumb.dataUrl.replace(/^data:image\/[^;]+;base64,/, '');
          if (thumbBase64.length < 800 * 1024) {
            finalBase64 = thumbBase64;
            finalMime = thumb.mimeType === 'image/png' ? 'image/png' : 'image/jpeg';
            isThumbnailFinal = true;
          }
        } catch (thumbErr) {
          console.warn('Failed to generate preview thumbnail in final return:', thumbErr);
        }
      }
    }

    const finalContext = screenshotContextManager.getContext(tab.id!);
    if (captureState && finalContext) {
      const record = createScreenshotCapture({
        tabId: tab.id!,
        contextTimestamp: finalContext.timestamp,
        domRevision: captureDomRevision,
        coordinateValidationSupported,
        unsupportedReason: coordinateValidationUnsupportedReason,
        state: {
          ...captureState,
          dpr: captureState.dpr,
          scrollX: coordinateValidationSupported
            ? captureState.scrollX
            : (originalScroll?.x ?? captureState.scrollX),
          scrollY: coordinateValidationSupported
            ? captureState.scrollY
            : (originalScroll?.y ?? captureState.scrollY),
        },
      });
      captureMetadata = {
        captureId: record.captureId,
        capturedAt: record.capturedAt,
        documentId: record.documentId,
        viewport: {
          width: record.width,
          height: record.height,
          dpr: record.dpr,
          scrollX: record.scrollX,
          scrollY: record.scrollY,
        },
        coordinateValidation: coordinateValidationSupported
          ? {
              supported: true,
              boundary: SCREENSHOT_CAPTURE_VALIDATION_BOUNDARY,
            }
          : {
              supported: false,
              reason:
                coordinateValidationUnsupportedReason ||
                'Screenshot coordinate validation is unavailable',
            },
      };
    }

    delete results.base64;
    const base64Data = finalBase64;

    const returnContent: any[] = [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          message: `Screenshot [${name}] captured successfully`,
          ...(jevVisionFrame ? { visionFrame: jevVisionFrame } : {}),
          ...captureMetadata,
          tabId: tab.id,
          url: scrubUrl(tab.url || ''),
          name: name,
          format: finalMime === 'image/png' ? 'png' : 'jpeg',
          requestedFormat: format,
          quality: args.quality ?? (finalMime === 'image/jpeg' ? 85 : undefined),
          imageWidth: finalImageWidthCss,
          imageHeight: finalImageHeightCss,
          viewportWidth:
            pageDetails?.viewportWidth ?? captureViewport?.viewportWidth ?? finalImageWidthCss,
          viewportHeight:
            pageDetails?.viewportHeight ?? captureViewport?.viewportHeight ?? finalImageHeightCss,
          originX: elementCropOrigin?.x ?? 0,
          originY: elementCropOrigin?.y ?? 0,
          scaleFactor: (() => {
            const baseWidth =
              elementCropOrigin?.x !== undefined
                ? (elementOriginalCrop?.width ?? finalImageWidthCss ?? 1)
                : (pageDetails?.viewportWidth ??
                  captureViewport?.viewportWidth ??
                  captureState?.width ??
                  finalImageWidthCss ??
                  1);
            return Number.isFinite(baseWidth) && baseWidth > 0
              ? (finalImageWidthCss ?? baseWidth) / baseWidth
              : 1;
          })(),
          targetIndex: args.targetIndex,
          padding: args.padding,
          selector: args.selector,
          assetIndex: args.assetIndex,
          grid: Boolean(args.grid),
          somApplied: didInjectSoM,
          ...(storeBase64 === true ? { base64Data } : {}),
          ...results,
          ...(isThumbnailFinal
            ? {
                isThumbnail: true,
                warning:
                  'Payload exceeded 450KB safety budget. High-quality preview thumbnail returned inline; nothing written to disk (pass savePng to save explicitly).',
              }
            : {}),
        }),
      },
    ];

    if (finalBase64) {
      returnContent.push({
        type: 'image',
        data: finalBase64,
        mimeType: finalMime,
      });
      screenshotRingBuffer.push({
        tabId: tab.id!,
        mimeType: finalMime,
        width: finalImageWidthCss || 800,
        height: finalImageHeightCss || 600,
        dataBase64: finalBase64,
      });
    }

    return {
      content: returnContent,
      isError: false,
    };
  }

  /**
   * Log information
   */
  private logInfo(message: string) {
    console.log(`[Screenshot Tool] ${message}`);
  }

  /**
   * Capture specific element by selector or compact 1-based index
   */
  /**
   * Send a screenshot-helper message; on timeout/no-answer, re-inject the
   * helper once and retry (stale isolated-world listener after extension
   * reload is the common case).
   */
  private async sendToHelperWithRetry(tabId: number, message: any): Promise<any> {
    const allFrames =
      message.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_PAGE_FOR_CAPTURE ||
      message.action === TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE ||
      message.action === TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE;
    const frames = allFrames ? await this.getScreenshotFrames(tabId) : [{ frameId: 0 }];
    const send = async () => {
      const settled = await Promise.allSettled(
        frames.map((frame) =>
          this.sendMessageToTab(
            tabId,
            message.action === TOOL_MESSAGE_TYPES.SCREENSHOT_RESET_PAGE_AFTER_CAPTURE &&
              frame.frameId !== 0
              ? { action: message.action }
              : message,
            frame.frameId,
          ),
        ),
      );
      // Let every frame settle before surfacing a failure: an early reject would
      // let the caller start the reset while other frames are still preparing,
      // and those late DOM mutations would survive into the next capture.
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) throw failed.reason;
      return (
        settled[frames.findIndex((frame) => frame.frameId === 0)] as
          PromiseFulfilledResult<any> | undefined
      )?.value;
    };
    try {
      return await send();
    } catch (firstErr) {
      console.warn(
        `screenshot helper no answer for ${message?.action}; re-injecting once`,
        firstErr instanceof Error ? firstErr.message : firstErr,
      );
      await this.injectScreenshotHelper(tabId);
      await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));
      return send();
    }
  }

  private async getScreenshotFrames(tabId: number) {
    const frames = await chrome.webNavigation?.getAllFrames?.({ tabId });
    return frames?.length
      ? frames.filter((frame) => !isRestrictedChromeUrl(frame.url))
      : [{ frameId: 0 }];
  }

  private async injectScreenshotHelper(tabId: number): Promise<void> {
    const frames = await this.getScreenshotFrames(tabId);
    await Promise.all(
      frames.map((frame) =>
        // A main-frame pong cannot prove the helper is present in child frames.
        this.injectContentScript(
          tabId,
          ['inject-scripts/screenshot-helper.js'],
          false,
          'ISOLATED',
          true,
          [frame.frameId],
        ),
      ),
    );
  }

  private async captureTabPng(tab: chrome.tabs.Tab): Promise<string> {
    if (!tab.active && tab.id) {
      // For background tabs, captureVisibleTab would capture whatever tab is currently active
      // in the window, causing an active window data leak. Use CDP Page.captureScreenshot instead.
      const tabId = tab.id;
      const { cdpSessionManager } = await import('@/utils/cdp-session-manager');
      const shot: any = await cdpSessionManager.withSession(tabId, 'screenshot-bg', async () => {
        return await cdpSessionManager.sendCommand(tabId, 'Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
        });
      });
      if (!shot?.data)
        throw new Error('CDP captureScreenshot returned empty data for background tab');
      return `data:image/png;base64,${shot.data}`;
    }

    const dataUrl =
      typeof tab.windowId === 'number'
        ? await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });
    if (!dataUrl) throw new Error('captureVisibleTab returned empty image');
    return dataUrl;
  }

  /**
   * Quota error retry with exponential backoff for captureVisibleTab
   * Protects against Chrome's MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND rate limit.
   */
  private async captureTabPngWithRetry(tab: chrome.tabs.Tab, maxRetries = 5): Promise<string> {
    let delay = 60;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.captureTabPng(tab);
      } catch (err) {
        const isQuota =
          err &&
          typeof err === 'object' &&
          typeof (err as any).message === 'string' &&
          ((err as any).message.includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND') ||
            (err as any).message.includes('quota') ||
            (err as any).message.includes('Quota'));
        if (isQuota && attempt < maxRetries) {
          this.logInfo(
            `captureVisibleTab quota limit hit (attempt ${attempt + 1}/${maxRetries}), backing off ${delay}ms`,
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay = Math.min(1000, delay * 2);
          continue;
        }
        throw err;
      }
    }
    throw new Error('captureVisibleTab quota exceeded after retries');
  }

  async _captureElement(
    tabId: number,
    options: ScreenshotToolParams,
    pageDpr: number,
    windowId?: number,
  ): Promise<{
    dataUrl: string;
    widthCss: number;
    heightCss: number;
    originX: number;
    originY: number;
    originalCropWidth?: number;
    originalCropHeight?: number;
    fullResolutionDataUrl?: string;
  }> {
    let cropRectPx: { x: number; y: number; width: number; height: number };
    let dpr = pageDpr || 1;

    if (typeof options.targetIndex === 'number') {
      const results = await executeInPage({ tabId, allFrames: true }, 'inPageGetIndexCropRect', [
        options.targetIndex,
        options.padding ?? 0,
        options.expandSearchArea ?? options.autoExpand ?? true,
      ]);
      const match = results?.find((r) => r.result?.success);
      const outcome = match?.result;
      if (!outcome?.success || !outcome.rect) {
        throw new Error(
          outcome?.error || `Element with index [${options.targetIndex}] not found for screenshot`,
        );
      }
      dpr = outcome.devicePixelRatio || pageDpr || 1;
      cropRectPx = {
        x: Math.round(outcome.rect.x * dpr),
        y: Math.round(outcome.rect.y * dpr),
        width: Math.round(outcome.rect.width * dpr),
        height: Math.round(outcome.rect.height * dpr),
      };
    } else {
      const elementDetails = await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_GET_ELEMENT_DETAILS,
        selector: options.selector,
      });

      dpr = elementDetails.devicePixelRatio || pageDpr || 1;
      const pad = Math.max(0, options.padding ?? 0);
      cropRectPx = {
        x: Math.max(0, Math.round((elementDetails.rect.x - pad) * dpr)),
        y: Math.max(0, Math.round((elementDetails.rect.y - pad) * dpr)),
        width: Math.round((elementDetails.rect.width + pad * 2) * dpr),
        height: Math.round((elementDetails.rect.height + pad * 2) * dpr),
      };
    }

    // Re-align Set-of-Mark visual badges overlay after implicit scrollIntoView (for targetIndex and selector)
    const enableSoM =
      options.som === true || options.highlight === true || options.setOfMark === true;
    if (enableSoM) {
      try {
        await executeInPage({ tabId, allFrames: true }, 'inPageRealignHighlights', []);
      } catch {}
    }

    // Small delay to ensure element is fully rendered after scrollIntoView
    await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_CONSTANTS.SCRIPT_INIT_DELAY));

    const targetTab = await Promise.resolve(
      typeof chrome !== 'undefined' && chrome.tabs?.get ? chrome.tabs.get(tabId) : null,
    ).catch(() => null);
    const visibleCaptureDataUrl = targetTab
      ? await this.captureTabPngWithRetry(targetTab)
      : typeof windowId === 'number'
        ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
        : await chrome.tabs.captureVisibleTab({ format: 'png' });
    if (!visibleCaptureDataUrl) {
      throw new Error('Failed to capture visible tab for element cropping');
    }

    // DPR 1:1 Normalization: enforce output dimensions to exact CSS pixel dimensions
    const zoom =
      typeof options.zoom === 'number' && Number.isFinite(options.zoom) && options.zoom > 0
        ? options.zoom
        : 1;
    const baseWidth = Math.max(1, Math.round(cropRectPx.width / dpr));
    const baseHeight = Math.max(1, Math.round(cropRectPx.height / dpr));
    const rawWidthCss = options.width ?? Math.round(baseWidth * zoom);
    const rawHeightCss = options.height ?? Math.round(baseHeight * zoom);
    const { width: finalWidthCss, height: finalHeightCss } = clampCanvasDimensions(
      rawWidthCss,
      rawHeightCss,
    );

    const croppedCanvas = new OffscreenCanvas(finalWidthCss, finalHeightCss);
    const ctx = croppedCanvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context from OffscreenCanvas');

    const rawImg = await createImageBitmapFromUrl(visibleCaptureDataUrl);
    try {
      ctx.drawImage(
        rawImg,
        cropRectPx.x,
        cropRectPx.y,
        cropRectPx.width,
        cropRectPx.height,
        0,
        0,
        finalWidthCss,
        finalHeightCss,
      );

      const format = options.format === 'png' ? 'png' : 'jpeg';
      const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const qualityFraction =
        typeof options.quality === 'number'
          ? Math.max(0, Math.min(1, options.quality / 100))
          : 0.85;

      const dataUrl = await canvasToDataURL(croppedCanvas, mimeType, qualityFraction);
      let fullResolutionDataUrl: string | undefined;
      if (options.savePng === true || options.saveToDisk === true) {
        const fullCrop = clampCanvasDimensions(cropRectPx.width, cropRectPx.height);
        const fullCanvas = new OffscreenCanvas(fullCrop.width, fullCrop.height);
        const fullCtx = fullCanvas.getContext('2d');
        if (fullCtx) {
          fullCtx.drawImage(
            rawImg,
            cropRectPx.x,
            cropRectPx.y,
            cropRectPx.width,
            cropRectPx.height,
            0,
            0,
            fullCrop.width,
            fullCrop.height,
          );
          fullResolutionDataUrl = await canvasToDataURL(fullCanvas, 'image/png');
        }
      }
      return {
        dataUrl,
        widthCss: finalWidthCss,
        heightCss: finalHeightCss,
        originX: Math.round(cropRectPx.x / dpr),
        originY: Math.round(cropRectPx.y / dpr),
        originalCropWidth: baseWidth,
        originalCropHeight: baseHeight,
        ...(fullResolutionDataUrl ? { fullResolutionDataUrl } : {}),
      };
    } finally {
      if (typeof (rawImg as any).close === 'function') (rawImg as any).close();
    }
  }

  /**
   * Capture full page with GoFullPage-grade industrial features:
   * - StyleStack fixed/sticky header de-duplication across slices
   * - Page warmup to trigger lazy loading / IntersectionObserver / skeletons
   * - Dynamic height change auto-recovery during scrolling
   * - captureVisibleTab quota error exponential backoff retry
   * - Safe OffscreenCanvas stitching with max dimension bounds
   * - DPR 1:1 CSS pixel normalization
   */
  async _captureFullPage(
    tabId: number,
    options: ScreenshotToolParams,
    initialPageDetails: any,
    windowId?: number,
  ): Promise<{
    dataUrl: string;
    widthCss: number;
    heightCss: number;
    originalCaptureWidth: number;
    originalCaptureHeight: number;
    fullResolutionDataUrl?: string;
  }> {
    // 1. Warmup page: quick down-and-up scroll to trigger lazy loading, IntersectionObserver & skeleton screens
    try {
      this.logInfo('Warming up page for lazy loading and skeleton rendering...');
      const warmupResp = await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_WARMUP_PAGE,
      });
      if (warmupResp && typeof warmupResp.totalHeight === 'number' && warmupResp.totalHeight > 0) {
        initialPageDetails.totalHeight = warmupResp.totalHeight;
        if (typeof warmupResp.totalWidth === 'number' && warmupResp.totalWidth > 0) {
          initialPageDetails.totalWidth = warmupResp.totalWidth;
        }
      }
    } catch (warmupErr) {
      console.warn('Page warmup failed, proceeding with initial dimensions:', warmupErr);
    }

    const dpr = initialPageDetails.devicePixelRatio || 1;
    const totalWidthCss = initialPageDetails.totalWidth;
    let totalHeightCss = initialPageDetails.totalHeight;

    // Apply maximum height limit for infinite scroll pages
    const maxHeightPx = options.maxHeight || SCREENSHOT_CONSTANTS.MAX_CAPTURE_HEIGHT_PX;
    let limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);

    const totalWidthPx = totalWidthCss * dpr;
    let totalHeightPx = limitedHeightCss * dpr;

    this.logInfo(
      `Viewport size: ${initialPageDetails.viewportWidth}x${initialPageDetails.viewportHeight} CSS pixels`,
    );
    this.logInfo(
      `Page dimensions: ${totalWidthCss}x${totalHeightCss} CSS pixels (limited to ${limitedHeightCss} height)`,
    );

    const viewportHeightCss = initialPageDetails.viewportHeight;

    // Ensure initial scroll position is (0, 0) before slice 0
    await this.sendMessageToTab(tabId, {
      action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
      x: 0,
      y: 0,
      scrollDelay: 50,
    }).catch(() => {});

    const capturedParts: { dataUrl: string; y: number }[] = [];
    let currentScrollYCss = 0;
    let capturedHeightPx = 0;
    let partIndex = 0;

    while (capturedHeightPx < totalHeightPx && partIndex < SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      const isLastStep =
        currentScrollYCss + viewportHeightCss >=
        limitedHeightCss - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE;

      this.logInfo(
        `Capturing part ${partIndex + 1}... (${Math.round((capturedHeightPx / totalHeightPx) * 100)}%) [lastStep: ${isLastStep}]`,
      );

      // 1. Scroll to slice position FIRST (part 0 skips scroll if already at top)
      // Executing scroll first triggers scroll events, lazy loading, and sticky header activation
      if (currentScrollYCss > 0) {
        const scrollResp = await this.sendMessageToTab(tabId, {
          action: TOOL_MESSAGE_TYPES.SCREENSHOT_SCROLL_PAGE,
          x: 0,
          y: currentScrollYCss,
          scrollDelay: SCREENSHOT_CONSTANTS.SCROLL_DELAY_MS,
        });

        // 2. Dynamic height change recovery: detect page expansion/collapse between steps
        if (
          scrollResp &&
          typeof scrollResp.totalHeight === 'number' &&
          Math.abs(scrollResp.totalHeight - totalHeightCss) > 5
        ) {
          const diff = scrollResp.totalHeight - totalHeightCss;
          this.logInfo(
            `Dynamic height change detected: ${diff > 0 ? '+' : ''}${diff}px (old: ${totalHeightCss}, new: ${scrollResp.totalHeight})`,
          );
          totalHeightCss = scrollResp.totalHeight;
          limitedHeightCss = Math.min(totalHeightCss, maxHeightPx / dpr);
          totalHeightPx = limitedHeightCss * dpr;
        }

        if (scrollResp && typeof scrollResp.newScrollY === 'number') {
          currentScrollYCss = scrollResp.newScrollY;
        }
      }

      // 3. Prepare slice in DOM: GoFullPage StyleStack fixed header hiding / sticky conversion / bottom banner management
      // Executed AFTER scrolling so elements that become sticky/fixed on scroll are accurately detected and handled
      await this.sendToHelperWithRetry(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_PREPARE_SLICE,
        stepIndex: partIndex,
        isLastStep,
      }).catch((err) => {
        console.warn(`prepareSlice failed on step ${partIndex}:`, err);
      });

      // 4. Ensure rendering after DOM updates
      await new Promise((resolve) =>
        setTimeout(resolve, SCREENSHOT_CONSTANTS.CAPTURE_STITCH_DELAY_MS),
      );

      // 5. Capture with quota retry
      const targetTab = await Promise.resolve(
        typeof chrome !== 'undefined' && chrome.tabs?.get ? chrome.tabs.get(tabId) : null,
      ).catch(() => null);
      const dataUrl = targetTab
        ? await this.captureTabPngWithRetry(targetTab)
        : typeof windowId === 'number'
          ? await chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
          : await chrome.tabs.captureVisibleTab({ format: 'png' });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty during full page capture');

      const yOffsetPx = currentScrollYCss * dpr;
      capturedParts.push({ dataUrl, y: yOffsetPx });

      // 6. Immediately pop slice-specific fixed modifications so DOM returns to natural state before next scroll
      await this.sendMessageToTab(tabId, {
        action: TOOL_MESSAGE_TYPES.SCREENSHOT_POP_SLICE_FIXED,
      }).catch(() => {});

      const imgForHeight = await createImageBitmapFromUrl(dataUrl);
      const lastPartEffectiveHeightPx = Math.min(imgForHeight.height, totalHeightPx - yOffsetPx);
      imgForHeight.close?.();
      capturedHeightPx = yOffsetPx + lastPartEffectiveHeightPx;

      if (capturedHeightPx >= totalHeightPx - SCREENSHOT_CONSTANTS.PIXEL_TOLERANCE) break;

      currentScrollYCss += viewportHeightCss;
      // Prevent overscrolling past the document height for the next scroll command
      if (
        currentScrollYCss > limitedHeightCss - viewportHeightCss &&
        currentScrollYCss < limitedHeightCss
      ) {
        currentScrollYCss = limitedHeightCss - viewportHeightCss;
      }
      partIndex++;
    }

    if (partIndex >= SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS) {
      this.logInfo(
        `Reached maximum number of capture parts (${SCREENSHOT_CONSTANTS.MAX_CAPTURE_PARTS}). This may be an infinite scroll page.`,
      );
    }
    if (totalHeightCss > limitedHeightCss) {
      this.logInfo(
        `Page height (${totalHeightCss}px) exceeds maximum capture height (${maxHeightPx / dpr}px). Capturing limited portion.`,
      );
    }

    const actualCapturedHeightPx = Math.min(
      totalHeightPx,
      capturedHeightPx > 0 ? capturedHeightPx : totalHeightPx,
    );
    const capturedHeightCss = Math.max(1, Math.round(actualCapturedHeightPx / dpr));
    const capturedWidthCss = Math.max(1, Math.round(initialPageDetails.totalWidth));

    this.logInfo('Stitching image with canvas boundary safety...');
    const finalCanvas = await stitchImages(capturedParts, totalWidthPx, actualCapturedHeightPx);

    // DPR 1:1 Normalization: enforce output dimensions to standard CSS pixels
    let targetWidthCss = capturedWidthCss;
    let targetHeightCss = capturedHeightCss;

    if (options.width && !options.height) {
      targetWidthCss = options.width;
      const aspectRatio = finalCanvas.height / finalCanvas.width;
      targetHeightCss = Math.round(targetWidthCss * aspectRatio);
    } else if (options.height && !options.width) {
      targetHeightCss = options.height;
      const aspectRatio = finalCanvas.width / finalCanvas.height;
      targetWidthCss = Math.round(targetHeightCss * aspectRatio);
    } else if (options.width && options.height) {
      targetWidthCss = options.width;
      targetHeightCss = options.height;
    }

    const MAX_CANVAS_DIM = 16384;
    const MAX_CANVAS_AREA = 268435456;
    if (
      targetWidthCss > MAX_CANVAS_DIM ||
      targetHeightCss > MAX_CANVAS_DIM ||
      targetWidthCss * targetHeightCss > MAX_CANVAS_AREA
    ) {
      const dimScale = Math.min(MAX_CANVAS_DIM / targetWidthCss, MAX_CANVAS_DIM / targetHeightCss);
      const areaScale = Math.sqrt(MAX_CANVAS_AREA / (targetWidthCss * targetHeightCss));
      const scale = Math.min(dimScale, areaScale);
      targetWidthCss = Math.max(1, Math.floor(targetWidthCss * scale));
      targetHeightCss = Math.max(1, Math.floor(targetHeightCss * scale));
    }

    let outputCanvas: any;
    if (typeof OffscreenCanvas !== 'undefined') {
      outputCanvas = new OffscreenCanvas(targetWidthCss, targetHeightCss);
      const ctx = outputCanvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(finalCanvas, 0, 0, targetWidthCss, targetHeightCss);
      }
    } else {
      outputCanvas = finalCanvas;
    }

    const format = options.format === 'png' ? 'png' : 'jpeg';
    const targetMime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const qualityFraction =
      typeof options.quality === 'number' ? Math.max(0, Math.min(1, options.quality / 100)) : 0.85;
    const finalDataUrl = await canvasToDataURL(outputCanvas, targetMime, qualityFraction);
    let fullResolutionDataUrl: string | undefined;
    if (options.savePng === true || options.saveToDisk === true) {
      fullResolutionDataUrl = await canvasToDataURL(finalCanvas, 'image/png');
    }

    return {
      dataUrl: finalDataUrl,
      widthCss: targetWidthCss,
      heightCss: targetHeightCss,
      originalCaptureWidth: capturedWidthCss,
      originalCaptureHeight: capturedHeightCss,
      ...(fullResolutionDataUrl ? { fullResolutionDataUrl } : {}),
    };
  }
}

export const screenshotTool = new ScreenshotTool();
