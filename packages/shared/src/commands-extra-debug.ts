export const debugCommands = {
  console: {
    usage: 'console [--level LEVEL] [--grep PATTERN] [--limit N] [--clear] [--no-exceptions]',
    summary:
      'Read buffered console output with level and text filters; --level accepts comma-separated levels.',
  },
  'network start': {
    usage: 'network start [--filter PATTERN] [--bodies] [--static] [--max-time MS] [--idle MS]',
    summary:
      'Start a page recording. --filter matches captured request URLs. --bodies captures textual responses.',
  },
  'network stop': {
    usage: 'network stop [--bodies]',
    summary: 'Stop the selected page recording and return captured events.',
  },
  'network show': {
    usage: 'network show [ID] [--out FILE]',
    summary:
      'Read captured network events, or inspect one request by ID. --out writes its textual body.',
  },
  'network list': {
    usage:
      'network list [--filter PATTERN] [--method METHOD] [--status CODE] [--type TYPE] [--limit N]',
    summary: 'List captured requests with URL, method, status, type, and result-limit filters.',
  },
  'network clear': {
    usage: 'network clear',
    summary: 'Clear the selected page network capture while leaving recording active.',
  },
  'perf metrics': {
    usage: 'perf metrics',
    summary: 'Read Chrome performance counters for the selected page.',
  },
  'perf trace': {
    usage:
      'perf trace start|stop|analyze [NAME] [--reload] [--auto-stop] [--duration MS] [--out FILE]',
    summary:
      'Record, stop, or summarize a Chrome performance trace; trace files stay in the Native temp area.',
  },
  emulate: {
    usage:
      'emulate [--viewport WIDTHxHEIGHT] [--dpr NUMBER] [--mobile] [--user-agent TEXT] [--color-scheme SCHEME] [--timezone ID] [--locale LOCALE] [--cpu-rate NUMBER] [--offline] [--latency MS] [--download-kbps N] [--upload-kbps N]',
    summary: 'Apply device, media, locale, CPU, or network emulation to the selected page.',
  },
  'emulate reset': {
    usage: 'emulate reset',
    summary: 'Clear viewport, media, locale, CPU, and network emulation on the selected page.',
  },
  pdf: {
    usage:
      'pdf [--out FILE] [--landscape] [--no-background] [--paper PAPER] [--margin INCH] [--scale N] [--header] [--footer]',
    summary: 'Print the selected page to PDF and save its bytes outside Agent context.',
  },
} as const;
