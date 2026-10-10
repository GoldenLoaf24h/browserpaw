export enum NativeMessageType {
  START = 'start',
  STARTED = 'started',
  STOP = 'stop',
  STOPPED = 'stopped',
  PING = 'ping',
  PONG = 'pong',
  ERROR = 'error',
  PROCESS_DATA = 'process_data',
  PROCESS_DATA_RESPONSE = 'process_data_response',
  CALL_TOOL = 'call_tool',
  CALL_TOOL_RESPONSE = 'call_tool_response',
  // Additional message types used in Chrome extension
  SERVER_STARTED = 'server_started',
  SERVER_STOPPED = 'server_stopped',
  ERROR_FROM_NATIVE_HOST = 'error_from_native_host',
  CONNECT_NATIVE = 'connectNative',
  ENSURE_NATIVE = 'ensure_native',
  PING_NATIVE = 'ping_native',
  DISCONNECT_NATIVE = 'disconnect_native',
}

export interface NativeMessage<P = any, E = any> {
  type?: NativeMessageType;
  responseToRequestId?: string;
  payload?: P;
  error?: E;
}

// ============================================================
// browser-use DOM Engine & Batch Pipeline Types
// ============================================================

export interface IndexedElement {
  index: number;
  tagName: string;
  role?: string;
  text?: string;
  value?: string;
  attributes: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  isInteractive: boolean;
  backendNodeId?: number;
  isOccluded?: boolean;
  occludedBy?: string;
  /** True when the element was reached by piercing one or more shadow roots */
  inShadowDom?: boolean;
  safeClickPoint?: { x: number; y: number };
  /** True when element is a rich text compose box (Twitter composer, Draft.js, Lexical, multi-line comment/post area) */
  isComposer?: boolean;
  /** True when element is a rich code or text editor (ProseMirror, Quill, Monaco, CodeMirror) */
  isEditor?: boolean;
  /** True when element is a search input or searchbox */
  isSearch?: boolean;
  /** True when element is a Web Component host with closed/encapsulated shadow root */
  isClosedShadowHost?: boolean;
  /** True when element is an actionable trigger inside a composite card (reply, like, retweet, etc.) */
  isActionTrigger?: boolean;
  actionTriggerType?: string;
}

export interface ScrollInfo {
  pages_up: number;
  pages_down: number;
  scroll_y?: number;
  total_height?: number;
  viewport_height?: number;
}

export interface PageAsset {
  /** 1-based, stable within one read_dom snapshot */
  index: number;
  kind: 'img' | 'canvas' | 'video' | 'bg-image';
  /** CSS-space viewport bbox (x,y relative to current scroll) */
  rect: { x: number; y: number; width: number; height: number };
  /** Resource URL when the asset has one (img src / bg-image url). Empty for canvas/video */
  src?: string;
  alt?: string;
}

export interface PrunedDOMTreeResult {
  treeString: string;
  elementCount: number;
  interactiveCount: number;
  compressionRatio: number;
  indexMap: Record<
    number,
    { selector?: string; backendNodeId?: number; frameId?: string; tagName?: string }
  >;
  indexedElements?: IndexedElement[];
  /** Visual assets on the page (img/canvas/video/CSS background images) with viewport geometry */
  assets?: PageAsset[];
  pages_up?: number;
  pages_down?: number;
  scrollInfo?: ScrollInfo;
  /** Selector-ish description of the top-most open modal dialog, if any */
  activeModal?: string;
  /** True when an open modal is trapping focus on the page */
  focusTrapped?: boolean;
  /** True when an active modal is a secondary confirmation prompt (e.g. "Discard draft?", "Discard post?") */
  isConfirmationTrap?: boolean;
  /** True if a container matching the requested selector was found */
  selectorMatched?: boolean;
  /** True if DOM indexing was scoped to an active modal and its whitelisted containers */
  modalIsolated?: boolean;
  /** Total number of repetitive off-viewport nodes pruned/folded into virtualized summaries */
  virtualizedCount?: number;
  /** Summary of virtualized clusters folded during viewport pruning */
  virtualizedSummary?: Array<{ selector: string; count: number }>;
  /** Total number of composite cards flattened into single structured summaries */
  flattenedCardCount?: number;
}

export interface PageSettleResult {
  settled: boolean;
  durationMs: number;
  mutationsObserved: number;
  /** True when network requests reached quiescence during wait */
  networkSettled?: boolean;
  /** Details of active confirmation trap dialog detected during settle, if any */
  confirmationTrap?: { detected: boolean; title?: string };
}

export interface SessionTabAffinityContext {
  sessionId?: string;
  sessionContext?: string;
}

export interface BatchActionItem {
  type:
    | 'click'
    | 'double_click'
    | 'right_click'
    | 'fill'
    | 'hover'
    | 'scroll'
    | 'press_key'
    | 'wait'
    | 'key'
    | 'fill_form'
    | 'assert'
    | 'extract';
  index?: number;
  ref?: string | number;
  selector?: string;
  // Absolute epoch-ms deadline: sleep until this instant before executing this action
  at?: number;
  text?: string;
  value?: string;
  key?: string;
  x?: number;
  y?: number;
  coordinate?: { x: number; y: number };
  fields?: FillFormField[];
  durationMs?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  amount?: number;
  clear?: boolean;
  pressEnter?: boolean;
  submit?: boolean;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  /** Wait for in-flight network requests to reach quiescence before proceeding */
  waitForNetworkQuiescence?: boolean;
  /** Quiescence timeout in ms (default 2000) */
  quiescenceTimeoutMs?: number;
  /** Automatically pierce non-opaque or transient backdrop masks for click */
  pierceOverlay?: boolean;
  /** Prioritize rich composer/editor elements when resolving textbox */
  preferComposer?: boolean;
  // For type: 'assert'
  expectedText?: string;
  condition?:
    | 'contains'
    | 'not_contains'
    | 'equals'
    | 'matches'
    | 'visible'
    | 'not_visible'
    | 'enabled'
    | 'disabled'
    | 'valid'
    | 'invalid'
    | 'checked'
    | 'unchecked';
  timeoutMs?: number;
  abortOnFailure?: boolean;
  // Inline network capture
  captureNetwork?: CaptureNetworkOptions;
  // For type: 'extract'
  property?: 'text' | 'value' | 'attribute';
  attributeName?: string;
  variableName?: string;
}

export interface CaptureNetworkOptions {
  urlPattern: string;
  method?: string;
  timeoutMs?: number;
  statusCodes?: number[];
}

export interface CapturedNetworkResult {
  url: string;
  status: number;
  data: any;
  mimeType?: string;
  durationMs?: number;
  error?: string;
}

export interface BatchActionResult {
  success: boolean;
  completedActions: number;
  totalActions: number;
  extractedData?: Record<string, string>;
  assertions?: Array<{ actionIndex: number; passed: boolean; condition?: string; error?: string }>;
  delta?: any;
  results: Array<{ actionIndex: number; success: boolean; error?: string; output?: any }>;
  interruptedReason?: string;
  settle?: PageSettleResult;
  urlChanged?: boolean;
  previousUrl?: string;
  currentUrl?: string;
  networkResult?: CapturedNetworkResult;
}

export interface ReadDOMParams {
  viewportThreshold?: number;
  tabId?: number;
  windowId?: number;
  highlight?: boolean;
  sessionId?: string;
  sessionContext?: string;
  cursor?: number;
  limit?: number;
  deltaOnly?: boolean;
  maxTextLength?: number;
  format?: 'compact' | 'html' | 'fast';
  fast?: boolean;
  legacyVisibility?: boolean;
  viewportOnly?: boolean;
  selector?: string;
  scope?: string;
  exclude?: string | string[];
  includeDetails?: boolean;
  isolateModal?: boolean;
  dismissOverlays?: boolean;
}

export interface NavigateParams {
  url?: string;
  tabId?: number;
  windowId?: number;
  newWindow?: boolean;
  background?: boolean;
  refresh?: boolean;
  sessionId?: string;
  sessionContext?: string;
  groupTitle?: string;
  groupColor?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  autoGroup?: boolean;
  dismissOverlays?: boolean;
}

export interface DismissOverlayParams {
  tabId?: number;
  windowId?: number;
  maxOverlays?: number;
  waitForSettle?: boolean;
  sessionId?: string;
  sessionContext?: string;
}

export interface DismissOverlaysResult {
  dismissedCount: number;
  overlays: Array<{
    id?: string;
    className?: string;
    role?: string;
    title?: string;
    buttonText?: string;
    buttonSelector?: string;
    action: 'clicked_close_button' | 'dispatched_escape';
    x?: number;
    y?: number;
  }>;
}

export interface AttachTabParams {
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export interface DetachTabParams {
  tabId?: number;
  sessionId?: string;
  sessionContext?: string;
}

export interface FillFormField {
  ref?: string | number;
  index?: number;
  selector?: string;
  value?: string | number | boolean;
  text?: string;
  clear?: boolean;
}

export interface FillFormParams {
  fields: FillFormField[];
  tabId?: number;
  windowId?: number;
  waitForSettle?: boolean;
  settleTimeoutMs?: number;
  sessionId?: string;
  sessionContext?: string;
}

export interface UnifiedLocatorOptions {
  ref?: string | number;
  index?: number;
  selector?: string;
  selectorType?: 'css' | 'xpath';
  text?: string;
  targetText?: string;
  role?: string;
  coordinate?: { x: number; y: number };
  coordinates?: { x: number; y: number };
  /** Coordinate space of coordinate/coordinates: "viewport" (default) or "screenshot" (scale via last screenshot context) */
  coordinateSpace?: 'viewport' | 'screenshot';
  /** Prioritize rich composer/editor elements over generic search inputs when resolving role=textbox or fill targets */
  preferComposer?: boolean;
}

export interface UnifiedLocatorResult {
  success: boolean;
  x: number;
  y: number;
  resolutionPath: 'ref' | 'selector' | 'text' | 'role' | 'coordinate';
  index?: number;
  tagName?: string;
  inputType?: string;
  text?: string;
  value?: string;
  role?: string;
  isClickable?: boolean;
  frameId?: number;
  frameOffsetX?: number;
  frameOffsetY?: number;
  attributes?: Record<string, string>;
  isComposer?: boolean;
  isEditor?: boolean;
  isSearch?: boolean;
  error?: string;
  warning?: string;
  isSelectOption?: boolean;
  scopeHash?: string;
}

export interface ScrollUntilFoundOptions {
  query?: string;
  selector?: string;
  role?: string;
  actionOnFound?: 'none' | 'scroll_into_view' | 'click' | 'focus';
  isRegex?: boolean;
  maxSteps?: number;
  stepPx?: number;
  direction?: 'down' | 'up';
  timeoutMs?: number;
  containerSelector?: string;
  settleMs?: number;
}

export interface ScrollUntilFoundResult {
  found: boolean;
  index?: number;
  tagName?: string;
  text?: string;
  stepsTaken: number;
  scrolledPx: number;
  coordinates?: { x: number; y: number };
  message: string;
}
