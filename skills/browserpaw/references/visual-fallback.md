# Visual Fallback & Multimodal Coordination Reference (PCIE)

This reference documents the secondary visual execution engine for canvas games, WebGL visualizations, unlabeled SVG icons, or anti-bot DOM-obfuscated layouts.

---

## 1. When to Use Visual Fallback

- **Canvas & WebGL**: Interactive games, maps, charts, or drawing apps without DOM elements.
- **Unlabeled SVG Elements**: Graphical buttons or custom icons lacking text, aria-labels, or roles.
- **DOM Obfuscation**: Elements deliberately detached or hidden from accessibility trees.
- **Visual Verification**: Checking visual styling, alignment, or screenshot-based evidence.

Prefer an observed DOM ref or strict locator when it identifies the intended target. Use screenshots when the rendered content carries information the DOM cannot express. Neither path is guaranteed to complete the business task; verify its result.

---

## 2. Coordinate Spaces and Capture Identity

Screenshot dimensions can differ from CSS viewport dimensions because of scaling, cropping or image preparation. Read the returned `imageWidth`, `imageHeight`, viewport and capture metadata; do not multiply coordinates by the OS display scale yourself.

- Native `coordinateSpace: "viewport"` coordinates use CSS viewport pixels and need no capture ID.
- `coordinateSpace: "screenshot"` uses image coordinates and requires the exact ordinary `captureId` returned with a fresh screenshot. An implicit latest screenshot is insufficient.
- Ordinary capture coordinates are available only when the screenshot reports `coordinateValidation.supported: true`. Full-page, element/ROI, asset and SoM captures may report unsupported; use them for inspection and obtain a supported viewport capture before acting.
- Jev's `expectedScreenshotId` identifies its separate vision frame. Do not combine it with an ordinary `captureId`.

---

## 3. Visual Perception Tools (`chrome_screenshot`)

### A. Calibrated Coordinate Grid & Perimeter Rulers

```json
{
  "grid": true,
  "format": "jpeg",
  "quality": 85
}
```

- Adds coordinate grid and ruler cues. They assist reading coordinates; the capture identity and returned validation metadata still govern whether coordinate actions can run.

### B. Set-of-Mark 2.0 (SoM)

```json
{
  "som": true,
  "format": "jpeg"
}
```

- Labels interactive elements with high-contrast, compact numeric badges.
- Incorporates frustum culling (pruning off-screen nodes) and 25px collision avoidance.

### C. Full-Page Capture (`fullPage: true`)

```json
{
  "fullPage": true,
  "format": "png"
}
```

- Requests a full-page image. Inspect the returned dimensions, truncation and coordinate-validation status rather than treating it as a viewport capture.

### D. Lossless ROI Sub-Region Crops & High Clarity

```json
{
  "region": { "x0": 300, "y0": 200, "x1": 700, "y1": 500 },
  "highClarity": true
}
```

- Requests a region for closer inspection of icons, text or tables. Read the returned scaling and validation metadata; a crop is not automatically a supported coordinate source.

The default model-facing image is fitted to a 1568px long edge and 1.15MP while preserving the viewport aspect ratio. Lower `maxDimension` or `maxPixels` to save tokens; raise them, use `highClarity`, or capture a `region` for fine text. Screenshots are emitted as JPEG or PNG, never WebP.

For routine visual checks, start with the default JPEG budget. Use a smaller `maxDimension` for layout confirmation, and reserve `highClarity` or a tight `region` for OCR and fine details. If a background-tab capture is slow, let BrowserPaw's bounded retry finish; do not issue a burst of duplicate screenshots.

### E. User-Facing or Saved Screenshots

```json
{
  "fullPage": true,
  "savePng": true
}
```

- `savePng: true` writes a full-resolution, lossless PNG at the capture's physical-pixel size to the system temporary directory and returns `fullPath`.
- Use it whenever the user asks to view or keep a screenshot. The inline preview may be JPEG for model token efficiency; the saved file remains the clear original.
- The task page follows the real Chrome window size and DPR. Do not assume 1440x900 or DPR 1; read `imageWidth`, `imageHeight`, `viewportWidth`, `viewportHeight`, and the capture metadata before mapping coordinates.

---

## 4. Multimodal Coordinate Actions (`chrome_computer`)

For visual clicks and typing, BrowserPaw supports Polymorphic Coordinate Input (PCIE):

- **Viewport Object**: `{ "action": "left_click", "coordinateSpace": "viewport", "coordinates": { "x": 450, "y": 320 } }`
- **Screenshot Object**: `{ "action": "left_click", "coordinateSpace": "screenshot", "captureId": "<observed captureId>", "coordinates": { "x": 450, "y": 320 } }`
- **Array Coordinates**: `[450, 320]` uses the same explicitly selected coordinate space and identity rules.
- **Supported Actions** (16): `left_click`, `right_click`, `double_click`, `triple_click`, `left_click_drag`, `scroll`, `scroll_to`, `type`, `key`, `hover`, `wait`, `fill`, `fill_form`, `zoom`, `screenshot`, `resize_page`.
- **Validation**: Screenshot actions check the capture, document, viewport, DPR, scroll and observed DOM revision before dispatch. A navigation, relevant mutation, replaced capture or lost observer requires a fresh screenshot. Do not retry the original action to infer whether a dispatched write succeeded.
- **Boundary**: Canvas redraws, video, pure CSS animation and cross-origin frame contents are not fully observable by this DOM-based check. Read `captureValidationBoundary`; use fresh visual evidence and a business postcondition for these cases.
- **Outcome**: A trusted mouse event or accepted coordinate is delivery evidence. Verify the requested page/result state separately.
