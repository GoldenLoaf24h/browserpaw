const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDirectory, readJson, atomicWrite, acquireLock } = require('./cli-files.cjs');

function openSessionStore(name) {
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(name || '') ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name)
  ) {
    throw new Error(
      'Session name must contain 1-64 letters, digits, underscores or hyphens and must not be a reserved device name.',
    );
  }
  const directory = path.join(
    process.env.BROWSERPAW_HOME || path.join(os.homedir(), '.browserpaw'),
    'cli-sessions',
  );
  ensureDirectory(directory);
  const filename = path.join(directory, `${name}.json`);
  const release = acquireLock(path.join(directory, `${name}.lock`));
  return {
    release,
    read() {
      const record = readJson(filename);
      if (record === undefined) return undefined;
      if (
        !record ||
        record.name !== name ||
        typeof record.sessionId !== 'string' ||
        !/^[\x21-\x7e]{1,256}$/.test(record.sessionId) ||
        !Number.isInteger(record.port) ||
        record.port < 1 ||
        record.port > 65535 ||
        typeof record.createdAt !== 'string' ||
        typeof record.lastUsedAt !== 'string'
      ) {
        throw new Error(
          'Invalid CLI session record; inspect it before closing or recreating the session.',
        );
      }
      return record;
    },
    write(record) {
      atomicWrite(filename, JSON.stringify(record, null, 2) + '\n');
    },
    remove() {
      fs.rmSync(filename, { force: true });
    },
  };
}

module.exports = { openSessionStore };
