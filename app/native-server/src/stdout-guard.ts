import { Console } from 'node:console';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';

export function reserveStdoutForProtocol(): void {
  const home = process.env.BROWSERPAW_HOME;
  if (!home) {
    Object.assign(console, new Console(process.stderr));
    return;
  }
  const dir = join(home, 'logs');
  const file = join(dir, 'host.log');
  const stream = new Writable({
    write(chunk, _encoding, done) {
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
        if (size + chunk.length > 5 * 1024 * 1024) renameSync(file, file + '.1');
        appendFileSync(file, chunk, { mode: 0o600 });
      } catch {
        process.stderr.write(chunk);
      }
      done();
    },
  });
  Object.assign(console, new Console(stream));
}
