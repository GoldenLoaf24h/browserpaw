import { randomUUID, createHash } from 'node:crypto';
import { access, readFile, copyFile, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  commandHelp,
  searchCommands,
  isProfileCommand,
  parseCommand,
  CURRENT_VERSION,
  DEFAULT_SERVER_PORT,
  GITHUB_REPO_URL,
  MIN_COMPATIBLE_EXTENSION_VERSION,
  isCompatibleExtensionVersion,
  isNewerVersion,
} from 'chrome-mcp-shared';
import type { ParsedCommand } from 'chrome-mcp-shared';
import { checkForCliUpdate, maybeDelegateToManagedCli } from './cli-update';
import { readBridgeToken } from './server/token';
import { pruneOutput } from './output-retention';

type Fields = Record<string, unknown>;
type Block = { type: string; text?: string; data?: string; mimeType?: string };
type BackendResult = { content?: Block[]; structuredContent?: Fields; isError?: boolean };
const outputRoot = () =>
  resolve(process.env.BROWSERPAW_HOME || join(homedir(), '.browserpaw'), 'out');

export function resultData(result: BackendResult): Fields | undefined {
  if (result.structuredContent) return result.structuredContent;
  for (const block of result.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('{'))
      continue;
    try {
      const data: unknown = JSON.parse(block.text);
      if (data && typeof data === 'object' && !Array.isArray(data)) return data as Fields;
    } catch {
      continue;
    }
  }
}

export async function requestHost(
  route: string,
  body?: Fields,
  timeout = 360000,
  signal?: AbortSignal,
) {
  const configuration: Fields = await readFile(resolve(outputRoot(), '..', 'host.json'), 'utf8')
    .then((value) => JSON.parse(value) as Fields)
    .catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return {};
    });
  const port = Number(process.env.BROWSERPAW_PORT || configuration.port || DEFAULT_SERVER_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Invalid BROWSERPAW_PORT.');
  const timeLimit = AbortSignal.timeout(timeout);
  return fetch(`http://127.0.0.1:${port}/v1/${route}`, {
    method: body ? 'POST' : 'GET',
    redirect: 'error',
    headers: {
      'x-browserpaw-token': readBridgeToken(),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: signal ? AbortSignal.any([signal, timeLimit]) : timeLimit,
  });
}

function writeReceipt(result: Fields, json: boolean) {
  if (!json && !result.ok) {
    const error = result.error as Fields;
    console.error([error.message, error.hint].filter(Boolean).join('\n'));
    if (result.data) console.log(JSON.stringify(result.data, null, 2));
    return;
  }
  console.log(JSON.stringify(json ? result : result.data, null, json ? undefined : 2));
}

function receiptDirectory(command: ParsedCommand, requestId: string) {
  return join(
    outputRoot(),
    typeof command.options.task === 'string' && /^[a-f0-9-]{36}$/i.test(command.options.task)
      ? command.options.task
      : 'misc',
    requestId,
  );
}

async function saveOutput(result: BackendResult, command: ParsedCommand, requestId: string) {
  const directory = receiptDirectory(command, requestId);
  const { ensureDirectory, atomicWrite, assertNoLinks } = require('./cli-files.cjs');
  const rawPath = join(directory, 'result.json');
  const raw = JSON.stringify(result) + '\n';
  const saveRaw = () => {
    ensureDirectory(directory);
    atomicWrite(rawPath, raw);
    return rawPath;
  };
  let resultPath = raw.length > 8000 || command.name === 'screenshot' ? saveRaw() : undefined;
  let artifactNumber = 0;
  const references = new Map<string, Fields>();
  function save(block: Block, bytes: Buffer, stamp: string, extension: string) {
    if (references.has(stamp)) return references.get(stamp)!;
    ensureDirectory(directory);
    const path = join(directory, `item-${++artifactNumber}${extension}`);
    atomicWrite(path, bytes);
    const reference = {
      type: 'artifact_ref',
      originalType: block.type,
      path,
      mimeType: block.mimeType,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    references.set(stamp, reference);
    return reference;
  }
  function discover(value: unknown) {
    if (Array.isArray(value)) {
      value.forEach(discover);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Block & { resource?: { mimeType?: string; blob?: string } };
    const data =
      item.type === 'image' || item.type === 'audio'
        ? item.data
        : item.type === 'resource'
          ? item.resource?.blob
          : undefined;
    if (typeof data === 'string') {
      const mimeType = item.mimeType ?? item.resource?.mimeType;
      const extension =
        mimeType === 'image/png'
          ? '.png'
          : mimeType === 'image/jpeg'
            ? '.jpg'
            : mimeType === 'image/webp'
              ? '.webp'
              : mimeType?.startsWith('text/')
                ? '.txt'
                : '.bin';
      const bytes = Buffer.from(data, 'base64');
      if (bytes.toString('base64') !== data) throw new Error('Invalid media in browser receipt.');
      save({ ...item, mimeType }, bytes, data, extension);
      return;
    }
    Object.values(value).forEach(discover);
  }
  if (
    command.name === 'bookmark export' &&
    !result.isError &&
    typeof command.options.out === 'string'
  ) {
    const body = result.content?.find((block) => block.type === 'text')?.text;
    if (!body) throw new Error('Browser did not return a bookmark export.');
    const target = resolve(command.options.out);
    ensureDirectory(dirname(target));
    const temp = join(directory, 'bookmarks');
    ensureDirectory(directory);
    atomicWrite(temp, body);
    await copyFile(temp, target, constants.COPYFILE_EXCL);
    return { ...resultData(result), outputPath: target, bytes: Buffer.byteLength(body) };
  }
  discover(result);
  function compact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compact);
    if (value && typeof value === 'object') {
      const item = value as Block & { resource?: { blob?: string } };
      const payload = item.data ?? item.resource?.blob;
      if (payload && references.has(payload)) return references.get(payload);
      return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, compact(part)]));
    }
    if (typeof value !== 'string') return value;
    if (references.has(value)) return references.get(value);
    const max =
      typeof command.options['max-chars'] === 'string'
        ? Math.min(Number(command.options['max-chars']), 30000)
        : 8000;
    if (value.length > max)
      return save({ type: 'text', mimeType: 'text/plain' }, Buffer.from(value), value, '.txt');
    for (const [payload, reference] of references) {
      if (payload && value.includes(payload))
        return value.split(payload).join(`[file: ${reference.path}]`);
    }
    return value;
  }
  const data = resultData(result);
  const content = result.content?.filter((block, index) => {
    if (!data || index !== 0 || block.type !== 'text') return true;
    try {
      return JSON.stringify(JSON.parse(block.text ?? '')) !== JSON.stringify(data);
    } catch {
      return true;
    }
  });
  const view = compact({ ...data, ...(content?.length ? { content } : {}) }) as Fields;
  if (
    ['screenshot', 'network show', 'pdf', 'perf trace'].includes(command.name) &&
    typeof command.options.out === 'string' &&
    !result.isError &&
    data?.success !== false
  ) {
    let source: string;
    if (command.name === 'screenshot' || command.name === 'network show') {
      const type = command.name === 'screenshot' ? 'image' : 'resource';
      const file = [...references.values()].find((item) => item.originalType === type);
      if (!file)
        throw new Error(
          `Browser did not return a captured ${type === 'image' ? 'image' : 'response body'}.`,
        );
      source = String(file.path);
    } else {
      const file = data?.file as Fields | undefined;
      if (typeof file?.path !== 'string')
        throw new Error('Browser did not return a trace or PDF file.');
      source = resolve(file.path);
      const inside = relative(join(tmpdir(), 'chrome-mcp-uploads'), source);
      const expected = command.name === 'pdf' ? '.pdf' : '.json';
      if (
        !inside ||
        inside === '..' ||
        inside.startsWith('..' + sep) ||
        isAbsolute(inside) ||
        extname(source) !== expected
      )
        throw new Error('Browser output is outside the Native temporary files.');
      assertNoLinks(source);
      if (!(await lstat(source)).isFile())
        throw new Error('Browser output must be a regular file.');
    }
    const target = resolve(command.options.out);
    ensureDirectory(dirname(target));
    await copyFile(source, target, constants.COPYFILE_EXCL);
    view.outputPath = target;
  }
  if (artifactNumber || JSON.stringify(view).length > 30000) {
    resultPath ??= saveRaw();
    if (JSON.stringify(view).length > 30000) {
      return {
        resultPath,
        artifacts: [...references.values()].slice(0, 12),
        ...(view.outputPath ? { outputPath: view.outputPath } : {}),
        ...(view.captureId ? { captureId: view.captureId } : {}),
        ...(view.task ? { task: view.task } : {}),
      };
    }
  }
  if (resultPath) view.resultPath = resultPath;
  return view;
}

async function inputFor(command: ParsedCommand) {
  const file =
    command.name === 'batch' || command.name === 'recipe save'
      ? command.operands[0]
      : command.name === 'fill'
        ? command.options.input
        : command.name === 'eval'
          ? command.options.file
          : undefined;
  if (typeof file !== 'string') return undefined;
  const data = file === '-' ? await readStdin() : await readFile(file, 'utf8');
  if (command.name === 'eval' || command.name === 'fill') return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new Error('Input is not valid JSON.');
  }
}

async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 8 * 1024 * 1024) throw new Error('Input is too large.');
  }
  return text;
}

async function ensureHostMatchesCliVersion(): Promise<void> {
  const root = resolve(outputRoot(), '..');
  const hostInfo: Fields | undefined = await readFile(join(root, 'host.json'), 'utf8')
    .then((value) => JSON.parse(value) as Fields)
    .catch(() => undefined);
  if (typeof hostInfo?.version !== 'string' || !isNewerVersion(CURRENT_VERSION, hostInfo.version)) {
    return;
  }
  const stagedMatches = async (): Promise<boolean> =>
    readFile(join(root, 'host', 'host-version.txt'), 'utf8')
      .then((value) => value.trim() === CURRENT_VERSION)
      .catch(() => false);
  let readyToRestart = await stagedMatches();
  if (!readyToRestart) {
    try {
      const { syncInstalledHostFromDist } = await import('./cli-setup.js');
      syncInstalledHostFromDist(root, __dirname, CURRENT_VERSION);
    } catch {
      return;
    }
    readyToRestart = await stagedMatches();
  }
  if (!readyToRestart) return;
  const restarted = await requestHost('restart', {}, 1500)
    .then((res) => res.status === 202)
    .catch(() => false);
  if (!restarted) return;
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    const refreshed: Fields | undefined = await readFile(join(root, 'host.json'), 'utf8')
      .then((value) => JSON.parse(value) as Fields)
      .catch(() => undefined);
    if (refreshed?.version === CURRENT_VERSION) {
      const ready = await requestHost('status', undefined, 1000)
        .then((res) => res.ok)
        .catch(() => false);
      if (ready) return;
    }
  }
}

export async function runCommands(inputArgs: string[]): Promise<number> {
  const delegatedCode = await maybeDelegateToManagedCli(inputArgs);
  if (delegatedCode !== undefined) return delegatedCode;
  const argv = inputArgs.slice();
  if (argv[0] === '--json') {
    argv.shift();
    const end = argv.indexOf('--');
    argv.splice(end === -1 ? argv.length : end, 0, '--json');
  }
  let json = argv
    .slice(0, argv.indexOf('--') === -1 ? undefined : argv.indexOf('--'))
    .includes('--json');
  let command: ParsedCommand | undefined;
  let accepted = false;
  let knownResult: BackendResult | undefined;
  let update: ReturnType<typeof checkForCliUpdate> | undefined;
  const controller = new AbortController();
  const requestId = randomUUID();
  const interrupt = () => {
    if (!accepted) return;
    void requestHost('cancel', { requestId }, 1500)
      .catch(() => {})
      .finally(() => controller.abort());
  };
  const failure = (code: number, errorCode: string, message: string, data?: unknown) => {
    const receipt = knownResult ? resultData(knownResult) : undefined;
    const status =
      code === 4
        ? 'unknown'
        : receipt?.status === 'blocked' ||
            ['busy', 'extension_disconnected', 'host_unavailable'].includes(errorCode)
          ? 'blocked'
          : receipt?.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
    const requestDispatched =
      typeof receipt?.requestDispatched === 'boolean'
        ? receipt.requestDispatched
        : !accepted || code === 2 || code === 3 || errorCode === 'busy'
          ? false
          : knownResult && status !== 'blocked'
            ? true
            : null;
    writeReceipt(
      {
        ok: false,
        command: command?.name ?? argv[0],
        requestId,
        outcome: code === 4 ? 'unknown' : 'failed',
        status,
        requestDispatched,
        ...(command?.options.task ? { taskId: command.options.task } : {}),
        ...(command?.options.tab ? { tabId: Number(command.options.tab) } : {}),
        ...(data === undefined ? {} : { data }),
        error: {
          code: errorCode,
          message,
          retry: false,
          ...(code === 4
            ? { hint: 'Observe the page or check task status before acting again.' }
            : code === 3
              ? { hint: 'Run browserpaw status and check the BrowserPaw extension.' }
              : {}),
        },
      },
      json,
    );
    return code;
  };
  try {
    if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
      console.log(commandHelp());
      return 0;
    }
    if (argv[0] === '--version' || argv[0] === '-V') {
      console.log(CURRENT_VERSION);
      return 0;
    }
    const terminator = argv.indexOf('--');
    const flags = argv.slice(0, terminator < 0 ? undefined : terminator);
    if (flags.includes('--help') || flags.includes('-h') || argv[0] === 'help') {
      const topic = flags
        .filter((arg) => !['help', '--help', '-h', '--json'].includes(arg))
        .join(' ');
      console.log(commandHelp(topic || undefined));
      return 0;
    }
    command = parseCommand(argv);
    json = command.options.json === true;
    if (command.name === 'search') {
      const { options, operands } = command;
      const query = operands.join(' ').trim();
      if (!query)
        return failure(2, 'invalid_arguments', 'Provide keywords. Run browserpaw help search.');
      if (options.task || options.tab || options.frame)
        return failure(2, 'invalid_arguments', 'Command search does not accept a page or task.');
      const limit = options.limit === undefined ? 8 : Number(options.limit);
      if (
        (options.limit !== undefined && !/^\d+$/.test(String(options.limit))) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        return failure(2, 'invalid_arguments', '--limit must be an integer from 1 to 50.');
      const matches = searchCommands(query);
      const items = matches.slice(0, limit);
      if (json)
        writeReceipt(
          {
            ok: true,
            command: 'search',
            outcome: 'done',
            data: { query, totalMatches: matches.length, items },
          },
          true,
        );
      else if (!items.length)
        console.log('No matching commands. Try another keyword or run browserpaw help.');
      else {
        console.log(
          items
            .map(({ usage, summary, example }) =>
              [usage, `  ${summary}`, ...(example ? [`  Example: ${example}`] : [])].join('\n'),
            )
            .join('\n\n'),
        );
        if (items.length < matches.length)
          console.log(
            `\nShowing ${items.length} of ${matches.length} matches. Refine the query or increase --limit.`,
          );
      }
      return 0;
    }
    if (command.name !== 'setup' && command.name !== 'uninstall') update = checkForCliUpdate();
    if (
      !command.options.task &&
      !command.options.tab &&
      !(command.name === 'task status' && command.operands.length) &&
      process.env.BROWSERPAW_TASK &&
      !isProfileCommand(command.name) &&
      ![
        'task start',
        'task list',
        'tab close',
        'status',
        'doctor',
        'setup',
        'uninstall',
        'recipe list',
        'recipe find',
        'recipe show',
        'recipe save',
        'recipe patch',
        'recipe validate',
        'recipe rm',
      ].includes(command.name)
    ) {
      const end = argv.indexOf('--');
      argv.splice(end === -1 ? argv.length : end, 0, '--task', process.env.BROWSERPAW_TASK);
      command = parseCommand(argv);
    }
    if (['recipe list', 'recipe find', 'recipe show'].includes(command.name)) {
      const { browserPawHome, findLearnedWorkflows, listLearnedWorkflows, showLearnedWorkflow } =
        await import('./learned-recipes.js');
      const homeDir = browserPawHome();
      if (command.name === 'recipe list') {
        if (command.operands.length)
          return failure(
            2,
            'invalid_arguments',
            'Usage: browserpaw recipe list [--url URL] [--query TEXT] [--all].',
          );
        const url = typeof command.options.url === 'string' ? command.options.url : undefined;
        const query = typeof command.options.query === 'string' ? command.options.query : undefined;
        writeReceipt(
          {
            ok: true,
            command: command.name,
            outcome: 'done',
            data: listLearnedWorkflows(homeDir, {
              includeCandidates: Boolean(command.options.all),
              url,
              query,
            }),
          },
          json,
        );
        return 0;
      }
      if (command.name === 'recipe find') {
        const url = typeof command.options.url === 'string' ? command.options.url : undefined;
        const query = command.operands.join(' ').trim();
        writeReceipt(
          {
            ok: true,
            command: command.name,
            outcome: 'done',
            data: findLearnedWorkflows(homeDir, {
              includeCandidates: Boolean(command.options.all),
              url,
              query,
            }),
          },
          json,
        );
        return 0;
      }
      if (command.operands.length !== 1)
        return failure(2, 'invalid_arguments', 'Usage: browserpaw recipe show ID.');
      const inspected = showLearnedWorkflow(command.operands[0], homeDir);
      if (!inspected)
        return failure(
          1,
          'recipe_not_found',
          `Unknown learned skill or recipe: ${command.operands[0]}.`,
        );
      writeReceipt(
        {
          ok: true,
          command: command.name,
          outcome: 'done',
          data: { ...inspected.summary, definition: inspected.definition },
        },
        json,
      );
      return 0;
    }
    if (['setup', 'uninstall', 'doctor'].includes(command.name)) {
      if (command.operands.length)
        return failure(2, 'invalid_arguments', 'Unexpected command operands.');
      const { manageInstallation } = await import('./cli-setup.js');
      const data = await manageInstallation(command, requestHost);
      writeReceipt({ ok: true, command: command.name, outcome: 'done', data }, json);
      return 0;
    }
    if (command.name === 'status') {
      if (command.operands.length)
        return failure(2, 'invalid_arguments', 'Usage: browserpaw status.');
      await ensureHostMatchesCliVersion();
      const response = await requestHost('status', undefined, 4000);
      if (!response.ok) return failure(3, 'host_unavailable', 'Cannot read the local host status.');
      const data = (await response.json()) as Fields;
      if (!data.connected)
        return failure(3, 'extension_disconnected', 'The extension is disconnected.', data);
      const extension = data.extension as Fields | undefined;
      if (data.version === CURRENT_VERSION && typeof extension?.manifestVersion !== 'string')
        return failure(
          3,
          'extension_status_unavailable',
          'Could not read extension diagnostics.',
          data,
        );
      const extensionVersion =
        typeof extension?.manifestVersion === 'string' ? extension.manifestVersion : undefined;
      if (
        data.version !== CURRENT_VERSION ||
        !isCompatibleExtensionVersion(extensionVersion, CURRENT_VERSION)
      ) {
        return failure(
          3,
          'version_mismatch',
          `BrowserPaw ${CURRENT_VERSION} requires host ${CURRENT_VERSION} and a compatible extension (>= ${MIN_COMPATIBLE_EXTENSION_VERSION}, same major). Run setup with the matching CLI to update the host and Skill. For an incompatible extension, manually install ${GITHUB_REPO_URL}/releases/download/v${CURRENT_VERSION}/browserpaw-extension.zip and reload it.`,
          data,
        );
      }
      const syncDir =
        !process.env.BROWSERPAW_HOME && process.env.BROWSERPAW_EXTENSION_SYNC_DIR?.trim()
          ? resolve(process.env.BROWSERPAW_EXTENSION_SYNC_DIR)
          : undefined;
      const extensionDir = syncDir ?? resolve(outputRoot(), '..', 'extension');
      const readExtensionJson = (file: string) =>
        readFile(join(extensionDir, file), 'utf8')
          .then((value) => JSON.parse(value) as Fields)
          .catch((error) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          });
      const localManifest = await readExtensionJson('manifest.json');
      const localBuild =
        localManifest?.version === extensionVersion
          ? await readExtensionJson('browserpaw-build.json')
          : undefined;
      if (localBuild?.buildId && localBuild.buildId !== extension?.buildId)
        return failure(
          3,
          'build_mismatch',
          'Reload the installed BrowserPaw extension in chrome://extensions.',
          data,
        );
      const statusData =
        extensionVersion && isNewerVersion(CURRENT_VERSION, extensionVersion)
          ? {
              ...data,
              extensionUpdateAvailable: true,
              extensionLatestVersion: CURRENT_VERSION,
              extensionReleaseAsset: `${GITHUB_REPO_URL}/releases/download/v${CURRENT_VERSION}/browserpaw-extension.zip`,
            }
          : data;
      writeReceipt({ ok: true, command: command.name, outcome: 'done', data: statusData }, json);
      return 0;
    }
    if (command.name === 'upload') {
      const paths = command.operands.slice(1).map((file) => resolve(file));
      const global = Object.entries(command.options).flatMap(([key, value]) =>
        value === true ? ['--' + key] : ['--' + key, String(value)],
      );
      argv.splice(0, argv.length, 'upload', ...global, '--', command.operands[0], ...paths);
    }
    if (command.name === 'download' && typeof command.options.out === 'string') {
      const out = resolve(command.options.out);
      const index = argv.findIndex((token) => token === '--out' || token.startsWith('--out='));
      if (argv[index] === '--out') argv[index + 1] = out;
      else argv[index] = '--out=' + out;
    }
    const input = await inputFor(command);
    if (!command.options.task && !process.env.BROWSERPAW_TASK) {
      await ensureHostMatchesCliVersion();
    }
    process.once('SIGINT', interrupt);
    accepted = true;
    const response = await requestHost(
      'run',
      { requestId, argv, input },
      360000,
      controller.signal,
    );
    const body = (await response.json()) as {
      result?: BackendResult;
      code?: string;
      message?: string;
    };
    if (!response.ok)
      return failure(
        response.status === 400 ? 2 : response.status >= 500 ? 4 : response.status === 409 ? 1 : 3,
        body.code ?? 'host_error',
        body.message ?? `Host returned HTTP ${response.status}.`,
      );
    if (!body.result || !Array.isArray(body.result.content))
      throw new Error('Invalid local host receipt.');
    const result = (knownResult = body.result);
    const data = resultData(result);
    const errorText =
      typeof data?.error === 'string'
        ? data.error
        : String(
            result.content?.find((block) => block.type === 'text')?.text ??
              'Browser operation failed.',
          );
    let view: Fields;
    try {
      view = await saveOutput(result, command, requestId);
    } catch (error) {
      if (!(result.isError || data?.ok === false || data?.success === false)) throw error;
      view = { ...data, outputError: error instanceof Error ? error.message : String(error) };
    }
    if (
      data?.status === 'unknown' ||
      data?.outcome === 'unknown' ||
      (data?.requestDispatched === true && data?.status === 'cancelled')
    )
      return failure(4, 'outcome_unknown', errorText.slice(0, 500), view);
    if (result.isError || data?.ok === false || data?.success === false)
      return failure(
        data?.code === 'extension_disconnected' || /extension is not connected/i.test(errorText)
          ? 3
          : 1,
        String(data?.code ?? data?.status ?? 'command_failed'),
        errorText.slice(0, 500),
        view,
      );
    writeReceipt(
      {
        ok: true,
        command: command.name,
        requestId,
        outcome: 'done',
        ...(command.options.task ? { taskId: command.options.task } : {}),
        ...((data?.tabId ?? command.options.tab)
          ? { tabId: Number(data?.tabId ?? command.options.tab) }
          : {}),
        data: view,
      },
      json,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (knownResult && command) {
      const resultPath = join(receiptDirectory(command, requestId), 'result.json');
      const saved = await access(resultPath).then(
        () => true,
        () => false,
      );
      const outcome = resultData(knownResult)?.status;
      return failure(outcome === 'unknown' ? 4 : 1, 'output_failed', message, {
        ...(saved ? { resultPath } : {}),
        ...(outcome ? { browserStatus: outcome } : {}),
      });
    }
    if (!accepted)
      return failure(
        command?.name === 'status' ? 3 : command ? 1 : 2,
        command ? 'local_error' : 'invalid_arguments',
        message,
      );
    const cause = (error as { cause?: { code?: string } }).cause?.code;
    if (cause === 'ECONNREFUSED' || /bridge token/i.test(message))
      return failure(3, 'host_unavailable', message);
    return failure(4, 'outcome_unknown', message);
  } finally {
    process.removeListener('SIGINT', interrupt);
    if (knownResult && command) {
      const directory = receiptDirectory(command, requestId);
      if (
        await access(directory).then(
          () => true,
          () => false,
        )
      )
        await pruneOutput(outputRoot(), directory).catch(() => {});
    }
    const latest = await update;
    if (latest) {
      console.error(
        [
          `BrowserPaw ${latest} is available (installed: ${CURRENT_VERSION}).`,
          'Finish the current task before upgrading with your existing installation method.',
          `Global npm: npm install -g browserpaw@${latest}, then browserpaw setup.`,
          `npx: npx browserpaw@${latest} setup. Setup refreshes the host and managed base Skills.`,
          `Chrome extension (manual download, unpack and load): ${GITHUB_REPO_URL}/releases/download/v${latest}/browserpaw-extension.zip`,
        ].join('\n'),
      );
    }
  }
}
