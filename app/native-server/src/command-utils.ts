import { isProfileCommand, type CallToolResult, type ParsedCommand } from 'chrome-mcp-shared';

export type CommandRun = (
  backend: string,
  args?: Record<string, unknown>,
  includeContext?: boolean,
) => Promise<CallToolResult>;

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

export function argumentCount(command: ParsedCommand, minimum: number, maximum = minimum) {
  if (command.operands.length < minimum || command.operands.length > maximum)
    throw new CommandError(`Incorrect operands. Run browserpaw help ${command.name}.`);
}

const STANDALONE_COMMANDS = new Set([
  'setup',
  'status',
  'uninstall',
  'help',
  'search',
  'batch',
  'task resume',
]);

export function assertBatchStep({ name, options }: ParsedCommand): void {
  if (
    STANDALONE_COMMANDS.has(name) ||
    isProfileCommand(name) ||
    name.startsWith('recipe ') ||
    options.file ||
    options.input ||
    (name !== 'download' && options.out !== undefined)
  )
    throw new CommandError(`Command ${name} is unavailable inside a batch.`);
}

export function parseTarget(value: string): Record<string, unknown> {
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
