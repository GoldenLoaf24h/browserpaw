import { mkdir, copyFile, rm } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { isProfileCommand, parseCommand, type ParsedCommand } from 'chrome-mcp-shared';
import { handleBrowserCall } from './browser-dispatch';
import {
  argumentCount,
  assertBatchStep,
  CommandError,
  integer,
  parseTarget,
  type CommandRun,
} from './command-utils';
import { dispatchData } from './commands-data';
import { dispatchDebug } from './commands-debug';
import { dispatchPage } from './commands-page';

export { CommandError, integer, parseTarget } from './command-utils';
import { tryParseCallResult } from './browser-tasks';
import {
  browserPawHome,
  coerceWorkflowInputs,
  expandRecipeSteps,
  findLearnedWorkflows,
  formatRunCommand,
  isVerifiedSkillPayload,
  listLearnedWorkflows,
  loadLearnedWorkflows,
  matchLearnedWorkflows,
  parseRecipeKeyValues,
  recipesDirectory,
  savedRecipeFilePath,
  savedRecipeInputs,
  schemaToInputSpecs,
  showLearnedWorkflow,
  skillsDirectory,
  syncLearnedRouting,
  validateSavedRecipe,
  type SavedRecipe,
} from './learned-recipes';

type Fields = Record<string, unknown>;
type BackendResult = Awaited<ReturnType<typeof handleBrowserCall>>;
const taskPrefix = 'browserpaw-cli:';

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

function failed(result: BackendResult) {
  const data = tryParseCallResult(result);
  return (
    result.isError ||
    data?.success === false ||
    data?.ok === false ||
    ['unknown', 'blocked', 'cancelled', 'failed', 'unverified'].includes(String(data?.status))
  );
}

function truncateTextResult(result: BackendResult, maxChars: number): BackendResult {
  const data = tryParseCallResult(result);
  const extracted =
    data?.extractedData &&
    typeof data.extractedData === 'object' &&
    !Array.isArray(data.extractedData)
      ? (data.extractedData as Fields)
      : undefined;
  const resultEntry = Array.isArray(data?.results)
    ? data.results.find(
        (entry): entry is Fields =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (entry as Fields).variableName === 'text',
      )
    : undefined;
  let contentIndex: number | undefined = result.content?.findIndex(
    (block) => block.type === 'text' && typeof block.text === 'string',
  );
  if (contentIndex !== undefined && contentIndex < 0) contentIndex = undefined;
  const contentBlock = contentIndex === undefined ? undefined : result.content?.[contentIndex];
  const original =
    (typeof extracted?.text === 'string' ? extracted.text : undefined) ??
    (typeof resultEntry?.value === 'string' ? resultEntry.value : undefined) ??
    (contentBlock?.type === 'text' ? contentBlock.text : undefined);
  if (original === undefined) return result;

  const text = original.slice(0, maxChars);
  const truncated = text.length !== original.length;
  const updatedData = data ? { ...data } : undefined;
  if (updatedData && extracted && typeof extracted.text === 'string')
    updatedData.extractedData = { ...extracted, text };
  if (updatedData && resultEntry) {
    updatedData.results = (updatedData.results as Fields[]).map((entry) =>
      entry === resultEntry || entry.variableName === 'text' ? { ...entry, value: text } : entry,
    );
  }
  const content = result.content?.map((block, index) => {
    if (updatedData && index === 0 && block.type === 'text')
      return { ...block, text: JSON.stringify(updatedData) };
    if (!updatedData && index === contentIndex) return { ...block, text };
    return block;
  });
  return {
    ...result,
    ...(content ? { content } : {}),
    structuredContent: {
      ...(updatedData ?? {}),
      truncated,
      originalChars: original.length,
    },
  };
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
  'recipe find',
  'recipe show',
  'recipe run',
  'recipe save',
  'recipe validate',
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
  if (isProfileCommand(name) && (taskId || options.tab || options.frame))
    throw new CommandError(
      'This command uses browser profile IDs. Omit --task, --tab and --frame.',
    );
  const tabId = options.tab === undefined ? undefined : integer(options.tab, 'Tab ID');
  const frameId = options.frame === undefined ? undefined : integer(options.frame, 'Frame ID', 0);
  const timeoutMs =
    options.timeout === undefined ? undefined : integer(options.timeout, 'Timeout', 1, 300000);
  if (!withoutPage.has(name) && !isProfileCommand(name) && !taskId && tabId === undefined)
    throw new CommandError('Select a page with --task ID or --tab ID.');
  const owner = taskId ? taskPrefix + taskId : tabId ? 'cli-tab:' + tabId : undefined;
  const context = { ...(taskId ? { taskId } : {}), ...(tabId ? { tabId } : {}) };
  const run: CommandRun = (backend, args = {}, includeContext = true) =>
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

  const delegated =
    dispatchData(command, run) ?? dispatchDebug(command, run) ?? dispatchPage(command, run);
  if (delegated) return delegated;

  switch (name) {
    case 'tabs':
      argumentCount(command, 0);
      return run('get_windows_and_tabs');
    case 'doctor':
      argumentCount(command, 0);
      return run('chrome_doctor', { verbose: true }, false);
    case 'open': {
      argumentCount(command, 1);
      if (taskId && options.foreground)
        throw new CommandError('Open the task page in the background, then use tab focus.');
      const opened = await (taskId
        ? task('open', { url: first })
        : run(
            'chrome_navigate',
            { url: first, newTab: true, background: !options.foreground },
            false,
          ));
      const data = taskId ? tryParseCallResult(opened) : undefined;
      return attachMatchedRecipes(
        data?.ok === true && typeof data.tabId === 'number'
          ? { ...opened, content: [], structuredContent: { ...data, created: true } }
          : opened,
        first,
      );
    }
    case 'nav': {
      argumentCount(command, 1);
      const navigated = await run(
        'chrome_navigate',
        first === 'reload' ? { refresh: true } : { url: first },
      );
      return attachMatchedRecipes(navigated, first);
    }
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
    case 'text': {
      argumentCount(command, 0, 1);
      const maxChars =
        options['max-chars'] === undefined
          ? undefined
          : integer(options['max-chars'], 'Character limit');
      const result = first
        ? batchAction({ type: 'extract', ...target(first), property: 'text', variableName: 'text' })
        : run('chrome_get_markdown');
      return maxChars === undefined
        ? result
        : result.then((value) => truncateTextResult(value, maxChars));
    }
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
      const homeDir = browserPawHome();
      const url = typeof options.url === 'string' ? options.url : undefined;
      const query = typeof options.query === 'string' ? options.query : undefined;
      try {
        return {
          content: [],
          structuredContent: listLearnedWorkflows(homeDir, {
            includeCandidates: Boolean(options.all),
            url,
            query,
          }),
        };
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
    }
    case 'recipe find': {
      argumentCount(command, 0, Infinity);
      const homeDir = browserPawHome();
      const url = typeof options.url === 'string' ? options.url : undefined;
      const query = command.operands.join(' ').trim();
      try {
        return {
          content: [],
          structuredContent: findLearnedWorkflows(homeDir, {
            includeCandidates: Boolean(options.all),
            url,
            query,
          }),
        };
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
    }
    case 'recipe show': {
      argumentCount(command, 1);
      const homeDir = browserPawHome();
      let inspected;
      try {
        inspected = showLearnedWorkflow(first, homeDir);
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      if (!inspected) {
        return {
          content: [{ type: 'text', text: `Unknown learned skill or recipe: ${first}.` }],
          structuredContent: {
            success: false,
            code: 'recipe_not_found',
            error: `Unknown learned skill or recipe: ${first}.`,
          },
          isError: true,
        };
      }
      return {
        content: [],
        structuredContent: {
          ...inspected.summary,
          definition: inspected.definition,
        },
      };
    }
    case 'recipe run': {
      argumentCount(command, 1, Infinity);
      const homeDir = browserPawHome();
      let rawInputs: Record<string, string>;
      try {
        rawInputs = parseRecipeKeyValues(command.operands.slice(1));
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      let inspected;
      try {
        inspected = showLearnedWorkflow(first, homeDir);
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      if (!inspected) {
        return {
          content: [{ type: 'text', text: `Unknown learned skill or recipe: ${first}.` }],
          structuredContent: {
            success: false,
            code: 'recipe_not_found',
            error: `Unknown learned skill or recipe: ${first}.`,
          },
          isError: true,
        };
      }
      if (inspected.summary.kind === 'skill') {
        const skillResult = await run('chrome_skill', { action: 'get', id: first });
        const skillMeta = tryParseCallResult(skillResult);
        if ((skillMeta?.status ?? inspected.summary.status) === 'candidate') {
          return {
            content: [],
            structuredContent: {
              success: false,
              status: 'blocked',
              code: 'skill_unvalidated',
              error: `Skill ${first} is a candidate and has not been validated yet. Run browserpaw recipe validate ${first} first.`,
            },
            isError: true,
          };
        }
        if (failed(skillResult)) return skillResult;
        let coercedInputs: Record<string, unknown>;
        try {
          const inputSchema = (skillMeta?.definition as Fields | undefined)?.inputSchema;
          coercedInputs = coerceWorkflowInputs(
            rawInputs,
            inputSchema ? schemaToInputSpecs(inputSchema) : inspected.summary.inputs,
          );
        } catch (error) {
          throw new CommandError(error instanceof Error ? error.message : String(error));
        }
        return run('chrome_skill', { action: 'run', id: first, inputs: coercedInputs });
      }
      const definition = inspected.definition as SavedRecipe;
      let steps: string[][];
      try {
        const coercedInputs = coerceWorkflowInputs(rawInputs, definition.inputs);
        steps = expandRecipeSteps(recipeSteps(definition.steps), coercedInputs);
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      const needsAutoTask =
        !options.task && !options.tab && steps.some((step) => step[0] === 'open');
      if (!needsAutoTask) return runBatch(steps, options, signal);

      const started = await handleBrowserCall(
        'chrome_task',
        { action: 'start', name: `Recipe: ${first}` },
        taskPrefix,
        signal,
      );
      const startedData = tryParseCallResult(started);
      const autoTaskId = (startedData?.task as Fields | undefined)?.id;
      if (failed(started) || typeof autoTaskId !== 'string') return started;
      let batchResult: BackendResult | undefined;
      let batchError: unknown;
      try {
        batchResult = await runBatch(steps, { ...options, task: autoTaskId }, signal);
      } catch (error) {
        batchError = error;
      }
      let cleanupError: string | undefined;
      try {
        const finished = await handleBrowserCall(
          'chrome_task',
          { action: 'finish', taskId: autoTaskId },
          taskPrefix + autoTaskId,
          AbortSignal.timeout(15000),
        );
        if (failed(finished)) {
          const data = tryParseCallResult(finished);
          const errorBlock = finished.content?.find((block) => block.type === 'text');
          cleanupError = String(
            data?.error ??
              data?.message ??
              (errorBlock?.type === 'text' ? errorBlock.text : undefined) ??
              'chrome_task finish failed',
          );
        }
      } catch (error) {
        cleanupError = error instanceof Error ? error.message : String(error);
      }
      if (batchError) {
        return {
          content: [],
          structuredContent: {
            success: false,
            status: 'failed',
            taskId: autoTaskId,
            error: batchError instanceof Error ? batchError.message : String(batchError),
            ...(cleanupError
              ? {
                  cleanupPending: true,
                  cleanupError,
                  recovery: `browserpaw task finish ${autoTaskId}`,
                }
              : {}),
          },
          isError: true,
        };
      }
      const data = tryParseCallResult(batchResult!) ?? {};
      if (!cleanupError)
        return { ...batchResult!, structuredContent: { ...data, taskId: autoTaskId } };
      return {
        ...batchResult!,
        isError: true,
        structuredContent: {
          ...data,
          taskId: autoTaskId,
          cleanupPending: true,
          cleanupError,
          recovery: `browserpaw task finish ${autoTaskId}`,
          ...(!failed(batchResult!)
            ? {
                success: false,
                status: 'cleanup_pending',
                error: `Recipe completed, but task cleanup failed: ${cleanupError}. Run browserpaw task finish ${autoTaskId}.`,
              }
            : {}),
        },
      };
    }
    case 'recipe save': {
      argumentCount(command, 1);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new CommandError('Expected a recipe object with id and steps.');
      if (isVerifiedSkillPayload(input)) {
        const proposed = await run('chrome_skill', { action: 'propose', definition: input });
        if (failed(proposed)) return proposed;
        const data = tryParseCallResult(proposed) ?? {};
        return {
          ...proposed,
          structuredContent: {
            ...data,
            kind: 'skill',
            next: `Run browserpaw recipe validate ${String(data.id ?? (input as Fields).id)} to verify and activate.`,
          },
        };
      }
      const homeDir = browserPawHome();
      let validated: SavedRecipe;
      let path: string;
      try {
        validated = validateSavedRecipe(input);
        path = savedRecipeFilePath(validated.id, homeDir);
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      const skillCollision = loadLearnedWorkflows(homeDir, { includeCandidates: true }).find(
        (workflow) => workflow.id === validated.id && workflow.kind === 'skill',
      );
      if (skillCollision)
        throw new CommandError(
          `Recipe ID ${validated.id} is already used by a built-in or active Skill. Choose a distinct ID such as ${validated.id}-recipe and save again.`,
          'recipe_id_conflict',
        );
      const { ensureDirectory, atomicWrite } = require('./cli-files.cjs');
      ensureDirectory(recipesDirectory(homeDir));
      atomicWrite(path, JSON.stringify(validated, null, 2) + '\n');
      const routing = syncLearnedRouting(homeDir);
      return {
        content: [],
        structuredContent: {
          id: validated.id,
          kind: 'recipe',
          path,
          command: formatRunCommand(validated.id, savedRecipeInputs(validated)),
          learnedCount: routing.workflowCount,
          routingSynced: routing.syncedSkillPaths,
        },
      };
    }
    case 'recipe validate': {
      argumentCount(command, 1);
      const validated = await run('chrome_skill', { action: 'validate', id: first });
      if (failed(validated)) return validated;
      const routing = syncLearnedRouting(browserPawHome());
      const data = tryParseCallResult(validated) ?? {};
      return {
        ...validated,
        structuredContent: {
          ...data,
          learnedCount: routing.workflowCount,
          routingSynced: routing.syncedSkillPaths,
        },
      };
    }
    case 'recipe rm': {
      argumentCount(command, 1);
      const homeDir = browserPawHome();
      let filePath: string;
      try {
        filePath = savedRecipeFilePath(first, homeDir);
      } catch (error) {
        throw new CommandError(error instanceof Error ? error.message : String(error));
      }
      const canonical = showLearnedWorkflow(first, homeDir);
      let removedKind: 'recipe' | 'skill' | undefined;
      const hadSavedRecipe = existsSync(filePath);
      if (canonical?.summary.kind === 'skill') {
        const disabled = await run('chrome_skill', { action: 'disable', id: first });
        if (failed(disabled)) return disabled;
        removedKind = 'skill';
      } else if (hadSavedRecipe) {
        await rm(filePath, { force: true });
        removedKind = 'recipe';
      } else if (existsSync(join(skillsDirectory(homeDir), `${first}.json`))) {
        const disabled = await run('chrome_skill', { action: 'disable', id: first });
        if (failed(disabled)) return disabled;
        removedKind = 'skill';
      }
      const routing = syncLearnedRouting(homeDir);
      return {
        content: [],
        structuredContent: {
          id: first,
          removed: true,
          ...(removedKind ? { kind: removedKind } : {}),
          learnedCount: routing.workflowCount,
          routingSynced: routing.syncedSkillPaths,
        },
      };
    }
    default:
      throw new CommandError(`Unsupported browser command ${name}.`);
  }
}

function attachMatchedRecipes(result: BackendResult, url: string): BackendResult {
  if (failed(result) || !/^https?:\/\//i.test(url)) return result;
  try {
    const active = loadLearnedWorkflows(browserPawHome(), { includeCandidates: false });
    const matches = matchLearnedWorkflows(active, { url }).slice(0, 3);
    if (!matches.length) return result;
    const data = tryParseCallResult(result) ?? {};
    return {
      ...result,
      structuredContent: {
        ...data,
        matchedRecipes: matches.map((item) => ({
          id: item.id,
          name: item.name,
          command: item.command,
        })),
      },
    };
  } catch {
    return result;
  }
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
    assertBatchStep(parsed);
    return {
      ...parsed,
      options: {
        ...parsed.options,
        ...(options.task === undefined ? {} : { task: options.task }),
        ...(options.tab === undefined ? {} : { tab: options.tab }),
        ...(options.frame === undefined ? {} : { frame: options.frame }),
      },
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
