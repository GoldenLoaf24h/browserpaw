import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_NAME_TO_CATEGORY, TOOL_SCHEMAS } from 'chrome-mcp-shared';
import type { SkillDefinition } from './browser-skills';

type JsonObject = Record<string, unknown>;

export interface BrowserApiCallResult extends CallToolResult {
  text?: string;
  data?: unknown;
}

export interface BrowserApiCallOptions {
  signal?: AbortSignal;
}

export type BrowserApiCall = (
  name: string,
  args?: Record<string, unknown>,
  options?: BrowserApiCallOptions,
) => Promise<BrowserApiCallResult>;

export type BrowserApiTools = () => Promise<Tool[]>;

export interface TaskStartOptions {
  name: string;
  goal?: string;
}

export interface TaskFinishOptions {
  keep?: number[];
  keepUnknownPages?: boolean;
  confirm?: boolean;
}

export interface TaskResumeOptions {
  adopt?: boolean;
}

export interface TaskHandle {
  readonly id: string;
  open(url: string): Promise<Page>;
  borrow(tabId: number): Promise<Page>;
  finish(options?: TaskFinishOptions): Promise<BrowserApiCallResult>;
  cancel(): Promise<BrowserApiCallResult>;
  status(): Promise<BrowserApiCallResult>;
  handOff(tabId: number): Promise<BrowserApiCallResult>;
}

export interface GotoOptions {
  refresh?: boolean;
  dismissOverlays?: boolean;
  groupTitle?: string;
  groupColor?: 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';
  autoGroup?: boolean;
}

export interface ObserveOptions {
  selector?: string;
  scope?: string;
  isolateModal?: boolean;
  exclude?: string | string[];
  viewportThreshold?: number;
  highlight?: boolean;
  cursor?: number;
  limit?: number;
  maxTextLength?: number;
  includeDetails?: boolean;
  viewportOnly?: boolean;
  activeViewportOnly?: boolean;
  format?: 'compact' | 'html' | 'fast';
  fast?: boolean;
  legacyVisibility?: boolean;
  deltaOnly?: boolean;
  dismissOverlays?: boolean;
  virtualizeViewport?: boolean;
  flattenCards?: boolean;
}

export interface ScreenshotOptions {
  name?: string;
  selector?: string;
  assetIndex?: number;
  background?: boolean;
  width?: number;
  height?: number;
  maxWidth?: number;
  maxDimension?: number;
  maxPixels?: number;
  storeBase64?: boolean;
  fullPage?: boolean;
  maxHeight?: number;
  savePng?: boolean;
  saveToDisk?: boolean;
  som?: boolean;
  highlight?: boolean;
  targetIndex?: number;
  index?: number;
  padding?: number;
  region?: { x0: number; y0: number; x1: number; y1: number };
  crop?: JsonObject;
  grid?: boolean;
  enableGrid?: boolean;
  expandSearchArea?: boolean;
  format?: 'png' | 'jpeg';
  quality?: number;
  highClarity?: boolean;
}

export interface EvaluateOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export type DownloadOptions = {
  filenameContains?: string;
  timeoutMs?: number;
  waitForComplete?: boolean;
} & ({ guid: string; clickTargetIndex?: never } | { clickTargetIndex: number; guid?: never });

export interface LocatorClickOptions {
  button?: 'left' | 'right';
  clickCount?: 1 | 2;
}

export interface LocatorFillOptions {
  clear?: boolean;
}

export interface LocatorPressOptions {
  delay?: number;
}

export interface LocatorWaitForOptions {
  state?: 'visible' | 'hidden';
  timeoutMs?: number;
}

export interface GetByTextOptions {
  exact?: boolean;
}

export interface GetByRoleOptions {
  name?: string;
  exact?: boolean;
}

export interface GetByLabelOptions {
  exact?: boolean;
}

export interface Locator {
  readonly selector?: string;
  readonly ref?: number;
  readonly text?: string;
  readonly role?: string;
  readonly label?: string;
  readonly exact?: boolean;
  click(options?: LocatorClickOptions): Promise<BrowserApiCallResult>;
  fill(value: string, options?: LocatorFillOptions): Promise<BrowserApiCallResult>;
  press(keys: string, options?: LocatorPressOptions): Promise<BrowserApiCallResult>;
  waitFor(options?: LocatorWaitForOptions): Promise<BrowserApiCallResult>;
}

export interface Page {
  readonly tabId: number;
  readonly taskId: string;
  readonly frameId?: number;
  goto(url: string, options?: GotoOptions): Promise<BrowserApiCallResult>;
  observe(options?: ObserveOptions): Promise<BrowserApiCallResult>;
  screenshot(options?: ScreenshotOptions): Promise<BrowserApiCallResult>;
  download(options: DownloadOptions): Promise<BrowserApiCallResult>;
  evaluate(code: string, options?: EvaluateOptions): Promise<BrowserApiCallResult>;
  frame(frameId: number): Page;
  locator(selectorOrRef: string | number): Locator;
  getByText(text: string, options?: GetByTextOptions): Locator;
  getByRole(role: string, options?: GetByRoleOptions): Locator;
  getByLabel(label: string, options?: GetByLabelOptions): Locator;
}

export interface SkillRunOptions {
  taskId?: string;
  signal?: AbortSignal;
  version?: number;
  definitionHash?: string;
}

export interface SkillValidateOptions {
  signal?: AbortSignal;
}

export interface HelpEntry {
  method: string;
  source: string;
  tool: string;
  category: string;
  description: string;
  signature: string;
  schema?: Record<string, unknown>;
}

export interface BrowserApi {
  task: {
    start(options: TaskStartOptions): Promise<TaskHandle>;
    list(options?: Record<string, never>): Promise<BrowserApiCallResult>;
    resume(taskId: string, options?: TaskResumeOptions): Promise<TaskHandle>;
    takeOver(taskId: string, options: { confirm: true }): Promise<TaskHandle>;
    get(taskId: string): Promise<TaskHandle>;
  };
  skills: {
    find(url: string, intent?: string): Promise<BrowserApiCallResult>;
    list(options?: Record<string, never>): Promise<BrowserApiCallResult>;
    get(id: string, version?: number): Promise<BrowserApiCallResult>;
    propose(definition: SkillDefinition): Promise<BrowserApiCallResult>;
    validate(
      id: string,
      version?: number,
      options?: SkillValidateOptions,
    ): Promise<BrowserApiCallResult>;
    run(
      id: string,
      inputs?: Record<string, unknown>,
      options?: SkillRunOptions,
    ): Promise<BrowserApiCallResult>;
    disable(id: string): Promise<BrowserApiCallResult>;
    rollback(id: string, version: number): Promise<BrowserApiCallResult>;
  };
  help(): HelpEntry[];
  help(name: string): HelpEntry | Promise<HelpEntry>;
}

const CONTROLLED_TOOL_OPTIONS = new Set([
  'taskId',
  'tabId',
  'windowId',
  'sessionId',
  'sessionContext',
  'frameId',
]);
const LOCATOR_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'searchbox',
  'checkbox',
  'radio',
  'heading',
  'option',
  'tab',
  'menuitem',
  'switch',
]);

const TASK_START_FIELDS = new Set(['name', 'goal']);
const TASK_RESUME_FIELDS = new Set(['adopt']);
const TASK_TAKE_OVER_FIELDS = new Set(['confirm']);
const TASK_FINISH_FIELDS = new Set(['keep', 'keepUnknownPages', 'confirm']);
const CLICK_FIELDS = new Set(['button', 'clickCount']);
const FILL_FIELDS = new Set(['clear']);
const PRESS_FIELDS = new Set(['delay']);
const WAIT_FIELDS = new Set(['state', 'timeoutMs']);
const EVALUATE_FIELDS = new Set(['timeoutMs', 'maxOutputBytes']);
const GET_BY_TEXT_FIELDS = new Set(['exact']);
const GET_BY_ROLE_FIELDS = new Set(['name', 'exact']);
const GET_BY_LABEL_FIELDS = new Set(['exact']);
const SKILL_VALIDATE_FIELDS = new Set(['signal']);
const SKILL_RUN_FIELDS = new Set(['taskId', 'signal', 'version', 'definitionHash']);
const GOTO_REJECTED_FIELDS = new Set(['newTab', 'newWindow', 'background']);
const CLICK_BUTTONS = ['left', 'right'] as const;
const CLICK_COUNTS = [1, 2] as const;
const WAIT_STATES = ['visible', 'hidden'] as const;

function hasChoice<T extends string | number>(value: unknown, choices: readonly T[]): value is T {
  return choices.some((choice) => choice === value);
}

const TOOL_SCHEMA_BY_NAME = new Map(TOOL_SCHEMAS.map((tool) => [tool.name, tool]));

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resultText(result: CallToolResult): string {
  return (result.content || [])
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

function parseData(result: BrowserApiCallResult): unknown {
  if (result.data !== undefined) return result.data;
  if (isRecord(result.structuredContent)) return result.structuredContent;
  const text = result.text || resultText(result);
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isUnknownOutcome(data: unknown): boolean {
  if (!isRecord(data)) return false;
  const status = typeof data.status === 'string' ? data.status.toLowerCase() : '';
  const outcome = typeof data.outcome === 'string' ? data.outcome.toLowerCase() : '';
  if (status === 'unknown' || outcome === 'unknown' || data.uncertain === true) return true;
  return (
    Array.isArray(data.results) &&
    data.results.some((item) => isRecord(item) && item.status === 'unknown')
  );
}

function callError(message: string, result: BrowserApiCallResult): Error {
  const error = new Error(message);
  (error as Error & { result?: BrowserApiCallResult }).result = result;
  return error;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function requiredPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : requiredPositiveInteger(value, field);
}

function optionalAbortSignal(value: unknown, field: string): AbortSignal | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as AbortSignal).aborted !== 'boolean' ||
    typeof (value as AbortSignal).addEventListener !== 'function'
  ) {
    throw new Error(`${field} must be an AbortSignal`);
  }
  return value as AbortSignal;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function validateObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function validateOptions(value: unknown, label: string, allowed: ReadonlySet<string>): JsonObject {
  if (value === undefined) return {};
  const options = validateObject(value, `${label} options`);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) throw new Error(`Unknown option "${key}" for ${label}`);
  }
  return options;
}

function validateNoOptions(value: unknown, label: string): void {
  validateOptions(value, label, new Set());
}

type JsonSchema = Record<string, unknown>;

interface MethodDoc {
  method: string;
  source: string;
  tool: string;
  category: string;
  description: string;
  signature: string;
  schema: () => JsonSchema;
}

function toolProperties(toolName: string, nestedAction = false): Record<string, unknown> {
  const tool = TOOL_SCHEMA_BY_NAME.get(toolName);
  if (!tool) throw new Error(`Unknown tool schema: ${toolName}`);
  const root = isRecord(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  if (!nestedAction) return root;
  const actions = root.actions;
  if (!isRecord(actions) || !isRecord(actions.items) || !isRecord(actions.items.properties)) {
    throw new Error(`No action schema for ${toolName}`);
  }
  return actions.items.properties;
}

function sharedField(
  toolName: string,
  key: string,
  nestedAction = false,
  extra?: Record<string, unknown>,
): JsonSchema {
  const property = toolProperties(toolName, nestedAction)[key];
  if (!isRecord(property)) throw new Error(`No ${toolName} schema property "${key}"`);
  if (!extra) return property;
  const copy: JsonSchema = { ...property, ...extra };
  for (const [extraKey, value] of Object.entries(extra)) {
    if (value === undefined) delete copy[extraKey];
  }
  return copy;
}

function allowedToolFields(
  toolName: string,
  extraForbidden: ReadonlySet<string> = new Set(),
): Set<string> {
  return new Set(
    Object.keys(toolProperties(toolName)).filter(
      (key) => !CONTROLLED_TOOL_OPTIONS.has(key) && !extraForbidden.has(key),
    ),
  );
}

function validateToolOptions(
  toolName: string,
  value: unknown,
  extraForbidden: ReadonlySet<string> = new Set(),
): JsonObject {
  return validateOptions(value, toolName, allowedToolFields(toolName, extraForbidden));
}

function objectSchema(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  extra?: Record<string, unknown>,
): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required: [...required] } : {}),
    ...extra,
  };
}

function optionSchema(
  fields: ReadonlySet<string>,
  properties: Record<string, unknown>,
  required: readonly string[] = [],
  extra?: Record<string, unknown>,
): JsonSchema {
  const keys = Object.keys(properties);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new Error(`Option schema drifted from allowlist: ${keys.join(', ')}`);
  }
  return objectSchema(properties, required, extra);
}

function fieldsSchema(
  toolName: string,
  fields: ReadonlySet<string>,
  required: readonly string[] = [],
  extras: Record<string, Record<string, unknown>> = {},
  nestedAction = false,
): JsonSchema {
  const properties: Record<string, unknown> = {};
  for (const key of fields) properties[key] = sharedField(toolName, key, nestedAction, extras[key]);
  return optionSchema(fields, properties, required);
}

function positional(requiredCount: number, ...args: JsonSchema[]): JsonSchema {
  return {
    type: 'array',
    description: 'Positional JavaScript arguments in call order. Do not pass one object envelope.',
    minItems: requiredCount,
    maxItems: args.length,
    items: args,
  };
}

function cloneSchema(schema: JsonSchema): JsonSchema {
  return structuredClone(schema);
}

function methodDoc(
  method: string,
  tool: string,
  description: string,
  signature: string,
  schema: () => JsonSchema,
  category?: string,
): MethodDoc {
  const resolved = category ?? TOOL_NAME_TO_CATEGORY[tool];
  if (!resolved) throw new Error(`No help category for ${method}`);
  return { method, source: tool, tool, category: resolved, description, signature, schema };
}

const SIGNAL_SCHEMA: JsonSchema = {
  description: 'AbortSignal. It cancels the in-flight MCP request and is not a tool field.',
};

function numberArray(value: unknown, field: string): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of positive integers`);
  return value.map((item, index) => requiredPositiveInteger(item, `${field}[${index}]`));
}

function taskFromResult(result: BrowserApiCallResult, action: string): JsonObject {
  const data = parseData(result);
  if (!isRecord(data) || !isRecord(data.task)) {
    throw callError(`chrome_task ${action} returned no task`, result);
  }
  requiredString(data.task.id, `chrome_task ${action} task.id`);
  return data.task;
}

function currentTabId(task: JsonObject, action: string): number {
  return requiredPositiveInteger(task.currentTabId, `chrome_task ${action} task.currentTabId`);
}

function createToolInvoker(call: BrowserApiCall) {
  return async (
    name: string,
    args: Record<string, unknown> = {},
    options?: BrowserApiCallOptions,
  ) => {
    const raw = options ? await call(name, args, options) : await call(name, args);
    const data = parseData(raw);
    const enriched = Object.assign(raw, { data, text: raw.text || resultText(raw) });
    if (raw.isError) {
      throw callError(enriched.text || `Browser tool failed: ${name}`, enriched);
    }
    if (isUnknownOutcome(data)) {
      throw callError(
        `Browser tool outcome unknown; do not replay ${name}: ${enriched.text || 'unknown result'}`,
        enriched,
      );
    }
    return enriched;
  };
}

function makePage(
  invoke: (name: string, args?: Record<string, unknown>) => Promise<BrowserApiCallResult>,
  taskId: string,
  tabId: number,
  frameId?: number,
): Page {
  const requireMainPage = (operation: string) => {
    if (frameId !== undefined) {
      throw new Error(
        `${operation} is not supported on page.frame(${frameId}); use a main-page target`,
      );
    }
  };

  type LocatorTarget = {
    selector?: string;
    ref?: number;
    text?: string;
    role?: string;
    label?: string;
    exact?: boolean;
  };

  const targetForTool = (target: LocatorTarget, textField: 'text' | 'targetText'): JsonObject => {
    if (target.selector !== undefined) return { selector: target.selector };
    if (target.ref !== undefined) return { ref: target.ref };
    return {
      ...(target.text !== undefined ? { [textField]: target.text } : {}),
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.label !== undefined ? { label: target.label } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
    };
  };

  const makeLocator = (target: LocatorTarget): Locator => {
    return {
      ...(target.selector !== undefined ? { selector: target.selector } : {}),
      ...(target.ref !== undefined ? { ref: target.ref } : {}),
      ...(target.text !== undefined ? { text: target.text } : {}),
      ...(target.role !== undefined ? { role: target.role } : {}),
      ...(target.label !== undefined ? { label: target.label } : {}),
      ...(target.exact !== undefined ? { exact: target.exact } : {}),
      async click(options?: LocatorClickOptions) {
        const validated = validateOptions(options, 'locator.click', CLICK_FIELDS);
        const button = validated.button ?? 'left';
        const clickCount = validated.clickCount ?? 1;
        if (!hasChoice(button, CLICK_BUTTONS)) {
          throw new Error('locator.click button must be "left" or "right"');
        }
        if (!hasChoice(clickCount, CLICK_COUNTS)) {
          throw new Error('locator.click clickCount must be 1 or 2');
        }
        if (button === 'right' && clickCount === 2) {
          throw new Error('Right-button double click is not supported by chrome_batch_actions');
        }
        const action =
          clickCount === 2 ? 'double_click' : button === 'right' ? 'right_click' : 'click';
        return invoke('chrome_batch_actions', {
          taskId,
          tabId,
          ...(frameId !== undefined ? { frameId } : {}),
          actions: [
            {
              type: action,
              ...targetForTool(target, 'text'),
              ...(frameId !== undefined ? { frameId } : {}),
            },
          ],
        });
      },
      async fill(value: string, options?: LocatorFillOptions) {
        if (typeof value !== 'string') throw new Error('locator.fill value must be a string');
        const validated = validateOptions(options, 'locator.fill', FILL_FIELDS);
        const clear = validated.clear ?? true;
        if (typeof clear !== 'boolean') throw new Error('locator.fill clear must be boolean');
        return invoke('chrome_batch_actions', {
          taskId,
          tabId,
          ...(frameId !== undefined ? { frameId } : {}),
          actions: [
            {
              type: 'fill',
              ...targetForTool(target, 'targetText'),
              value,
              clear,
              ...(frameId !== undefined ? { frameId } : {}),
            },
          ],
        });
      },
      async press(keys: string, options?: LocatorPressOptions) {
        const keyText = requiredString(keys, 'locator.press keys');
        const validated = validateOptions(options, 'locator.press', PRESS_FIELDS);
        if (
          validated.delay !== undefined &&
          (typeof validated.delay !== 'number' || validated.delay < 0)
        ) {
          throw new Error('locator.press delay must be a non-negative number');
        }
        return invoke('chrome_keyboard', {
          taskId,
          tabId,
          ...(frameId !== undefined ? { frameId } : {}),
          ...(target.ref !== undefined ? { index: target.ref } : targetForTool(target, 'text')),
          keys: keyText,
          ...(validated.delay !== undefined ? { delay: validated.delay } : {}),
        });
      },
      async waitFor(options?: LocatorWaitForOptions) {
        const validated = validateOptions(options, 'locator.waitFor', WAIT_FIELDS);
        const state = validated.state ?? 'visible';
        if (!hasChoice(state, WAIT_STATES)) {
          throw new Error('locator.waitFor state must be "visible" or "hidden"');
        }
        const timeoutMs = optionalPositiveInteger(validated.timeoutMs, 'locator.waitFor timeoutMs');
        return invoke('chrome_batch_actions', {
          taskId,
          tabId,
          ...(frameId !== undefined ? { frameId } : {}),
          actions: [
            {
              type: 'assert',
              ...targetForTool(target, 'text'),
              condition: state === 'hidden' ? 'not_visible' : 'visible',
              ...(timeoutMs !== undefined ? { timeoutMs } : {}),
              abortOnFailure: true,
              ...(frameId !== undefined ? { frameId } : {}),
            },
          ],
        });
      },
    };
  };

  return {
    tabId,
    taskId,
    ...(frameId !== undefined ? { frameId } : {}),
    async goto(url: string, options?: GotoOptions) {
      requireMainPage('goto');
      const target = requiredString(url, 'page.goto url');
      const validated = validateToolOptions('chrome_navigate', options, GOTO_REJECTED_FIELDS);
      return invoke('chrome_navigate', { ...validated, taskId, tabId, url: target });
    },
    async observe(options?: ObserveOptions) {
      requireMainPage('observe');
      const validated = validateToolOptions('chrome_read_dom', options);
      return invoke('chrome_read_dom', { ...validated, taskId, tabId });
    },
    async screenshot(options?: ScreenshotOptions) {
      requireMainPage('screenshot');
      const validated = validateToolOptions('chrome_screenshot', options);
      return invoke('chrome_screenshot', { ...validated, taskId, tabId });
    },
    async download(options: DownloadOptions) {
      const validated = validateToolOptions('chrome_handle_download', options);
      if ((validated.guid !== undefined) === (validated.clickTargetIndex !== undefined)) {
        throw new Error('page.download requires exactly one observed guid or clickTargetIndex');
      }
      if (validated.guid !== undefined) requireMainPage('download by GUID');
      return invoke('chrome_handle_download', {
        ...validated,
        taskId,
        tabId,
        ...(frameId !== undefined ? { frameId } : {}),
      });
    },
    async evaluate(code: string, options?: EvaluateOptions) {
      const source = requiredString(code, 'page.evaluate code');
      const validated = validateOptions(options, 'page.evaluate', EVALUATE_FIELDS);
      for (const field of ['timeoutMs', 'maxOutputBytes'] as const) {
        if (
          validated[field] !== undefined &&
          (typeof validated[field] !== 'number' || validated[field] <= 0)
        ) {
          throw new Error(`page.evaluate ${field} must be a positive number`);
        }
      }
      const result = await invoke('chrome_javascript', {
        taskId,
        tabId,
        code: source,
        ...(frameId !== undefined ? { frameId } : {}),
        ...validated,
      });
      if (isRecord(result.data) && typeof result.data.result === 'string') {
        try {
          result.data = { ...result.data, result: JSON.parse(result.data.result) };
        } catch {
          // Native JavaScript results may be plain strings; only JSON strings are decoded once here.
        }
      }
      return result;
    },
    frame(nextFrameId: number) {
      return makePage(invoke, taskId, tabId, nonNegativeInteger(nextFrameId, 'frameId'));
    },
    locator(selectorOrRef: string | number) {
      if (typeof selectorOrRef === 'string') {
        return makeLocator({ selector: requiredString(selectorOrRef, 'locator selector') });
      }
      return makeLocator({ ref: requiredPositiveInteger(selectorOrRef, 'locator ref') });
    },
    getByText(text: string, options?: GetByTextOptions) {
      const validated = validateOptions(options, 'page.getByText', GET_BY_TEXT_FIELDS);
      if (validated.exact !== undefined && typeof validated.exact !== 'boolean') {
        throw new Error('page.getByText exact must be boolean');
      }
      return makeLocator({
        text: requiredString(text, 'page.getByText text'),
        exact: validated.exact === true,
      });
    },
    getByRole(role: string, options?: GetByRoleOptions) {
      const validated = validateOptions(options, 'page.getByRole', GET_BY_ROLE_FIELDS);
      if (validated.exact !== undefined && typeof validated.exact !== 'boolean') {
        throw new Error('page.getByRole exact must be boolean');
      }
      const normalizedRole = requiredString(role, 'page.getByRole role').toLowerCase();
      if (!LOCATOR_ROLES.has(normalizedRole)) {
        throw new Error(
          `Unsupported role locator "${role}". Supported roles: ${Array.from(LOCATOR_ROLES).join(', ')}`,
        );
      }
      const name =
        validated.name === undefined
          ? undefined
          : requiredString(validated.name, 'page.getByRole name');
      return makeLocator({
        role: normalizedRole,
        ...(name !== undefined ? { text: name } : {}),
        exact: validated.exact === true,
      });
    },
    getByLabel(label: string, options?: GetByLabelOptions) {
      const validated = validateOptions(options, 'page.getByLabel', GET_BY_LABEL_FIELDS);
      if (validated.exact !== undefined && typeof validated.exact !== 'boolean') {
        throw new Error('page.getByLabel exact must be boolean');
      }
      return makeLocator({
        label: requiredString(label, 'page.getByLabel label'),
        exact: validated.exact === true,
      });
    },
  };
}

function methodDocs(): MethodDoc[] {
  const text = (description: string): JsonSchema => ({
    type: 'string',
    minLength: 1,
    description,
  });
  return [
    methodDoc(
      'task.start',
      'chrome_task',
      'Start a durable task',
      'task.start({ name: string, goal?: string })',
      () =>
        fieldsSchema('chrome_task', TASK_START_FIELDS, ['name'], {
          name: { minLength: 1 },
          goal: { minLength: 1 },
        }),
    ),
    methodDoc('task.list', 'chrome_task', 'List durable tasks', 'task.list()', () =>
      objectSchema({}),
    ),
    methodDoc(
      'task.resume',
      'chrome_task',
      'Resume and verify a durable task; adopt:true accepts only the observed pending source document',
      'task.resume(taskId: string, options?)',
      () =>
        positional(
          1,
          sharedField('chrome_task', 'taskId', false, { minLength: 1 }),
          fieldsSchema('chrome_task', TASK_RESUME_FIELDS),
        ),
    ),
    methodDoc(
      'task.takeOver',
      'chrome_task',
      'Explicitly transfer a durable task from another MCP connection, then resume it',
      'task.takeOver(taskId: string, options: { confirm: true })',
      () =>
        positional(
          2,
          sharedField('chrome_task', 'taskId', false, { minLength: 1 }),
          fieldsSchema('chrome_task', TASK_TAKE_OVER_FIELDS, ['confirm'], {
            confirm: { const: true },
          }),
        ),
    ),
    methodDoc('task.get', 'chrome_task', 'Get task status', 'task.get(taskId: string)', () =>
      sharedField('chrome_task', 'taskId', false, { minLength: 1 }),
    ),
    methodDoc(
      'task.open',
      'chrome_task',
      'Open an owned page for the task',
      'task.open(url: string)',
      () => sharedField('chrome_task', 'url', false, { minLength: 1 }),
    ),
    methodDoc(
      'task.borrow',
      'chrome_task',
      'Borrow a user page without owning it',
      'task.borrow(tabId: number)',
      () => sharedField('chrome_task', 'tabId'),
    ),
    methodDoc(
      'task.finish',
      'chrome_task',
      'Finish a task. keep hands known owned tabs back. keepUnknownPages:true with confirm:true retains unidentified creation receipts and does not close them or claim cleanup. Default finish stays unverified and closes nothing while those receipts exist.',
      'task.finish(options?: { keep?: number[], keepUnknownPages?: boolean, confirm?: boolean })',
      () => fieldsSchema('chrome_task', TASK_FINISH_FIELDS),
    ),
    methodDoc(
      'task.cancel',
      'chrome_task',
      'Cancel later task mutations without rollback claims',
      'task.cancel()',
      () => objectSchema({}),
    ),
    methodDoc('task.status', 'chrome_task', 'Read durable task status', 'task.status()', () =>
      objectSchema({}),
    ),
    methodDoc(
      'task.handOff',
      'chrome_task',
      'Hand an owned page to the user',
      'task.handOff(tabId: number)',
      () => sharedField('chrome_task', 'tabId'),
    ),
    methodDoc(
      'page.goto',
      'chrome_navigate',
      'Navigate the task-bound page; after a document change inspect task status and fresh browser inventory, then call task.resume(taskId, { adopt: true }) only for the recorded pending identity',
      'page.goto(url: string, options?)',
      () =>
        positional(
          1,
          sharedField('chrome_navigate', 'url', false, { minLength: 1 }),
          fieldsSchema(
            'chrome_navigate',
            new Set(
              [...allowedToolFields('chrome_navigate', GOTO_REJECTED_FIELDS)].filter(
                (key) => key !== 'url',
              ),
            ),
          ),
        ),
    ),
    methodDoc(
      'page.observe',
      'chrome_read_dom',
      'Read the task-bound DOM',
      'page.observe(options?)',
      () => fieldsSchema('chrome_read_dom', allowedToolFields('chrome_read_dom')),
    ),
    methodDoc(
      'page.screenshot',
      'chrome_screenshot',
      'Capture the task-bound page',
      'page.screenshot(options?)',
      () => fieldsSchema('chrome_screenshot', allowedToolFields('chrome_screenshot')),
    ),
    methodDoc(
      'page.download',
      'chrome_handle_download',
      'Watch this page before clicking an observed ref once, or query an observed GUID. No concurrent wait/click or global filename fallback. suggestedFilename is not a disk path.',
      'page.download({ clickTargetIndex, timeoutMs?, waitForComplete? } | { guid, timeoutMs?, waitForComplete? })',
      () => ({
        ...fieldsSchema('chrome_handle_download', allowedToolFields('chrome_handle_download')),
        oneOf: [{ required: ['guid'] }, { required: ['clickTargetIndex'] }],
      }),
    ),
    methodDoc(
      'page.evaluate',
      'chrome_javascript',
      'Evaluate bounded page JavaScript',
      'page.evaluate(code: string, options?)',
      () =>
        positional(
          1,
          sharedField('chrome_javascript', 'code', false, { minLength: 1 }),
          fieldsSchema('chrome_javascript', EVALUATE_FIELDS),
        ),
    ),
    methodDoc(
      'page.frame',
      'local',
      'Return a frame-scoped page. goto, observe, screenshot, and GUID queries are rejected; evaluate, download triggers, and locator actions keep this frame.',
      'page.frame(frameId: number)',
      () => sharedField('chrome_javascript', 'frameId'),
      'page',
    ),
    methodDoc(
      'page.locator',
      'local',
      'Create a selector or observed numeric-ref locator without calling a browser tool.',
      'page.locator(selectorOrRef: string | number)',
      () => ({
        oneOf: [
          sharedField('chrome_batch_actions', 'selector', true, { minLength: 1 }),
          { type: 'integer', minimum: 1, description: 'Observed numeric ref.' },
        ],
      }),
      'page',
    ),
    methodDoc(
      'page.getByText',
      'chrome_batch_actions',
      'Strict visible-text locator',
      'page.getByText(text: string, options?)',
      () =>
        positional(
          1,
          text('Visible text to match.'),
          fieldsSchema('chrome_batch_actions', GET_BY_TEXT_FIELDS, [], {}, true),
        ),
    ),
    methodDoc(
      'page.getByRole',
      'chrome_batch_actions',
      'Strict accessible-name locator for supported implicit/explicit roles',
      'page.getByRole(role: string, options?: { name?: string, exact?: boolean })',
      () =>
        positional(
          1,
          { type: 'string', enum: Array.from(LOCATOR_ROLES) },
          optionSchema(GET_BY_ROLE_FIELDS, {
            name: text('Accessible name, matched as visible text.'),
            exact: sharedField('chrome_batch_actions', 'exact', true),
          }),
        ),
    ),
    methodDoc(
      'page.getByLabel',
      'chrome_batch_actions',
      'Strict native/ARIA label locator',
      'page.getByLabel(label: string, options?)',
      () =>
        positional(
          1,
          sharedField('chrome_batch_actions', 'label', true, { minLength: 1 }),
          fieldsSchema('chrome_batch_actions', GET_BY_LABEL_FIELDS, [], {}, true),
        ),
    ),
    methodDoc(
      'locator.click',
      'chrome_batch_actions',
      'Click by selector or observed numeric ref',
      'locator.click(options?: { button?: "left" | "right", clickCount?: 1 | 2 })',
      () =>
        optionSchema(
          CLICK_FIELDS,
          {
            button: { type: 'string', enum: [...CLICK_BUTTONS], default: 'left' },
            clickCount: { type: 'number', enum: [...CLICK_COUNTS], default: 1 },
          },
          [],
          {
            description: 'Right-button double click is rejected.',
            not: {
              required: ['button', 'clickCount'],
              properties: {
                button: { const: 'right' },
                clickCount: { const: 2 },
              },
            },
          },
        ),
    ),
    methodDoc(
      'locator.fill',
      'chrome_batch_actions',
      'Fill by selector or observed numeric ref',
      'locator.fill(value: string, options?: { clear?: boolean })',
      () =>
        positional(
          1,
          sharedField('chrome_batch_actions', 'value', true, {
            description: 'Text written into the target. Empty and whitespace values are preserved.',
          }),
          fieldsSchema('chrome_batch_actions', FILL_FIELDS, [], {}, true),
        ),
    ),
    methodDoc(
      'locator.press',
      'chrome_keyboard',
      'Send keys to a locator',
      'locator.press(keys: string, options?: { delay?: number })',
      () =>
        positional(
          1,
          sharedField('chrome_keyboard', 'keys', false, { minLength: 1 }),
          fieldsSchema('chrome_keyboard', PRESS_FIELDS, [], { delay: { minimum: 0 } }),
        ),
    ),
    methodDoc(
      'locator.waitFor',
      'chrome_batch_actions',
      'Bounded visible/hidden assertion',
      'locator.waitFor(options?: { state?: "visible" | "hidden", timeoutMs?: number })',
      () =>
        optionSchema(WAIT_FIELDS, {
          state: { type: 'string', enum: [...WAIT_STATES], default: 'visible' },
          timeoutMs: sharedField('chrome_batch_actions', 'timeoutMs', true, {
            type: 'integer',
            minimum: 1,
          }),
        }),
    ),
    methodDoc(
      'skills.find',
      'chrome_skill',
      'Find verified site skills',
      'skills.find(url: string, intent?: string)',
      () =>
        positional(
          1,
          sharedField('chrome_skill', 'url', false, { minLength: 1 }),
          sharedField('chrome_skill', 'intent'),
        ),
    ),
    methodDoc('skills.list', 'chrome_skill', 'List verified site skills', 'skills.list()', () =>
      objectSchema({}),
    ),
    methodDoc(
      'skills.get',
      'chrome_skill',
      'Read a stored skill version, including a candidate',
      'skills.get(id: string, version?: number)',
      () =>
        positional(
          1,
          sharedField('chrome_skill', 'id', false, { minLength: 1 }),
          sharedField('chrome_skill', 'version'),
        ),
    ),
    methodDoc(
      'skills.propose',
      'chrome_skill',
      'Propose a candidate with source attribution, verification, and per-test observe schemas',
      'skills.propose(definition)',
      () => sharedField('chrome_skill', 'definition'),
    ),
    methodDoc(
      'skills.validate',
      'chrome_skill',
      'Validate with fresh tasks; signal cancels the in-flight MCP request',
      'skills.validate(id: string, version?: number, options?: { signal?: AbortSignal })',
      () =>
        positional(
          1,
          sharedField('chrome_skill', 'id', false, { minLength: 1 }),
          sharedField('chrome_skill', 'version'),
          optionSchema(SKILL_VALIDATE_FIELDS, { signal: SIGNAL_SCHEMA }),
        ),
    ),
    methodDoc(
      'skills.run',
      'chrome_skill',
      'Run a verified skill; signal cancels the in-flight MCP request',
      'skills.run(id: string, inputs?: object, options?: { taskId?: string, signal?: AbortSignal, version?: number, definitionHash?: string })',
      () =>
        positional(
          1,
          sharedField('chrome_skill', 'id', false, { minLength: 1 }),
          sharedField('chrome_skill', 'inputs'),
          optionSchema(SKILL_RUN_FIELDS, {
            taskId: sharedField('chrome_skill', 'taskId', false, { minLength: 1 }),
            signal: SIGNAL_SCHEMA,
            version: sharedField('chrome_skill', 'version'),
            definitionHash: {
              type: 'string',
              description: 'Optional SHA-256 hash of the skill definition',
            },
          }),
        ),
    ),
    methodDoc(
      'skills.disable',
      'chrome_skill',
      'Disable a skill',
      'skills.disable(id: string)',
      () => sharedField('chrome_skill', 'id', false, { minLength: 1 }),
    ),
    methodDoc(
      'skills.rollback',
      'chrome_skill',
      'Roll back to a verified version',
      'skills.rollback(id: string, version: number)',
      () =>
        positional(
          2,
          sharedField('chrome_skill', 'id', false, { minLength: 1 }),
          sharedField('chrome_skill', 'version'),
        ),
    ),
  ];
}

export function createBrowserApi(call: BrowserApiCall, _listTools?: BrowserApiTools): BrowserApi {
  // Callers may still pass mcp.tools(). help() does not call it or chrome_tool_docs.
  const invoke = createToolInvoker(call);
  const docs = methodDocs();
  const docsByName = new Map(docs.map((item) => [item.method, item]));

  function indexEntry(item: MethodDoc): HelpEntry {
    return {
      method: item.method,
      source: item.source,
      tool: item.tool,
      category: item.category,
      description: item.description,
      signature: item.signature,
    };
  }

  const makeTask = (task: JsonObject): TaskHandle => {
    const taskId = requiredString(task.id, 'chrome_task task.id');
    return {
      id: taskId,
      async open(url: string) {
        const target = requiredString(url, 'task.open url');
        const raw = await invoke('chrome_task', { action: 'open', taskId, url: target });
        const opened = taskFromResult(raw, 'open');
        return makePage(invoke, taskId, currentTabId(opened, 'open'));
      },
      async borrow(tabId: number) {
        const targetTabId = requiredPositiveInteger(tabId, 'task.borrow tabId');
        const raw = await invoke('chrome_task', {
          action: 'borrow',
          taskId,
          tabId: targetTabId,
        });
        const borrowed = taskFromResult(raw, 'borrow');
        return makePage(invoke, taskId, currentTabId(borrowed, 'borrow'));
      },
      async finish(options?: TaskFinishOptions) {
        const validated = validateOptions(options, 'task.finish', TASK_FINISH_FIELDS);
        const keep = numberArray(validated.keep, 'task.finish keep');
        if (
          validated.keepUnknownPages !== undefined &&
          typeof validated.keepUnknownPages !== 'boolean'
        ) {
          throw new Error('task.finish keepUnknownPages must be boolean');
        }
        if (validated.confirm !== undefined && typeof validated.confirm !== 'boolean') {
          throw new Error('task.finish confirm must be boolean');
        }
        if (validated.keepUnknownPages === true && validated.confirm !== true) {
          throw new Error('task.finish keepUnknownPages requires confirm: true');
        }
        return invoke('chrome_task', {
          action: 'finish',
          taskId,
          ...(keep !== undefined ? { keep } : {}),
          ...(validated.keepUnknownPages === true ? { keepUnknownPages: true, confirm: true } : {}),
        });
      },
      async cancel() {
        return invoke('chrome_task', { action: 'cancel', taskId });
      },
      async status() {
        return invoke('chrome_task', { action: 'status', taskId });
      },
      async handOff(tabId: number) {
        return invoke('chrome_task', {
          action: 'handOff',
          taskId,
          tabId: requiredPositiveInteger(tabId, 'task.handOff tabId'),
        });
      },
    };
  };

  const task: BrowserApi['task'] = {
    async start(options: TaskStartOptions) {
      const validated = validateOptions(options, 'task.start', TASK_START_FIELDS);
      const name = requiredString(validated.name, 'task.start name');
      const goal = optionalString(validated.goal, 'task.start goal');
      const raw = await invoke('chrome_task', {
        action: 'start',
        name,
        ...(goal !== undefined ? { goal } : {}),
      });
      return makeTask(taskFromResult(raw, 'start'));
    },
    async list(options?: Record<string, never>) {
      validateNoOptions(options, 'task.list');
      return invoke('chrome_task', { action: 'list' });
    },
    async resume(taskId: string, options?: TaskResumeOptions) {
      const id = requiredString(taskId, 'task.resume taskId');
      const validated = validateOptions(options, 'task.resume', TASK_RESUME_FIELDS);
      if (validated.adopt !== undefined && typeof validated.adopt !== 'boolean') {
        throw new Error('task.resume adopt must be boolean');
      }
      const raw = await invoke('chrome_task', {
        action: 'resume',
        taskId: id,
        ...(validated.adopt !== undefined ? { adopt: validated.adopt } : {}),
      });
      return makeTask(taskFromResult(raw, 'resume'));
    },
    async takeOver(taskId: string, options: { confirm: true }) {
      const id = requiredString(taskId, 'task.takeOver taskId');
      const validated = validateOptions(options, 'task.takeOver', TASK_TAKE_OVER_FIELDS);
      if (validated.confirm !== true) throw new Error('task.takeOver requires confirm: true');
      const raw = await invoke('chrome_task', {
        action: 'takeOver',
        taskId: id,
        confirm: true,
      });
      return makeTask(taskFromResult(raw, 'takeOver'));
    },
    async get(taskId: string) {
      const id = requiredString(taskId, 'task.get taskId');
      const raw = await invoke('chrome_task', { action: 'status', taskId: id });
      return makeTask(taskFromResult(raw, 'status'));
    },
  };

  const skills: BrowserApi['skills'] = {
    async find(url: string, intent = '') {
      return invoke('chrome_skill', {
        action: 'find',
        url: requiredString(url, 'skills.find url'),
        ...(intent ? { intent: requiredString(intent, 'skills.find intent') } : {}),
      });
    },
    async list(options?: Record<string, never>) {
      validateNoOptions(options, 'skills.list');
      return invoke('chrome_skill', { action: 'list' });
    },
    async get(id: string, version?: number) {
      const requestedVersion = optionalPositiveInteger(version, 'skills.get version');
      return invoke('chrome_skill', {
        action: 'get',
        id: requiredString(id, 'skills.get id'),
        ...(requestedVersion !== undefined ? { version: requestedVersion } : {}),
      });
    },
    async propose(definition: SkillDefinition) {
      const record = validateObject(definition, 'skills.propose definition');
      if (isRecord(record.definition)) {
        throw new Error(
          'skills.propose(definition) expects the definition object itself, not a { definition } envelope. source attribution is a field of that object',
        );
      }
      return invoke('chrome_skill', { action: 'propose', definition });
    },
    async validate(id: string, version?: number, options?: SkillValidateOptions) {
      const requestedVersion = optionalPositiveInteger(version, 'skills.validate version');
      const validated = validateOptions(options, 'skills.validate', SKILL_VALIDATE_FIELDS);
      const signal = optionalAbortSignal(validated.signal, 'skills.validate signal');
      return invoke(
        'chrome_skill',
        {
          action: 'validate',
          id: requiredString(id, 'skills.validate id'),
          ...(requestedVersion !== undefined ? { version: requestedVersion } : {}),
        },
        signal ? { signal } : undefined,
      );
    },
    async run(id: string, inputs: Record<string, unknown> = {}, options?: SkillRunOptions) {
      const validated = validateOptions(options, 'skills.run', SKILL_RUN_FIELDS);
      const taskId = optionalString(validated.taskId, 'skills.run taskId');
      const signal = optionalAbortSignal(validated.signal, 'skills.run signal');
      const version = optionalPositiveInteger(validated.version, 'skills.run version');
      const definitionHash = optionalString(validated.definitionHash, 'skills.run definitionHash');
      validateObject(inputs, 'skills.run inputs');
      return invoke(
        'chrome_skill',
        {
          action: 'run',
          id: requiredString(id, 'skills.run id'),
          inputs,
          ...(taskId !== undefined ? { taskId } : {}),
          ...(version !== undefined ? { version } : {}),
          ...(definitionHash !== undefined ? { definitionHash } : {}),
        },
        signal ? { signal } : undefined,
      );
    },
    async disable(id: string) {
      return invoke('chrome_skill', {
        action: 'disable',
        id: requiredString(id, 'skills.disable id'),
      });
    },
    async rollback(id: string, version: number) {
      return invoke('chrome_skill', {
        action: 'rollback',
        id: requiredString(id, 'skills.rollback id'),
        version: requiredPositiveInteger(version, 'skills.rollback version'),
      });
    },
  };

  function help(): HelpEntry[];
  function help(name: string): Promise<HelpEntry>;
  function help(name?: string): HelpEntry[] | Promise<HelpEntry> {
    if (name === undefined) return docs.map(indexEntry);
    const requested = requiredString(name, 'help method');
    const item = docsByName.get(requested);
    if (!item) {
      return Promise.reject(
        new Error(
          `Unsupported browser API method "${requested}". Available: ${docs
            .map((entry) => entry.method)
            .join(', ')}`,
        ),
      );
    }
    return Promise.resolve({ ...indexEntry(item), schema: cloneSchema(item.schema()) });
  }

  return { task, skills, help };
}
