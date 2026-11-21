import type { CallToolResult, ParsedCommand } from 'chrome-mcp-shared';
import { argumentCount, CommandError, integer, type CommandRun } from './command-utils';

function number(value: unknown, label: string, min: number, max: number) {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < min || parsed > max)
    throw new CommandError(`${label} must be a number from ${min} to ${max}.`);
  return parsed;
}

function optionalInteger(value: unknown, label: string, min: number, max: number) {
  return value === undefined ? undefined : integer(value, label, min, max);
}

function levelList(value: unknown) {
  if (value === undefined) return undefined;
  const levels = String(value)
    .split(',')
    .map((level) => level.trim().toLowerCase())
    .filter(Boolean);
  const supported = new Set(['error', 'warning', 'warn', 'info', 'log', 'debug', 'assert']);
  const invalid = levels.find((level) => !supported.has(level));
  if (invalid)
    throw new CommandError(
      `Unsupported console level ${invalid}; use error, warning, info, log, debug, or assert.`,
    );
  return levels.length ? levels : undefined;
}

function viewport(value: unknown) {
  if (value === undefined) return undefined;
  const match = /^(\d+)x(\d+)$/i.exec(String(value));
  if (!match) throw new CommandError('Viewport must use WIDTHxHEIGHT, for example 1280x720.');
  return {
    width: integer(match[1], 'Viewport width', 1, 10000),
    height: integer(match[2], 'Viewport height', 1, 10000),
  };
}

function filterNetworkShow(command: ParsedCommand, result: CallToolResult): CallToolResult {
  const id = command.operands[0];
  if (!id || !result.content?.length) return result;
  if (result.isError) return result;
  const first = result.content[0];
  if (first.type !== 'text') return result;
  try {
    const data = JSON.parse(first.text) as Record<string, unknown>;
    const request = data.request as Record<string, unknown> | undefined;
    if (!request) return result;
    const body = typeof request.responseBody === 'string' ? request.responseBody : undefined;
    const keys = [
      'requestId',
      'url',
      'method',
      'type',
      'status',
      'statusCode',
      'statusText',
      'mimeType',
      'requestTime',
      'responseTime',
      'encodedDataLength',
      'responseSize',
      'requestBody',
      'bodyOmitted',
      'errorText',
      'specificRequestHeaders',
      'specificResponseHeaders',
    ];
    const compact = Object.fromEntries(
      keys.filter((key) => request[key] !== undefined).map((key) => [key, request[key]]),
    );
    if (body !== undefined) compact.responseBody = { chars: body.length };
    const resource = result.content.find(
      (block): block is Extract<CallToolResult['content'][number], { type: 'resource' }> =>
        block.type === 'resource' && Boolean(block.resource?.blob),
    );
    const file = resource
      ? {
          path: null,
          name: `network-${id}.txt`,
          mimeType: resource.resource.mimeType || 'text/plain',
          bytes: Math.floor((String(resource.resource.blob).length * 3) / 4),
          outputPath: command.options.out,
          resourceUri: resource.resource.uri,
          source: 'resource' as const,
        }
      : undefined;
    return {
      ...result,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ tabId: data.tabId, request: compact, ...(file ? { file } : {}) }),
        },
        ...(resource ? [resource] : []),
      ],
      structuredContent: { tabId: data.tabId, request: compact, ...(file ? { file } : {}) },
    };
  } catch {
    return result;
  }
}

export function dispatchDebug(
  command: ParsedCommand,
  run: CommandRun,
): Promise<CallToolResult> | undefined {
  const name = String(command.name);
  const { options } = command;
  const [first, second] = command.operands;

  switch (name) {
    case 'console': {
      argumentCount(command, 0);
      return run('chrome_console', {
        mode: 'buffer',
        clear: options.clear === true,
        includeExceptions: options['no-exceptions'] !== true,
        levels: levelList(options.level),
        pattern: options.grep,
        limit: optionalInteger(options.limit, 'Console limit', 0, 2000),
        waitMs: optionalInteger(options.wait, 'Console wait', 1, 300000),
      });
    }
    case 'network start': {
      argumentCount(command, 0);
      return run('chrome_network_capture', {
        action: 'start',
        needResponseBody: options.bodies === true,
        requestUrlPattern: options.filter,
        ...(options.static === true ? { includeStatic: true } : {}),
        ...(options['max-time'] === undefined
          ? {}
          : { maxCaptureTime: integer(options['max-time'], 'Capture time', 1, 1800000) }),
        ...(options.idle === undefined
          ? {}
          : { inactivityTimeout: integer(options.idle, 'Inactivity timeout', 0, 1800000) }),
      });
    }
    case 'network stop':
      argumentCount(command, 0);
      if (options.out)
        throw new CommandError(
          'network stop does not write files; use network show ID --out FILE.',
        );
      return run('chrome_network_capture', {
        action: 'stop',
        ...(options.bodies === true ? { needResponseBody: true } : {}),
      });
    case 'network list':
      argumentCount(command, 0);
      return run('chrome_network_capture', {
        action: 'list',
        requestUrlPattern: options.filter,
        method: options.method,
        status: options.status,
        resourceType: options.type,
        limit: optionalInteger(options.limit, 'Network limit', 1, 100),
      });
    case 'network show':
      argumentCount(command, 1);
      return run('chrome_network_capture', {
        action: 'show',
        requestId: first,
        ...(options.out ? { outputPath: options.out } : {}),
      }).then((result) => filterNetworkShow(command, result));
    case 'network clear':
      argumentCount(command, 0);
      return run('chrome_network_capture', { action: 'clear' });
    case 'perf metrics':
      argumentCount(command, 0);
      return run('chrome_debug', { action: 'perf_metrics' });
    case 'perf trace': {
      argumentCount(command, 1, 2);
      if (first === 'start') {
        if (second !== undefined)
          throw new CommandError('Trace start does not take an insight name.');
        const durationMs = optionalInteger(options.duration, 'Trace duration', 10, 60000);
        if (options.out)
          throw new CommandError('Trace start cannot write --out; use perf trace stop --out FILE.');
        return run('chrome_debug', {
          action: 'perf_trace_start',
          reload: options.reload === true,
          autoStop: options['auto-stop'] === true || durationMs !== undefined,
          durationMs,
        });
      }
      if (first === 'stop') {
        if (second !== undefined)
          throw new CommandError('Trace stop does not take an insight name.');
        return run('chrome_debug', {
          action: 'perf_trace_stop',
          saveToDownloads: false,
          outputPath: options.out,
        });
      }
      if (first === 'analyze')
        return run('chrome_debug', { action: 'perf_trace_analyze', insightName: second });
      throw new CommandError('Trace action must be start, stop, or analyze.');
    }
    case 'emulate reset':
      argumentCount(command, 0);
      return run('chrome_debug', { action: 'emulate_reset' });
    case 'emulate': {
      argumentCount(command, 0);
      if (options.reset === true) return run('chrome_debug', { action: 'emulate_reset' });
      const size = viewport(options.viewport);
      const mobile = options.mobile === true;
      if (mobile && !size) throw new CommandError('--mobile requires --viewport WIDTHxHEIGHT.');
      const colorScheme = options['color-scheme'];
      if (
        colorScheme !== undefined &&
        !['light', 'dark', 'no-preference'].includes(String(colorScheme))
      )
        throw new CommandError('Color scheme must be light, dark, or no-preference.');
      return run('chrome_debug', {
        action: 'emulate',
        ...(size || {}),
        ...(options.dpr === undefined
          ? {}
          : { deviceScaleFactor: number(options.dpr, 'Device scale factor', 0.1, 10) }),
        ...(mobile ? { mobile: true } : {}),
        ...(options['user-agent'] ? { userAgent: options['user-agent'] } : {}),
        ...(colorScheme ? { colorScheme } : {}),
        ...(options.timezone ? { timezoneId: options.timezone } : {}),
        ...(options.locale ? { locale: options.locale } : {}),
        ...(options['cpu-rate'] === undefined
          ? {}
          : { cpuRate: number(options['cpu-rate'], 'CPU rate', 1, 100) }),
        ...(options.offline === true ? { offline: true } : {}),
        ...(options.latency === undefined
          ? {}
          : { latency: integer(options.latency, 'Network latency', 0, 600000) }),
        ...(options['download-kbps'] === undefined
          ? {}
          : {
              downloadThroughput:
                number(options['download-kbps'], 'Download throughput', 0, 1000000) * 1024,
            }),
        ...(options['upload-kbps'] === undefined
          ? {}
          : {
              uploadThroughput:
                number(options['upload-kbps'], 'Upload throughput', 0, 1000000) * 1024,
            }),
      });
    }
    case 'pdf':
      argumentCount(command, 0);
      return run('chrome_debug', {
        action: 'pdf',
        landscape: options.landscape === true,
        printBackground: options['no-background'] !== true,
        paper: options.paper,
        margin:
          options.margin === undefined ? undefined : number(options.margin, 'PDF margin', 0, 2),
        scale: options.scale === undefined ? undefined : number(options.scale, 'PDF scale', 0.1, 2),
        displayHeaderFooter: options.header === true || options.footer === true,
        outputPath: options.out,
      });
    default:
      return undefined;
  }
}
