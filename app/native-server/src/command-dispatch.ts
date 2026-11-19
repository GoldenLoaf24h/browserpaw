import { readFile, mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';
import { parseCommand, type ParsedCommand } from 'chrome-mcp-shared';
import { handleBrowserCall } from './browser-dispatch';
import { tryParseCallResult } from './browser-tasks';
import { TOKEN_DIR } from './server/token';

type Fields = Record<string, unknown>;
type BackendResult = Awaited<ReturnType<typeof handleBrowserCall>>;
const taskPrefix = 'browserpaw-cli:';

export class CommandError extends Error {
  constructor(
    message: string,
    readonly code = 'invalid_arguments',
  ) {
    super(message);
  }
}

export function integer(value: unknown, label: string, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < min || number > max)
    throw new CommandError(`${label} must be an integer from ${min} to ${max}.`);
  return number;
}

function object(value: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new CommandError('Expected a JSON object.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new CommandError('Expected a JSON object.');
  return parsed as Fields;
}

export function parseTarget(value: string): Fields {
  if (/^\d+$/.test(value)) return { index: integer(value, 'Ref') };
  const coordinate = /^@(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(value);
  if (coordinate) return { coordinate: { x: Number(coordinate[1]), y: Number(coordinate[2]) } };
  const locator = /^(css|text|role|label):(.+)$/.exec(value);
  if (!locator) throw new CommandError('Invalid target. Run browserpaw help targets.');
  const [, type, name] = locator;
  if (type === 'css') return { selector: name };
  if (type === 'role') {
    const colon = name.indexOf(':');
    return colon === -1
      ? { role: name, exact: true }
      : { role: name.slice(0, colon), targetText: name.slice(colon + 1), exact: true };
  }
  return { [type === 'text' ? 'targetText' : 'label']: name, exact: true };
}

function failed(result: BackendResult) {
  const data = tryParseCallResult(result);
  return (
    result.isError ||
    data?.success === false ||
    data?.ok === false ||
    ['unknown', 'blocked', 'cancelled', 'failed', 'unverified'].includes(String(data?.status))
  );
}

function argumentCount(command: ParsedCommand, minimum: number, maximum = minimum) {
  if (command.operands.length < minimum || command.operands.length > maximum)
    throw new CommandError(`Incorrect operands. Run browserpaw help ${command.name}.`);
}

const withoutPage = new Set([
  'tabs',
  'open',
  'task start',
  'task list',
  'task status',
  'task finish',
  'task cancel',
  'task borrow',
  'task release',
  'tab focus',
  'tab close',
  'batch',
  'recipe list',
  'recipe run',
  'recipe save',
  'recipe rm',
  'doctor',
]);

export async function dispatchCommand(
  command: ParsedCommand,
  signal: AbortSignal,
  input?: unknown,
): Promise<BackendResult> {
  const { name, options } = command;
  const [first, second] = command.operands;
  const taskId =
    typeof options.task === 'string' ? options.task : name === 'task status' ? first : undefined;
  if (taskId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(taskId))
    throw new CommandError('Expected a task ID returned by task start.');
  if (taskId && name === 'task status' && first && first !== taskId)
    throw new CommandError('Conflicting task IDs.');
  const tabId = options.tab === undefined ? undefined : integer(options.tab, 'Tab ID');
  const frameId = options.frame === undefined ? undefined : integer(options.frame, 'Frame ID', 0);
  const timeoutMs =
    options.timeout === undefined ? undefined : integer(options.timeout, 'Timeout', 1, 300000);
  if (!withoutPage.has(name) && !taskId && tabId === undefined)
    throw new CommandError('Select a page with --task ID or --tab ID.');
  const owner = taskId ? taskPrefix + taskId : tabId ? 'cli-tab:' + tabId : undefined;
  const context = { ...(taskId ? { taskId } : {}), ...(tabId ? { tabId } : {}) };
  const run = (backend: string, args: Fields = {}, includeContext = true) =>
    handleBrowserCall(backend, { ...(includeContext ? context : {}), ...args }, owner, signal);
  const task = (action: string, args: Fields = {}) => {
    if (action !== 'start' && action !== 'list' && !taskId)
      throw new CommandError('Select a task with --task ID.');
    return handleBrowserCall(
      'chrome_task',
      {
        action,
        ...(taskId ? { taskId } : {}),
        ...args,
      },
      action === 'start' ? taskPrefix : owner,
      signal,
    );
  };
  const target = (value: string): Fields => ({
    ...parseTarget(value),
    ...(frameId === undefined ? {} : { frameId }),
  });
  const selector = (value: string) => {
    const result = parseTarget(value);
    if (typeof result.selector !== 'string')
      throw new CommandError('This option requires a css:SELECTOR target.');
    return result.selector;
  };
  const indexOrSelector = (value: string) => {
    const fields = target(value);
    if (!fields.index && !fields.selector)
      throw new CommandError('Use an observed ref or css:SELECTOR.');
    return fields;
  };
  const batchAction = (action: Fields) => run('chrome_batch_actions', { actions: [action] });
  const interact = (action: string) => {
    const fields = target(first);
    if (fields.coordinate) {
      if (typeof options.capture !== 'string')
        throw new CommandError('Coordinates require --capture ID.');
      return run('chrome_interact_index', {
        ...fields,
        action,
        captureId: options.capture,
        coordinateSpace: 'screenshot',
        autoSnap: false,
      });
    }
    if (fields.index) return run('chrome_interact_index', { ...fields, action });
    return batchAction({ type: action, ...fields });
  };

  switch (name) {
    case 'tabs':
      argumentCount(command, 0);
      return run('get_windows_and_tabs');
    case 'doctor':
      argumentCount(command, 0);
      return run('chrome_doctor', { verbose: true }, false);
    case 'open':
      argumentCount(command, 1);
      if (taskId && options.foreground)
        throw new CommandError('Open the task page in the background, then use tab focus.');
      return taskId
        ? task('open', { url: first })
        : run(
            'chrome_navigate',
            { url: first, newTab: true, background: !options.foreground },
            false,
          );
    case 'nav':
      argumentCount(command, 1);
      return run('chrome_navigate', first === 'reload' ? { refresh: true } : { url: first });
    case 'tab focus':
      argumentCount(command, 1);
      return run('chrome_switch_tab', { tabId: integer(first, 'Tab ID'), background: false });
    case 'tab close':
      argumentCount(command, 1, Infinity);
      if (taskId) throw new CommandError('Use task finish to close task-owned pages.');
      return run(
        'chrome_close_tabs',
        { tabIds: command.operands.map((id) => integer(id, 'Tab ID')) },
        false,
      );
    case 'observe':
      argumentCount(command, 0);
      return run('chrome_read_dom', {
        ...(options.scope ? { selector: String(options.scope).replace(/^css:/, '') } : {}),
        ...(options.max ? { limit: integer(options.max, 'Limit') } : {}),
        ...(options.delta ? { deltaOnly: true } : {}),
      });
    case 'text':
      argumentCount(command, 0, 1);
      if (options['max-chars']) integer(options['max-chars'], 'Character limit');
      return first
        ? batchAction({ type: 'extract', ...target(first), property: 'text', variableName: 'text' })
        : run('chrome_get_markdown');
    case 'find':
      argumentCount(command, 1);
      return run('chrome_grep', {
        query: first,
        isRegex: !!options.regex,
        autoScroll: !!options.scroll,
      });
    case 'screenshot':
      argumentCount(command, 0, 1);
      return run('chrome_screenshot', {
        ...(first
          ? /^\d+$/.test(first)
            ? { targetIndex: integer(first, 'Ref') }
            : { selector: selector(first) }
          : {}),
        fullPage: !!options.full,
        savePng: false,
        saveToDisk: false,
        format: typeof options.out === 'string' && /\.jpe?g$/i.test(options.out) ? 'jpeg' : 'png',
      });
    case 'click':
      argumentCount(command, 1);
      if (options.double && options.right)
        throw new CommandError('Select either --double or --right.');
      return interact(options.double ? 'double_click' : options.right ? 'right_click' : 'click');
    case 'hover':
      argumentCount(command, 1);
      return interact('hover');
    case 'fill': {
      argumentCount(command, options.input ? 1 : 2);
      const text = options.input ? input : second;
      if (typeof text !== 'string') throw new CommandError('Fill input must be text.');
      const fields = target(first);
      if (fields.coordinate) throw new CommandError('Fill requires a ref or strict locator.');
      const fill = { ...fields, text, clear: !options.append };
      return fields.index ? run('chrome_fill_index', fill) : batchAction({ type: 'fill', ...fill });
    }
    case 'select': {
      argumentCount(command, 1, Infinity);
      if (second === undefined) return run('chrome_get_dropdown_options', indexOrSelector(first));
      const fields = target(first);
      if (fields.coordinate) throw new CommandError('Select requires a ref or strict locator.');
      return fields.index
        ? run('chrome_fill_index', {
            ...fields,
            text: second,
            ...(command.operands.length > 2 ? { selectValues: command.operands.slice(1) } : {}),
          })
        : command.operands.length === 2
          ? batchAction({ type: 'fill', ...fields, text: second })
          : Promise.reject(new CommandError('Use an observed ref to select multiple values.'));
    }
    case 'press': {
      argumentCount(command, 1, 2);
      const fields = second ? target(second) : frameId === undefined ? {} : { frameId };
      if ('coordinate' in fields) throw new CommandError('Press requires a ref or strict locator.');
      const { targetText, ...locator } = fields as Fields;
      return run('chrome_keyboard', {
        keys: first,
        ...locator,
        ...(targetText ? { text: targetText } : {}),
      });
    }
    case 'scroll': {
      argumentCount(command, 0, 1);
      const directions = ['up', 'down', 'top', 'bottom'].filter((key) => options[key]);
      if (directions.length > 1) throw new CommandError('Select a single scroll direction.');
      const edge = options.top || options.bottom;
      if (edge && options.by)
        throw new CommandError('Use --by with a direction or select a page edge.');
      return run('chrome_smart_scroll', {
        ...(first ? indexOrSelector(first) : {}),
        direction: options.top ? 'up' : options.bottom ? 'down' : (directions[0] ?? 'down'),
        ...(edge
          ? { amount: 1000000000 }
          : options.by
            ? { amount: integer(options.by, 'Scroll distance') }
            : {}),
      });
    }
    case 'drag': {
      argumentCount(command, 2);
      const start = target(first);
      const end = parseTarget(second);
      if ((!start.index && !start.coordinate) || (!end.index && !end.coordinate))
        throw new CommandError('Drag requires refs or capture coordinates.');
      if ((start.coordinate || end.coordinate) && !options.capture)
        throw new CommandError('Coordinates require --capture ID.');
      return run('chrome_interact_index', {
        ...start,
        end,
        action: 'drag',
        ...(options.capture ? { captureId: options.capture, coordinateSpace: 'screenshot' } : {}),
      });
    }
    case 'upload': {
      argumentCount(command, 2, Infinity);
      const fields = indexOrSelector(first);
      return run('chrome_upload_file', {
        ...fields,
        filePaths: command.operands.slice(1),
        multiple: command.operands.length > 2,
      });
    }
    case 'dialog':
      argumentCount(command, 1);
      if (first !== 'accept' && first !== 'dismiss')
        throw new CommandError('Use dialog accept or dismiss.');
      return run('chrome_handle_dialog', {
        action: first,
        dialogId: options.id,
        promptText: options.text,
      });
    case 'download': {
      argumentCount(command, options.url ? 0 : 1);
      const fields = options.url ? {} : target(first);
      if (!options.url && !fields.index)
        throw new CommandError('Use an observed ref or --url URL.');
      if (options.out && !options.url)
        throw new CommandError(
          'Use --url URL to obtain a file path. A page-triggered download returns its source receipt.',
        );
      const result = await run('chrome_handle_download', {
        ...(options.url ? { directUrl: options.url } : { clickTargetIndex: fields.index, frameId }),
        timeoutMs,
        waitForComplete: true,
      });
      const data = tryParseCallResult(result);
      const path = data?.verifiedPath
        ? (data?.filePath ?? (data?.download as Fields | undefined)?.filename)
        : undefined;
      if (options.out && !failed(result) && typeof path === 'string') {
        const directory = String(options.out);
        const destination = join(directory, basename(path));
        try {
          await mkdir(directory, { recursive: true });
          await copyFile(path, destination, constants.COPYFILE_EXCL);
        } catch (error) {
          return {
            ...result,
            isError: true,
            structuredContent: {
              ...data,
              code: 'output_failed',
              filePath: path,
              error: error instanceof Error ? error.message : String(error),
            },
          };
        }
        return { ...result, structuredContent: { ...data, filePath: destination } };
      }
      if (options.url && !failed(result)) {
        return {
          ...result,
          isError: typeof path !== 'string',
          structuredContent: {
            ...data,
            ...(typeof path === 'string'
              ? { filePath: path }
              : {
                  code: 'download_path_unverified',
                  error: 'Chrome completed the download without a verified file path.',
                }),
          },
        };
      }
      return result;
    }
    case 'console':
      argumentCount(command, 0);
      if (options.level && options.level !== 'error')
        throw new CommandError('Supported console level: error. Omit it to include all levels.');
      return run('chrome_console', {
        mode: 'buffer',
        clear: !!options.clear,
        onlyErrors: options.level === 'error',
      });
    case 'network start':
    case 'network stop':
    case 'network show':
      argumentCount(command, 0);
      return run('chrome_network_capture', {
        action: name === 'network show' ? 'status' : name.split(' ')[1],
        needResponseBody: !!options.bodies,
        url: options.filter,
      });
    case 'eval':
      argumentCount(command, options.file ? 0 : 1);
      if (options.file && typeof input !== 'string')
        throw new CommandError('Expected JavaScript source.');
      return run('chrome_javascript', { code: options.file ? input : first, frameId, timeoutMs });
    case 'fetch': {
      argumentCount(command, 1);
      const headers = Object.fromEntries(
        ((options.header as string[]) ?? []).map((header) => {
          const split = header.indexOf(':');
          if (split < 1) throw new CommandError('Request headers use KEY:VALUE.');
          return [header.slice(0, split), header.slice(split + 1).trim()];
        }),
      );
      const method = String(options.method ?? 'GET').toUpperCase();
      return run('chrome_network_request', { url: first, method, headers, body: options.body });
    }
    case 'cdp':
      argumentCount(command, 1, 2);
      return run('chrome_cdp_execute', {
        method: first,
        params: second === undefined ? {} : object(second),
      });
    case 'ask-human':
      argumentCount(command, 1);
      return run('chrome_request_human_intervention', { reason: first, timeoutMs });
    case 'task start':
      argumentCount(command, 1);
      if (taskId) throw new CommandError('Task start creates a new task. Omit --task.');
      return task('start', { name: first, goal: options.goal });
    case 'task list':
      argumentCount(command, 0);
      return task('list');
    case 'task status':
      argumentCount(command, 0, 1);
      return task('status');
    case 'task cancel':
      argumentCount(command, 0);
      return task('cancel');
    case 'task finish':
      argumentCount(command, 0);
      return task('finish', {
        keep: ((options.keep as string[]) ?? []).map((id) => integer(id, 'Tab ID')),
        ...(options['keep-unknown'] ? { keepUnknownPages: true, confirm: true } : {}),
      });
    case 'task borrow':
    case 'task release':
      argumentCount(command, 1);
      return task(name === 'task borrow' ? 'borrow' : 'handOff', {
        tabId: integer(first, 'Tab ID'),
      });
    case 'wait': {
      argumentCount(command, 0, 1);
      if ([first, options.text, options.url].filter((part) => part !== undefined).length !== 1)
        throw new CommandError('Provide one target, --text TEXT, or --url URL.');
      if (first) {
        return batchAction({
          type: 'assert',
          ...target(first),
          condition: options.gone ? 'not_visible' : 'visible',
          timeoutMs: timeoutMs ?? 10000,
        });
      }
      const until = Date.now() + (timeoutMs ?? 10000);
      do {
        signal.throwIfAborted();
        const result = options.url
          ? await run('chrome_javascript', { code: 'location.href', frameId })
          : await run('chrome_get_markdown');
        if (failed(result)) return result;
        const value = options.url
          ? String(tryParseCallResult(result)?.result ?? '')
          : (result.content ?? [])
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n');
        const matched = value.includes(String(options.url ?? options.text));
        if (matched !== !!options.gone)
          return { content: [], structuredContent: { matched, conditionMet: true } };
        await new Promise((resolve) => setTimeout(resolve, 150));
      } while (Date.now() < until);
      return { content: [{ type: 'text', text: 'Wait timed out.' }], isError: true };
    }
    case 'batch': {
      argumentCount(command, 1);
      return runBatch(input, options, signal);
    }
    case 'recipe list': {
      argumentCount(command, 0);
      const bundled = await run('chrome_skill', {
        action: options.url ? 'find' : 'list',
        url: options.url,
      });
      const directory = join(TOKEN_DIR, 'recipes');
      const files = await readdir(directory).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return [] as string[];
      });
      return {
        ...bundled,
        structuredContent: {
          saved: files
            .filter((name) => /^[a-z][a-z0-9-]{0,63}\.json$/.test(name))
            .map((name) => name.slice(0, -5)),
        },
      };
    }
    case 'recipe run': {
      argumentCount(command, 1, Infinity);
      const inputs = Object.fromEntries(
        command.operands.slice(1).map((part) => {
          const index = part.indexOf('=');
          if (index < 1) throw new CommandError('Recipe inputs use KEY=VALUE.');
          return [part.slice(0, index), part.slice(index + 1)];
        }),
      );
      const saved = await readFile(recipePath(first), 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (!saved) return run('chrome_skill', { action: 'run', id: first, inputs });
      const definition = object(saved);
      const steps = recipeSteps(definition.steps).map((step) =>
        step.map((part) =>
          part.replace(/\{\{([a-zA-Z0-9_-]+)\}\}/g, (_match, key: string) => {
            if (!Object.hasOwnProperty.call(inputs, key))
              throw new CommandError(`Missing recipe input ${key}.`);
            return inputs[key];
          }),
        ),
      );
      return runBatch(steps, options, signal);
    }
    case 'recipe save': {
      argumentCount(command, 1);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new CommandError('Expected a recipe object with id and steps.');
      const definition = input as Fields;
      const path = recipePath(definition.id);
      batchCommands(recipeSteps(definition.steps), {});
      const { ensureDirectory, atomicWrite } = require('./cli-files.cjs');
      ensureDirectory(join(TOKEN_DIR, 'recipes'));
      atomicWrite(path, JSON.stringify(definition, null, 2) + '\n');
      return { content: [], structuredContent: { id: definition.id, path } };
    }
    case 'recipe rm':
      argumentCount(command, 1);
      await rm(recipePath(first), { force: true });
      return { content: [], structuredContent: { id: first, removed: true } };
    default:
      throw new CommandError(`Unsupported browser command ${name}.`);
  }
}

const batchExcluded = new Set(['setup', 'uninstall', 'help', 'batch']);

function recipePath(id: unknown) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(id))
    throw new CommandError(
      'Recipe ID must begin with a lowercase letter and contain only letters, digits, or hyphens.',
    );
  return join(TOKEN_DIR, 'recipes', id + '.json');
}

function recipeSteps(input: unknown): string[][] {
  if (!Array.isArray(input) || !input.length || input.length > 100)
    throw new CommandError('Expected an array of 1–100 command argument arrays.');
  return input.map((args) => {
    if (!Array.isArray(args) || args.some((part) => typeof part !== 'string'))
      throw new CommandError('Each batch step must be an array of arguments.');
    return args;
  });
}

function batchCommands(input: unknown, options: ParsedCommand['options']) {
  return recipeSteps(input).map((args) => {
    const parsed = parseCommand(args);
    if (
      batchExcluded.has(parsed.name) ||
      parsed.name.startsWith('recipe ') ||
      parsed.options.file ||
      parsed.options.input
    )
      throw new CommandError(`Command ${parsed.name} is unavailable inside a batch.`);
    return {
      ...parsed,
      options: { task: options.task, tab: options.tab, frame: options.frame, ...parsed.options },
    } as ParsedCommand;
  });
}

async function runBatch(input: unknown, options: ParsedCommand['options'], signal: AbortSignal) {
  const commands = batchCommands(input, options);
  const steps: { command: string; result?: BackendResult; error?: string }[] = [];
  for (const command of commands) {
    try {
      signal.throwIfAborted();
      const result = await dispatchCommand(command, signal);
      steps.push({ command: command.name, result });
      if (failed(result)) {
        const data = tryParseCallResult(result);
        return { content: result.content, structuredContent: { ...data, steps }, isError: true };
      }
    } catch (error) {
      steps.push({
        command: command.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        content: [],
        structuredContent: { steps, status: signal.aborted ? 'cancelled' : 'failed' },
        isError: true,
      };
    }
  }
  return { content: [], structuredContent: { steps }, isError: false };
}
