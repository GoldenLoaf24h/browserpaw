import fs from 'node:fs';
import path from 'node:path';
import { reserveStdoutForProtocol } from './stdout-guard';

describe('reserveStdoutForProtocol', () => {
  const original = Object.getOwnPropertyDescriptors(console);

  afterEach(() => {
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(console))) {
      if (!(key in original)) delete (console as unknown as Record<string, unknown>)[key];
    }
    Object.defineProperties(console, original);
    jest.restoreAllMocks();
  });

  test('routes every console method to stderr', () => {
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    reserveStdoutForProtocol();

    console.log('log');
    console.info('info');
    console.debug('debug');
    console.dir({ dir: 1 });
    console.table([1]);

    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });

  test.each(['index.ts', 'mcp/mcp-server-stdio.ts'])('%s reserves stdout', (entry) => {
    const source = fs.readFileSync(path.join(__dirname, entry), 'utf8');
    expect(source).toContain('reserveStdoutForProtocol();');
  });
});
