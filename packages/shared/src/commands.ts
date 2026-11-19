export interface CommandSpec {
  usage: string;
  summary: string;
}

export const COMMANDS = {
  setup: {
    usage: 'setup [--browser BROWSER] [--skill-dir DIR] [--no-skill]',
    summary: 'Install the host, extension, and Skill for chrome, chromium, or all.',
  },
  status: {
    usage: 'status',
    summary: 'Show local host and extension connection and build identity.',
  },
  doctor: {
    usage: 'doctor [--fix]',
    summary: 'Diagnose installation and connection. Use --fix to repair registration.',
  },
  uninstall: {
    usage: 'uninstall [--purge]',
    summary: 'Remove the managed installation. Purge also removes its user data.',
  },
  help: {
    usage: 'help [COMMAND|TOPIC]',
    summary: 'Show usage and examples without opening Chrome.',
  },
  tabs: { usage: 'tabs', summary: 'List windows and tabs with IDs.' },
  open: {
    usage: 'open URL [--foreground]',
    summary: 'Open a new tab. With --task, own the new page.',
  },
  nav: { usage: 'nav URL|back|forward|reload', summary: 'Navigate the selected page.' },
  'tab focus': { usage: 'tab focus ID', summary: 'Bring the selected tab to the foreground.' },
  'tab close': { usage: 'tab close ID...', summary: 'Close explicitly named tabs.' },
  observe: {
    usage: 'observe [--scope CSS] [--delta] [--max N]',
    summary: 'Read page structure, frame IDs, and actionable refs.',
  },
  text: {
    usage: 'text [TARGET] [--max-chars N]',
    summary: 'Read Markdown or extract text from a single target.',
  },
  find: {
    usage: 'find PATTERN [--regex] [--scroll]',
    summary: 'Find matching elements in the page.',
  },
  screenshot: {
    usage: 'screenshot [TARGET] [--full] [--out FILE]',
    summary: 'Save an image locally and return its capture ID.',
  },
  wait: {
    usage: 'wait [TARGET] [--text TEXT|--url URL] [--gone] [--timeout MS]',
    summary: 'Wait for a target, page text, or URL condition.',
  },
  console: {
    usage: 'console [--level LEVEL] [--clear]',
    summary: 'Read or clear the selected tab’s console buffer.',
  },
  'network start': {
    usage: 'network start [--filter PATTERN] [--bodies]',
    summary: 'Start a scoped network recording.',
  },
  'network stop': {
    usage: 'network stop',
    summary: 'Stop recording and return the captured events.',
  },
  'network show': { usage: 'network show', summary: 'Read currently captured network events.' },
  click: {
    usage: 'click TARGET [--double|--right] [--capture ID]',
    summary: 'Click the target from the current observation or capture.',
  },
  fill: {
    usage: 'fill TARGET TEXT [--append] [--input FILE|-]',
    summary: 'Replace or append text. Use -- before option-like text.',
  },
  select: {
    usage: 'select TARGET [VALUE...]',
    summary: 'Read available choices or select by value.',
  },
  hover: { usage: 'hover TARGET [--capture ID]', summary: 'Move the pointer to a target.' },
  press: {
    usage: 'press KEYS [TARGET]',
    summary: 'Send a key sequence, optionally to a strict target.',
  },
  scroll: {
    usage: 'scroll [TARGET] [--up|--down|--top|--bottom] [--by PX]',
    summary: 'Scroll the page or a scroll container.',
  },
  drag: {
    usage: 'drag FROM TO [--capture ID]',
    summary: 'Drag between two observed refs or capture coordinates.',
  },
  upload: {
    usage: 'upload TARGET FILE...',
    summary: 'Choose local files for the specified input.',
  },
  dialog: {
    usage: 'dialog accept|dismiss [--id ID] [--text TEXT]',
    summary: 'Handle a dialog from the selected page.',
  },
  download: {
    usage: 'download [TARGET] [--url URL] [--out DIR] [--timeout MS]',
    summary: 'Trigger and wait for a verified download from this page.',
  },
  eval: {
    usage: 'eval [CODE] [--file FILE|-] [--timeout MS]',
    summary: 'Evaluate explicit JavaScript in the selected page.',
  },
  fetch: {
    usage: 'fetch URL [--method METHOD] [--header KEY:VALUE]... [--body BODY]',
    summary: 'Send an explicit request from the selected page.',
  },
  cdp: {
    usage: 'cdp METHOD [JSON]',
    summary: 'Call a supported DevTools command in the selected tab.',
  },
  'ask-human': {
    usage: 'ask-human MESSAGE [--timeout MS]',
    summary: 'Pause at a page and ask the user to intervene.',
  },
  'task start': {
    usage: 'task start NAME [--goal TEXT]',
    summary: 'Start a durable task and return its ID.',
  },
  'task list': { usage: 'task list', summary: 'List local tasks.' },
  'task status': {
    usage: 'task status [ID]',
    summary: 'Inspect task pages and known and uncertain outcomes.',
  },
  'task finish': {
    usage: 'task finish [--keep ID]... [--keep-unknown]',
    summary: 'Close verified owned pages and preserve borrowed pages.',
  },
  'task cancel': {
    usage: 'task cancel',
    summary: 'Stop the task without rolling back dispatched work.',
  },
  'task borrow': {
    usage: 'task borrow ID',
    summary: 'Associate an existing user tab with the task.',
  },
  'task release': { usage: 'task release ID', summary: 'Hand an owned tab back to the user.' },
  batch: {
    usage: 'batch FILE|-',
    summary: 'Run JSON argument arrays in order, stopping at the first failure.',
  },
  'recipe list': { usage: 'recipe list [--url URL]', summary: 'List bundled and saved workflows.' },
  'recipe run': {
    usage: 'recipe run ID [KEY=VALUE...]',
    summary: 'Run a saved workflow with explicit inputs.',
  },
  'recipe save': { usage: 'recipe save FILE|-', summary: 'Save a reviewed workflow definition.' },
  'recipe rm': { usage: 'recipe rm ID', summary: 'Remove a locally saved workflow.' },
} satisfies Record<string, CommandSpec>;

export type CommandName = keyof typeof COMMANDS;
export type CommandOptions = Record<string, string | true | string[]>;
export interface ParsedCommand {
  name: CommandName;
  operands: string[];
  options: CommandOptions;
}

const globalOptions = '--task ID --tab ID --frame ID --json';
const repeated = new Set(['header', 'keep']);
const isCommand = (key: string): key is CommandName =>
  Object.prototype.hasOwnProperty.call(COMMANDS, key);

export function parseCommand(argv: readonly string[]): ParsedCommand {
  const qualified = `${argv[0]} ${argv[1]}`;
  const name = isCommand(qualified) ? qualified : argv[0];
  if (!isCommand(name)) throw new Error('Unknown command. Run browserpaw help.');
  const usage = COMMANDS[name].usage;
  const spec = new Map(
    [...(usage + ' ' + globalOptions).matchAll(/--([a-z-]+)(?: ([A-Z][A-Z:-]*))?/g)].map(
      ([, key, value]) => [key, Boolean(value)],
    ),
  );
  const options: CommandOptions = Object.create(null);
  const operands: string[] = [];
  const input = argv.slice(name.split(' ').length);
  for (let index = 0; index < input.length; index++) {
    const token = input[index];
    if (token === '--') {
      operands.push(...input.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      operands.push(token);
      continue;
    }
    const key = token.slice(2);
    if (!spec.has(key)) throw new Error(`Unknown option ${token} for ${name}.`);
    if (options[key] !== undefined && !repeated.has(key))
      throw new Error(`Repeated option ${token}.`);
    if (!spec.get(key)) {
      options[key] = true;
      continue;
    }
    const value = input[++index];
    if (value === undefined || value.startsWith('--'))
      throw new Error(`Missing value for ${token}.`);
    options[key] = repeated.has(key) ? [...((options[key] as string[]) ?? []), value] : value;
  }
  return { name, operands, options };
}

export const TARGET_HELP =
  'Targets: 12 (observed ref), css:SELECTOR, text:TEXT, role:ROLE[:NAME], label:LABEL, or @X,Y --capture ID. Use --frame ID to select a frame. After navigation or a stale ref, observe again.';

const examples: Partial<Record<CommandName, readonly string[]>> = {
  open: ['open https://example.com --task TASK_ID', 'open https://example.com --foreground'],
  observe: ['observe --task TASK_ID --json', 'observe --scope css:main --tab 12'],
  click: ['click 7 --task TASK_ID --frame 0', 'click @120,240 --capture CAPTURE_ID --tab 12'],
  fill: ['fill label:Email agent@example.com --tab 12', 'fill 8 --task TASK_ID --input draft.txt'],
  select: ['select 19 --tab 12', 'select 19 blue red --tab 12'],
  screenshot: ['screenshot --task TASK_ID --out page.png', 'screenshot --tab 12 --full'],
  batch: ['batch steps.json --task TASK_ID', 'batch - --tab 12'],
  'task finish': ['task finish --task TASK_ID', 'task finish --task TASK_ID --keep 12'],
  'recipe run': ['recipe run read-title selector=h1 --tab 12'],
};

export function commandHelp(topic?: string): string {
  if (topic === 'targets') return TARGET_HELP;
  if (topic === 'recipes')
    return 'Save a JSON object with id and steps (arrays of CLI arguments). Use {{key}} for input values supplied to recipe run. Inspect the workflow before running it.';
  if (topic && isCommand(topic)) {
    const spec = COMMANDS[topic];
    return [
      `browserpaw ${spec.usage}`,
      spec.summary,
      `Common options: ${globalOptions}`,
      TARGET_HELP,
      ...(examples[topic] ?? []).map((example) => `Example: browserpaw ${example}`),
    ].join('\n');
  }
  if (topic) {
    const group = Object.entries(COMMANDS).filter(([name]) => name.startsWith(topic + ' '));
    if (group.length)
      return group.map(([, spec]) => `browserpaw ${spec.usage}\n  ${spec.summary}`).join('\n');
    throw new Error(`Unknown help topic ${topic}.`);
  }
  return [
    'BrowserPaw CLI — control Chrome through the BrowserPaw extension.',
    'Run browserpaw status to verify the connection, or browserpaw setup to install.',
    'Workflow: task start → open --task ID → observe --task ID → act → verify → task finish --task ID.',
    'Use --tab ID to select an existing tab, or --task ID for a task page. --json emits a single receipt.',
    'Exit codes: 0 success, 1 failure, 2 usage error, 3 disconnected, 4 outcome unknown. Observe before acting again after exit 4.',
    TARGET_HELP,
    'Run browserpaw help COMMAND for command-specific usage.',
    '',
    ...Object.values(COMMANDS).map((spec) => `  ${spec.usage}`),
  ].join('\n');
}
