export const debugCommands = {
  console: {
    usage: 'console [--level LEVEL] [--grep PATTERN] [--limit N] [--clear] [--no-exceptions]',
    summary:
      'Read buffered console output with level and text filters; --level accepts comma-separated levels.',
    keywords: ['browser console logs', 'JavaScript errors', '控制台', '控制台日志'],
  },
  'network start': {
    usage: 'network start [--filter PATTERN] [--bodies] [--static] [--max-time MS] [--idle MS]',
    summary:
      'Start a page recording. --filter matches captured request URLs. --bodies captures textual responses.',
    keywords: ['network capture traffic', '开始抓包', '网络抓包', '抓包'],
  },
  'network stop': {
    usage: 'network stop [--bodies]',
    summary: 'Stop the selected page recording and return captured events.',
  },
  'network show': {
    usage: 'network show ID [--out FILE]',
    summary: 'Inspect one request by its recorded ID. --out writes its textual body.',
    keywords: ['export response body', 'save response body', '响应体', '响应正文', '导出响应正文'],
  },
  'network list': {
    usage:
      'network list [--filter PATTERN] [--method METHOD] [--status CODE] [--type TYPE] [--limit N]',
    summary: 'List captured requests with URL, method, status, type, and result-limit filters.',
    keywords: ['filter network requests', 'HTTP status codes'],
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
    keywords: ['performance profile', 'record timeline', 'profiling trace', '性能分析', '性能追踪'],
  },
  emulate: {
    usage:
      'emulate [--viewport WIDTHxHEIGHT] [--dpr NUMBER] [--mobile] [--user-agent TEXT] [--color-scheme SCHEME] [--timezone ID] [--locale LOCALE] [--cpu-rate NUMBER] [--offline] [--latency MS] [--download-kbps N] [--upload-kbps N]',
    summary: 'Apply device, media, locale, CPU, or network emulation to the selected page.',
    keywords: ['network throttling', 'mobile emulation', 'device simulation'],
  },
  'emulate reset': {
    usage: 'emulate reset',
    summary: 'Clear viewport, media, locale, CPU, and network emulation on the selected page.',
  },
  pdf: {
    usage:
      'pdf [--out FILE] [--landscape] [--no-background] [--paper PAPER] [--margin INCH] [--scale N] [--header] [--footer]',
    summary: 'Print the selected page to PDF and save its bytes outside Agent context.',
    keywords: ['save page as PDF', 'print to PDF'],
  },
} as const;
