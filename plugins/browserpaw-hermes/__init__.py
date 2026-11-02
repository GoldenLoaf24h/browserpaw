"""BrowserPaw optional Hermes tools, delegated through the public MCP client."""
from __future__ import annotations

import json
import logging
from pathlib import Path
import re
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)


def _register_bundled_skill(ctx: Any) -> None:
    skill_md = Path(__file__).resolve().parent / 'skills' / 'browserpaw' / 'SKILL.md'
    if not skill_md.is_file() or not hasattr(ctx, 'register_skill'):
        return
    try:
        ctx.register_skill(
            'browserpaw',
            skill_md,
            description='High-efficiency Chrome browser control and automation via BrowserPaw',
        )
    except Exception as exc:
        logger.debug('Failed to register bundled browserpaw skill: %s', exc)

_CORE_SCHEMAS = json.loads((Path(__file__).resolve().parent / "core_schemas.json").read_text(encoding="utf-8"))

TOOL_DEFINITIONS = {
    "browserpaw_task": _CORE_SCHEMAS["chrome_task"],
    "browserpaw_skill": _CORE_SCHEMAS["chrome_skill"],
    "browserpaw_get_windows_and_tabs": {
        "description": "Get all currently open browser windows and tabs",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "required": []
        }
    },
    "browserpaw_navigate": {
        "description": "Navigate to a URL, refresh the current tab, or navigate browser history (back/forward)",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "URL to navigate to. Special values: \"back\" or \"forward\" to navigate browser history in the target tab."
                },
                "action": {
                    "type": "string",
                    "enum": [
                        "back",
                        "forward"
                    ],
                    "description": "Alternative to url=\"back\"|\"forward\": navigate browser history backward or forward."
                },
                "newTab": {
                    "type": "boolean",
                    "description": "Force creation of a new background tab. Existing pages are never reused when true. Default: false"
                },
                "newWindow": {
                    "type": "boolean",
                    "description": "Create a new window to navigate to the URL or not. Defaults to false"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target an existing tab by ID (if provided, navigate/refresh/back/forward that tab instead of the active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target an existing window by ID (when creating a new tab in existing window, or picking active tab if tabId is not provided)."
                },
                "background": {
                    "type": "boolean",
                    "description": "Perform the operation without stealing focus (do not activate the tab or focus the window). Default: true (set false only if user explicitly asks to bring tab to foreground)"
                },
                "width": {
                    "type": "number",
                    "description": "Window width in pixels (default: 1280). When width or height is provided, a new window will be created."
                },
                "height": {
                    "type": "number",
                    "description": "Window height in pixels (default: 720). When width or height is provided, a new window will be created."
                },
                "refresh": {
                    "type": "boolean",
                    "description": "Refresh the current active tab instead of navigating to a URL. When true, the url parameter is ignored. Defaults to false"
                },
                "groupTitle": {
                    "type": "string",
                    "description": "Task-aligned title for the Chrome tab group in user language (e.g. \"GitHub 搜索\", \"Flight Tracker\"). Fallback: \"Agent\""
                },
                "groupColor": {
                    "type": "string",
                    "enum": [
                        "grey",
                        "blue",
                        "red",
                        "yellow",
                        "green",
                        "pink",
                        "purple",
                        "cyan",
                        "orange"
                    ],
                    "description": "Color for the Chrome tab group. Fallback: \"blue\""
                },
                "autoGroup": {
                    "type": "boolean",
                    "description": "Automatically place newly opened tab into an Agent-managed tab group with dedicated title and color. Default: true"
                },
                "dismissOverlays": {
                    "type": "boolean",
                    "description": "Automatically detect and dismiss visible marketing popups, coupon modals, and promotional overlays after navigation completes (default: false)"
                }
            },
            "required": []
        }
    },
    "browserpaw_screenshot": {
        "description": "[Prefer browserpaw_read_dom over taking a screenshot] Capture the page, a region, or an element as PNG/JPEG. The default inline JPEG is fitted to a 1568px long edge and 1.15MP for a practical OCR/token balance. Tune sharpness with maxWidth, maxDimension, maxPixels, highClarity, or region. savePng writes the full-resolution physical-pixel PNG for user-facing delivery.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "name": {
                    "type": "string",
                    "description": "Name or label for the screenshot. Purely in-memory by default; only written to disk if savePng/saveToDisk is explicitly set to true."
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector for element to screenshot"
                },
                "assetIndex": {
                    "type": "number",
                    "description": "View one visual asset listed by browserpaw_read_dom ([asset N] lines): returns the real image resource; falls back to a viewport crop when bytes are unavailable"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID to capture from (default: active tab)."
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID to pick active tab from when tabId is not provided."
                },
                "background": {
                    "type": "boolean",
                    "description": "Attempt capture without bringing tab/window to foreground. CDP-based capture is used for viewport captures. Default: true"
                },
                "width": {
                    "type": "number",
                    "description": "Width in pixels (default: 800)"
                },
                "height": {
                    "type": "number",
                    "description": "Height in pixels (default: 600)"
                },
                "maxWidth": {
                    "type": "number",
                    "description": "Optional hard cap on image width in pixels, applied together with the vision budget."
                },
                "maxDimension": {
                    "type": "number",
                    "description": "Maximum long edge in pixels for the model-facing image (default: 1568). Lower it to reduce tokens; raise it for fine text."
                },
                "maxPixels": {
                    "type": "number",
                    "description": "Maximum total pixels for the model-facing image (default: 1,150,000). Lower it to reduce tokens; raise it for dense pages."
                },
                "storeBase64": {
                    "type": "boolean",
                    "description": "Return screenshot in base64 format in text content (image content is always returned directly)"
                },
                "fullPage": {
                    "type": "boolean",
                    "description": "Capture a full-page scroll screenshot with GoFullPage-grade industrial stitching: automatic StyleStack fixed/sticky header de-duplication, page warmup for lazy-loading/skeletons, dynamic height change recovery, and captureVisibleTab quota backoff retry (default: false)."
                },
                "maxHeight": {
                    "type": "number",
                    "description": "Maximum height in pixels to capture for full-page screenshots (default: 50000, protects against infinite scroll runaway)."
                },
                "savePng": {
                    "type": "boolean",
                    "description": "Save a full-resolution, lossless PNG at the capture physical-pixel size to the system temporary directory. Use this for screenshots the user asked to view or keep."
                },
                "saveToDisk": {
                    "type": "boolean",
                    "description": "Deprecated alias for savePng (default: false, zero disk write by default; saves to system temp, not Downloads). Prefer savePng."
                },
                "som": {
                    "type": "boolean",
                    "description": "Overlay Set-of-Mark numbered badges on interactive elements before capturing the screenshot"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Deprecated alias for som; still accepted but hidden from the schema to keep it small. Prefer som."
                },
                "targetIndex": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of target element from browserpaw_read_dom to crop and capture only this specific region of interest"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for targetIndex: compact 1-based numeric index of target element from browserpaw_read_dom to crop and capture"
                },
                "padding": {
                    "type": "number",
                    "description": "Padding in pixels to expand around targetIndex crop area (default: 0)"
                },
                "region": {
                    "type": "object",
                    "description": "High-density ROI crop: capture only a specific sub-region { x0, y0, x1, y1 } in CSS pixels or polymorphic [ymin, xmin, ymax, xmax]. Use it to inspect fine text without paying for the full page.",
                    "properties": {
                        "x0": {
                            "type": "number"
                        },
                        "y0": {
                            "type": "number"
                        },
                        "x1": {
                            "type": "number"
                        },
                        "y1": {
                            "type": "number"
                        }
                    }
                },
                "crop": {
                    "type": "object",
                    "description": "Alias for region: { x, y, width, height } or { x0, y0, x1, y1 }."
                },
                "grid": {
                    "type": "boolean",
                    "description": "Overlay semi-transparent coordinate reference grid with perimeter tape measure rulers (20/50/100px ticks) and interior reticle crosshairs (+) to eliminate visual estimation hallucination (default: false)"
                },
                "enableGrid": {
                    "type": "boolean",
                    "description": "Alias for grid: overlay semi-transparent coordinate reference grid with perimeter tape measure rulers and crosshairs"
                },
                "expandSearchArea": {
                    "type": "boolean",
                    "description": "For small elements (< 100x100), adaptively expand the crop bounding box to preserve surrounding headers and text context (default: true)"
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "png",
                        "jpeg"
                    ],
                    "description": "Output format: jpeg (default, compact for model inspection) or png (lossless). Saved screenshots are always PNG."
                },
                "quality": {
                    "type": "number",
                    "description": "Image compression quality from 0 to 100 for JPEG (default: 85)"
                },
                "highClarity": {
                    "type": "boolean",
                    "description": "Disable the default vision budget and keep the native CSS-pixel image, unless maxDimension/maxPixels/maxWidth is explicitly set."
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserpaw_close_tabs": {
        "description": "Close one or more browser tabs",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Single tab ID to close (convenience alternative to tabIds array)."
                },
                "tabIds": {
                    "type": "array",
                    "items": {
                        "type": "number"
                    },
                    "description": "Array of tab IDs to close. If not provided, will close the active tab (requires confirm: true or session affinity)."
                },
                "expectedTabs": {
                    "type": "array",
                    "description": "Fail-closed tab identities for task-owned cleanup. All tab IDs must match the current document and browser before any tab is closed.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "tabId": {
                                "type": "number"
                            },
                            "documentId": {
                                "type": "string"
                            },
                            "browserInstanceId": {
                                "type": "string"
                            }
                        },
                        "required": [
                            "tabId",
                            "documentId",
                            "browserInstanceId"
                        ]
                    }
                },
                "url": {
                    "type": "string",
                    "description": "Close tabs matching this URL. Can be used instead of tabIds."
                },
                "confirm": {
                    "type": "boolean",
                    "description": "Explicit confirmation required to close the active tab when tabIds or url are not specified."
                },
                "allManagedGroups": {
                    "type": "boolean",
                    "description": "Close all Agent-managed tab groups and their tabs created during automation sessions. Default: false"
                }
            },
            "required": []
        }
    },
    "browserpaw_switch_tab": {
        "description": "Switch to a specific browser tab",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "The ID of the tab to switch to."
                },
                "windowId": {
                    "type": "number",
                    "description": "The ID of the window where the tab is located."
                },
                "background": {
                    "type": "boolean",
                    "description": "If true, binds session affinity only without activating the tab in the Chrome UI or stealing user focus. Default: false"
                }
            },
            "required": [
                "tabId"
            ]
        }
    },
    "browserpaw_read_dom": {
        "description": "Extract and prune interactive DOM tree with compact 1-based index assignment, viewport boundary filtering, and occlusion pruning. Supports scoped container targeting (selector) and noise exclusion (exclude) to eliminate full DOM dump overhead.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "selector": {
                    "type": "string",
                    "description": "CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "scope": {
                    "type": "string",
                    "description": "Alias for selector. CSS selector to scope parsing to a specific container/element (e.g. \"#main-cart\", \".dialog-box\"). Only descendants and self within matching containers are indexed."
                },
                "isolateModal": {
                    "type": "boolean",
                    "description": "When true and an active modal dialog is detected, restricts indexing to the active modal while strictly protecting portals, dropdowns, and alert containers."
                },
                "exclude": {
                    "oneOf": [
                        {
                            "type": "string"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "string"
                            }
                        }
                    ],
                    "description": "CSS selector(s) to exclude from parsing (e.g. \"#footer, #recommendations, .ad-banner\"). Matching elements and their entire subtrees are pruned."
                },
                "viewportThreshold": {
                    "type": "number",
                    "description": "Vertical threshold in pixels for viewport boundary checking (default 1000)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "highlight": {
                    "type": "boolean",
                    "description": "Whether to visually highlight indexed elements"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "cursor": {
                    "type": "number",
                    "description": "Pagination cursor offset for traversing very large DOM pages incrementally (default: 0)"
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum number of indexed elements to return for current page cursor slice (default: unlimited)"
                },
                "maxTextLength": {
                    "type": "number",
                    "description": "Maximum text length before truncation for element text content (default: 120)"
                },
                "includeDetails": {
                    "type": "boolean",
                    "description": "Also return the bulky indexedElements/indexMap detail blocks (geometry, occlusion flags, safe click points). Off by default because the tree already carries index/tag/attributes/text; enable only when you need per-element rects or visibility flags."
                },
                "viewportOnly": {
                    "type": "boolean",
                    "description": "When true, only index elements inside or immediately near the visible viewport (default: false)"
                },
                "activeViewportOnly": {
                    "type": "boolean",
                    "description": "When true, strictly constrains indexing to elements currently visible within the active viewport (threshold = 0) with horizontal/vertical frustum clipping, eliminating ghost elements from SPA wizards, carousels, and multi-step forms."
                },
                "format": {
                    "type": "string",
                    "enum": [
                        "compact",
                        "html",
                        "fast"
                    ],
                    "description": "Output format for treeString. \"compact\" (default) produces a concise, accessibility-tree-inspired representation without closing tags. \"html\" returns legacy pseudo-HTML tags. \"fast\" activates the bounded atomic snapshot mode."
                },
                "fast": {
                    "type": "boolean",
                    "description": "When true, activates the bounded atomic DOM snapshot engine with WeakMap caching, unique-element budgets, and native checkVisibility."
                },
                "legacyVisibility": {
                    "type": "boolean",
                    "description": "When true, uses legacy visibility fallback (computedStyle display/visibility/opacity) instead of element.checkVisibility."
                },
                "deltaOnly": {
                    "type": "boolean",
                    "description": "When true, returns only changed/added/removed diffs compared to the previous snapshot, saving 90%+ tokens on repeated reads."
                },
                "dismissOverlays": {
                    "type": "boolean",
                    "description": "When true, automatically detects and dismisses visible marketing popups, coupon modals, and promotional overlays before indexing DOM nodes, preventing modal overlays from polluting the DOM tree (default: false)"
                },
                "virtualizeViewport": {
                    "type": "boolean",
                    "description": "When true (enabled by default on infinite scroll, long feeds, and waterfall pages when selector/scope is omitted), intelligently virtualizes and folds repetitive offscreen subtrees into compact summaries, drastically slashing token usage while strictly preserving visible viewport elements and key navigation."
                },
                "flattenCards": {
                    "type": "boolean",
                    "description": "When true (default: true), identifies composite card containers (article, [role=\"article\"], [role=\"listitem\"], li) and aggregates fragmented leaf nodes into unified structured card summaries while preserving actionable link/click indices. Slashes token usage by 60%+ on eCommerce, search feeds, and news listings."
                }
            },
            "required": []
        }
    },
    "browserpaw_interact_index": {
        "description": "Click, hover, or interact with an element using its compact 1-based numeric index from browserpaw_read_dom. When performing predictable multi-step actions (e.g. form submission or chain navigation), prefer browserpaw_batch_actions to finish in a single round-trip.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "Compact 1-based numeric index of the target element"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Visual fallback coordinates in viewport/CSS pixels: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box (supports 0~1.0 normalized, 0~1000 per-mille, or absolute viewport pixels across modern vision agents)."
                },
                "coordinateSpace": {
                    "type": "string",
                    "enum": [
                        "viewport",
                        "screenshot"
                    ],
                    "description": "Coordinate reference space. \"viewport\" (default) assumes standard CSS viewport pixels. \"screenshot\" scales coordinates through the capture named by captureId and requires that identity."
                },
                "captureId": {
                    "type": "string",
                    "description": "Screenshot identity returned by chrome_screenshot. Required when coordinateSpace is \"screenshot\"; dispatch fails if the document, DOM revision, viewport, DPR, scroll position, or capture identity is stale or superseded."
                },
                "autoSnap": {
                    "type": "boolean",
                    "description": "When clicking via coordinates or visual fallback, magnetically snap to the closest interactive element if clicked within 24px of whitespace. Default: true."
                },
                "points": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Click sequence: dispatch a full CDP click at each point with intervalMs pacing. When captureId is provided, the capture is revalidated before every point; the sequence stops after the first DOM/geometry drift instead of replaying."
                },
                "intervalMs": {
                    "type": "number",
                    "description": "Delay between points in the click sequence, 5-500ms (default 35)"
                },
                "action": {
                    "type": "string",
                    "enum": [
                        "click",
                        "hover",
                        "double_click",
                        "right_click",
                        "drag"
                    ],
                    "description": "Interaction action to perform (default: click). \"drag\" requires `end` and moves from the indexed element to that target."
                },
                "path": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "x": {
                                "type": "number",
                                "description": "X coordinate in viewport/CSS pixels"
                            },
                            "y": {
                                "type": "number",
                                "description": "Y coordinate in viewport/CSS pixels"
                            }
                        },
                        "required": [
                            "x",
                            "y"
                        ]
                    },
                    "description": "Continuous drag path: an ordered array of { x, y } coordinates to smoothly drag the mouse through while pressed. Ideal for circular gestures, sliders, and drawing on canvas."
                },
                "end": {
                    "type": "object",
                    "properties": {
                        "index": {
                            "type": "number",
                            "description": "1-based index (from browserpaw_read_dom) of the drag destination element"
                        },
                        "coordinate": {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate in viewport/CSS pixels"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate in viewport/CSS pixels"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "Drag destination as viewport coordinates when no index is available"
                        }
                    },
                    "description": "Drag destination: { index } for an indexed element, or { coordinate: { x, y } } for a raw point. Required when action is \"drag\"."
                },
                "steps": {
                    "type": "number",
                    "description": "Number of intermediate mouse-move steps for drag (default 48; lower is faster, higher is smoother)"
                },
                "holdMs": {
                    "type": "number",
                    "description": "How long to hold the mouse button before dragging, in ms (default 80, range 0-3000)"
                },
                "dnd": {
                    "type": "boolean",
                    "description": "Use HTML5 drag-and-drop events (dragstart/dragover/drop) instead of raw mouse moves. Needed for React/HTML5 DnD lists."
                },
                "modifiers": {
                    "type": "array",
                    "items": {
                        "type": "string",
                        "enum": [
                            "Alt",
                            "Control",
                            "Meta",
                            "Shift"
                        ]
                    },
                    "description": "Keyboard modifiers to hold during interaction"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM mutations to settle (quiet for 150ms or timeout) after interaction before returning (default: false)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle timeout in milliseconds (default: 1500, range: 200-10000)"
                },
                "humanize": {
                    "type": "boolean",
                    "description": "Simulate realistic human-like cursor trajectory with micro-jitter before clicking (default: false)"
                },
                "includeDelta": {
                    "type": "boolean",
                    "description": "Automatically capture and return DOM changes caused by this interaction in the delta field (default: false)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                },
                "pierceOverlay": {
                    "type": "boolean",
                    "description": "Automatically pierce non-opaque or transient backdrop masks/loading stubs when intercepted (default: true)"
                },
                "waitForNetworkQuiescence": {
                    "type": "boolean",
                    "description": "Wait for in-flight network requests to settle after this interaction before returning (default: false)"
                },
                "quiescenceTimeoutMs": {
                    "type": "number",
                    "description": "Network quiescence timeout in ms (default: 2000)"
                },
                "captureNetwork": {
                    "type": "object",
                    "properties": {
                        "urlPattern": {
                            "type": "string",
                            "description": "URL pattern or substring to match (e.g. \"*/api/order*\", \"/checkout\")"
                        },
                        "method": {
                            "type": "string",
                            "description": "Optional HTTP method to filter by (GET, POST, PUT, DELETE, etc.)"
                        },
                        "timeoutMs": {
                            "type": "number",
                            "description": "Maximum time in milliseconds to wait for the matching network response (default: 5000ms)"
                        },
                        "statusCodes": {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Optional HTTP status codes to accept (e.g. [200, 201])"
                        }
                    },
                    "required": [
                        "urlPattern"
                    ],
                    "description": "Inline capture of network response triggered by this interaction in a single round-trip"
                }
            },
            "required": []
        }
    },
    "browserpaw_fill_index": _CORE_SCHEMAS["chrome_fill_index"],
    "browserpaw_batch_actions": _CORE_SCHEMAS["chrome_batch_actions"],
    "browserpaw_get_markdown": {
        "description": "Extract clean, structured hierarchical markdown from the active tab DOM stripped of SPA state blobs, hidden text, and scripts.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "includeLinks": {
                    "type": "boolean",
                    "description": "Whether to preserve hyperlinks in markdown (default: true)"
                },
                "fit": {
                    "type": "boolean",
                    "description": "Content-only extraction: restrict to the main content region and strip nav/header/footer/aside/form noise before conversion (default: false)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Optional session identifier to bind affinity to a specific tab context"
                }
            },
            "required": []
        }
    },
    "browserpaw_smart_scroll": {
        "description": "Intelligently detects and scrolls the most prominent scrollable container on the page, or targets a specific container by selector, ref, or coordinate with automatic progress calculation.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session ID for tab affinity (optional)"
                },
                "direction": {
                    "type": "string",
                    "enum": [
                        "down",
                        "up",
                        "left",
                        "right"
                    ],
                    "description": "Scroll direction (default: \"down\")"
                },
                "amount": {
                    "type": "string",
                    "description": "Scroll amount: number in pixels, \"page\" (viewport height), or \"half_page\" (default: \"page\")"
                },
                "selector": {
                    "type": "string",
                    "description": "Optional CSS selector of the scroll container to target"
                },
                "ref": {
                    "type": "number",
                    "description": "Optional 1-based numeric index of the scroll container to target"
                },
                "index": {
                    "type": "number",
                    "description": "Alias for ref: 1-based numeric index of the scroll container to target"
                },
                "coordinate": {
                    "oneOf": [
                        {
                            "type": "object",
                            "properties": {
                                "x": {
                                    "type": "number",
                                    "description": "X coordinate"
                                },
                                "y": {
                                    "type": "number",
                                    "description": "Y coordinate"
                                }
                            },
                            "required": [
                                "x",
                                "y"
                            ],
                            "description": "{ x, y } coordinate object"
                        },
                        {
                            "type": "array",
                            "items": {
                                "type": "number"
                            },
                            "description": "Point [x, y] or bounding box [ymin, xmin, ymax, xmax]"
                        }
                    ],
                    "description": "Optional coordinate to locate the scrollable container under pointer: { x, y } object, [x, y] point, or [ymin, xmin, ymax, xmax] bounding box"
                },
                "smooth": {
                    "type": "boolean",
                    "description": "Whether to use smooth scrolling behavior (default: true)"
                },
                "waitForSettle": {
                    "type": "boolean",
                    "description": "Wait for DOM and network activity to settle after scroll completes (default: true)"
                },
                "settleTimeoutMs": {
                    "type": "number",
                    "description": "Maximum settle wait timeout in ms (default: 1500)"
                },
                "note": {
                    "type": "string",
                    "description": "Optional intent note displayed on virtual agent cursor during scrolling (e.g. \"Scrolling down timeline\")"
                }
            },
            "required": []
        }
    },
    "browserpaw_tool_docs": {
        "description": "Return compact parameter documentation for a category of BrowserPaw tools (navigate | perceive | act | observe | manage | crawl | diagnose | network). Use when a workflow needs a tool that is not in the current profile view.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "enum": [
                        "navigate",
                        "perceive",
                        "act",
                        "observe",
                        "manage",
                        "crawl",
                        "diagnose",
                        "network"
                    ],
                    "description": "Tool category to document"
                },
                "activateForSession": {
                    "type": "boolean",
                    "description": "When true, dynamically exposes all tools in this category for the current MCP session without server restart. Default: false"
                }
            },
            "required": [
                "category"
            ]
        }
    },
    "browserpaw_inspect_media": {
        "description": "Inspect and extract high-fidelity media assets (images, canvas, captchas, icons) directly by element index or selector. Uses in-memory lossless extraction for <img>/<canvas>, with super-sampled 200%+ crop fallback for complex DOM containers.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "index": {
                    "type": "number",
                    "description": "1-based element index from browserpaw_read_dom"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector fallback"
                },
                "zoom": {
                    "type": "number",
                    "description": "Super-sampling zoom factor (default: 2.0)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID"
                }
            }
        }
    },
    "browserpaw_grep": {
        "description": "Search the page without dumping full DOM tree. Supports searching interactive elements (returning indices for browserpaw_interact_index), all DOM nodes, or raw visible text lines.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Search term or regex pattern"
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Whether to evaluate query as a regular expression (default: false)"
                },
                "searchType": {
                    "type": "string",
                    "enum": [
                        "interactive_only",
                        "all_dom",
                        "page_text"
                    ],
                    "description": "Search target: \"interactive_only\" (default, matches clickable/fillable elements and returns indices), \"all_dom\" (matches all elements), \"page_text\" (scans visible text lines)."
                },
                "limit": {
                    "type": "number",
                    "description": "Maximum matching results to return (default: 20, max: 50)"
                },
                "autoScroll": {
                    "type": "boolean",
                    "description": "When true, automatically executes client-side RAF auto-scrolling to probe and detect off-screen virtualized elements (virtual list / infinite scroll streams like X/Twitter). Default: false"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum scroll iterations to attempt when autoScroll is enabled (default: 10)"
                },
                "stepPx": {
                    "type": "number",
                    "description": "Pixel distance to scroll on each probing step (default: 800)"
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity (optional)"
                }
            },
            "required": [
                "query"
            ]
        }
    },
    "browserpaw_act_toward_goal": _CORE_SCHEMAS["chrome_act_toward_goal"],
    "browserpaw_scroll_until_found": {
        "description": "Performs client-side step-by-step scrolling until an element matching a text query, regex, or selector is found. Waits for virtual lists (DOM recycling) to settle at each step, searches light and shadow DOM, centers the target in the viewport, and returns its 1-based index and safe coordinates.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Text query or keyword to search for during scrolling"
                },
                "selector": {
                    "type": "string",
                    "description": "CSS selector to search for during scrolling (supports >>> and /deep/ shadow piercing)"
                },
                "role": {
                    "type": "string",
                    "description": "ARIA role to filter matching elements (e.g. \"button\", \"article\", \"link\")."
                },
                "isRegex": {
                    "type": "boolean",
                    "description": "Treat query as a regular expression pattern (default: false)"
                },
                "maxSteps": {
                    "type": "number",
                    "description": "Maximum number of scroll steps before giving up (default: 10, max: 50)"
                },
                "stepPx": {
                    "type": "number",
                    "description": "Scroll distance in pixels per step (default: 800)"
                },
                "direction": {
                    "type": "string",
                    "enum": ["down", "up"],
                    "description": "Scroll direction (default: \"down\")"
                },
                "timeoutMs": {
                    "type": "number",
                    "description": "Timeout in milliseconds for the overall scrolling operation (default: 15000)"
                },
                "containerSelector": {
                    "type": "string",
                    "description": "CSS selector for a custom scrollable container (defaults to window)"
                },
                "actionOnFound": {
                    "type": "string",
                    "enum": [
                        "none",
                        "scroll_into_view",
                        "click",
                        "focus"
                    ],
                    "description": "Action to perform automatically when element is found (default: \"scroll_into_view\")."
                },
                "settleMs": {
                    "type": "number",
                    "description": "Delay in milliseconds to wait for virtual lists / DOM recycling after each scroll (default: 150)"
                },
                "scrollDelayMs": {
                    "type": "number",
                    "description": "Pause duration in ms after each step to allow virtual list rendering (default: 250ms). Alias for settleMs."
                },
                "tabId": {
                    "type": "number",
                    "description": "Target tab ID (optional, defaults to active tab)"
                },
                "windowId": {
                    "type": "number",
                    "description": "Target window ID (optional)"
                },
                "sessionId": {
                    "type": "string",
                    "description": "Session identifier for tab affinity binding"
                },
                "sessionContext": {
                    "type": "string",
                    "description": "Optional alias for sessionId"
                }
            },
            "required": []
        }
    }
}

# Shared native-server scope field; source of truth is packages/shared/src/tools.ts.
_TASK_SCOPE_PROPERTY = {
    "type": "string",
    "description": "Optional durable task identity; restricts this operation to its verified pages.",
}
for _tool_definition in TOOL_DEFINITIONS.values():
    _tool_definition["inputSchema"].setdefault("properties", {}).setdefault(
        "taskId", dict(_TASK_SCOPE_PROPERTY)
    )

_FRAME_SCOPE_PROPERTY = {
    "type": "integer",
    "minimum": 0,
    "description": "Resolve only in this frame, including explicit main frame 0; never cross-frame fallback.",
}
for _tool_name in ("browserpaw_interact_index", "browserpaw_fill_index"):
    TOOL_DEFINITIONS[_tool_name]["inputSchema"]["properties"].setdefault(
        "frameId", dict(_FRAME_SCOPE_PROPERTY)
    )
TOOL_DEFINITIONS["browserpaw_batch_actions"]["inputSchema"]["properties"]["actions"][
    "items"
]["properties"].setdefault(
    "frameId",
    {
        "type": "integer",
        "minimum": 0,
        "description": "Resolve only in this frame; never fall back to a different frame.",
    },
)
_LOCATOR_SCHEMA_FIELDS = {
    "targetText": {"type": "string", "description": "Target element by visible text when text is a fill value."},
    "role": {"type": "string", "description": "Strict target by supported implicit or explicit ARIA role."},
    "label": {"type": "string", "description": "Strict target by associated native or ARIA label."},
    "exact": {"type": "boolean", "description": "Require an exact text, accessible name, or label match."},
}
_batch_properties = TOOL_DEFINITIONS["browserpaw_batch_actions"]["inputSchema"]["properties"]["actions"]["items"]["properties"]
for _field, _schema in _LOCATOR_SCHEMA_FIELDS.items():
    _batch_properties.setdefault(_field, dict(_schema))
TOOL_DEFINITIONS["browserpaw_tool_docs"]["inputSchema"]["properties"]["category"][
    "enum"
].insert(5, "workflow")

def _make_handler(ctx: Any, tool_name: str) -> Callable:
    def handler(args: dict, **kwargs: Any) -> str:
        try:
            arguments = dict(args)
            if tool_name == 'browserpaw_read_dom' and 'isolateModal' not in arguments:
                if ctx.get_config('isolate_modal', False):
                    arguments['isolateModal'] = True
            remote_name = (
                'get_windows_and_tabs' if tool_name == 'browserpaw_get_windows_and_tabs'
                else 'chrome_' + tool_name.removeprefix('browserpaw_')
            )
            timeout = 120
            if tool_name == 'browserpaw_act_toward_goal' and isinstance(arguments, dict):
                raw_timeout = arguments.get('timeoutMs')
                if isinstance(raw_timeout, (int, float)) and not isinstance(raw_timeout, bool):
                    timeout = min(max(120, int(raw_timeout / 1000) + 15), 315)
            envelope = ctx.call_mcp('browserpaw', remote_name, arguments, timeout=timeout)
            output = json.dumps(envelope, ensure_ascii=False)
            result = envelope.get('result')
            error = envelope.get('error')
            media_targets = [m for m in (result, error) if isinstance(m, str)]
            media = []
            for target in media_targets:
                # Hermes masks MEDIA inside JSON strings; expose its cache paths as raw lines.
                media.extend(re.findall(r'(?m)^[ \t]*(MEDIA:[^\r\n]+)', target))
            if media:
                output += '\n' + '\n'.join(media)
            return output
        except Exception as e:
            return json.dumps({'ok': False, 'error': str(e)}, ensure_ascii=False)
    return handler

# ── BROWSERPAW CANONICAL SPECS ───────────────────────────────────────

BROWSERPAW_SPECS: Dict[str, Dict[str, Any]] = {
    "browserpaw_task": {"emoji": "🗂️"},
    "browserpaw_skill": {"emoji": "🧩"},
    "browserpaw_act_toward_goal": {"emoji": "💫"},
    "browserpaw_navigate": {"emoji": "🌐"},
    "browserpaw_read_dom": {"emoji": "🔍"},
    "browserpaw_interact_index": {"emoji": "🎯"},
    "browserpaw_fill_index": {"emoji": "✍️"},
    "browserpaw_batch_actions": {"emoji": "⚡"},
    "browserpaw_screenshot": {"emoji": "📸"},
    "browserpaw_smart_scroll": {"emoji": "📜"},
    "browserpaw_inspect_media": {"emoji": "🖼️"},
    "browserpaw_grep": {"emoji": "🔎"},
    "browserpaw_scroll_until_found": {"emoji": "📜"},
    "browserpaw_get_markdown": {"emoji": "📄"},
    "browserpaw_switch_tab": {"emoji": "🔀"},
    "browserpaw_close_tabs": {"emoji": "❌"},
    "browserpaw_get_windows_and_tabs": {"emoji": "🪟"},
    "browserpaw_tool_docs": {"emoji": "📚"},
}


def register(ctx: Any) -> None:
    _register_bundled_skill(ctx)

    for tool_name, meta in TOOL_DEFINITIONS.items():
        spec = BROWSERPAW_SPECS.get(tool_name, {})
        emoji = spec.get("emoji", "🌐")
        schema = {
            'name': tool_name,
            'description': meta['description'],
            'parameters': meta['inputSchema'],
        }
        handler = _make_handler(ctx, tool_name)
        if hasattr(ctx, 'register_tool'):
            ctx.register_tool(
                name=tool_name,
                toolset='browserpaw',
                schema=schema,
                handler=handler,
                description=meta['description'],
                emoji=emoji,
            )
