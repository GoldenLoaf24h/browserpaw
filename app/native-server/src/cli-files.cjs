const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const STALE_LOCK_AGE_MS = 10 * 60 * 1000;

function assertNoLinks(target) {
  let current = path.resolve(target);
  for (;;) {
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error(`Symlink or junction forbidden: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function ensureDirectory(target) {
  assertNoLinks(target);
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  assertNoLinks(target);
  if (!fs.statSync(target).isDirectory()) throw new Error(`Not a directory: ${target}`);
}

function readJson(target) {
  assertNoLinks(target);
  const stat = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Not a regular file: ${target}`);
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function atomicWrite(target, data) {
  assertNoLinks(target);
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${randomUUID()}.tmp`,
  );
  try {
    fs.writeFileSync(temporary, data, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function acquireLock(target) {
  assertNoLinks(target);
  const busy = () =>
    new Error(
      'Session busy or stale lock; verify the previous CLI has stopped before removing its .lock file. Unknown actions must not be replayed.',
    );
  const reapTarget = `${target}.reap`;
  const token = randomUUID();
  const payload = { pid: process.pid, token, createdAt: new Date().toISOString() };

  const readLock = () => {
    try {
      const value = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (!Number.isInteger(value.pid) || value.pid < 1 || typeof value.token !== 'string')
        return undefined;
      return value;
    } catch {
      return undefined;
    }
  };
  const isDead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code === 'ESRCH') return true;
      return false;
    }
  };
  const isStaleCorruptLock = () => {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    return (
      Boolean(stat?.isFile()) &&
      Date.now() - stat.mtimeMs > STALE_LOCK_AGE_MS &&
      !readLock()
    );
  };
  const writeFresh = (allowReapGuard = false) => {
    let descriptor;
    try {
      descriptor = fs.openSync(target, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(payload));
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (readLock()?.token === token) fs.rmSync(target, { force: true });
      throw error;
    }
    fs.closeSync(descriptor);
    // A stale reaper cannot remove this lock after this point without first
    // observing the live PID. If it owns the guard already, yield to it.
    if (!allowReapGuard && fs.existsSync(reapTarget)) {
      const current = readLock();
      if (current?.token === token) fs.rmSync(target, { force: true });
      throw busy();
    }
  };

  try {
    writeFresh();
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;

    const existing = readLock();
    if (!existing && !isStaleCorruptLock()) throw busy();
    if (existing && !isDead(existing.pid)) throw busy();

    let reapDescriptor;
    try {
      assertNoLinks(reapTarget);
      reapDescriptor = fs.openSync(reapTarget, 'wx', 0o600);
    } catch (reapError) {
      if (reapError.code === 'EEXIST') throw busy();
      throw reapError;
    }
    try {
      const confirmed = readLock();
      if (existing) {
        if (!confirmed || confirmed.token !== existing.token || !isDead(confirmed.pid)) throw busy();
      } else if (confirmed || !isStaleCorruptLock()) {
        throw busy();
      }
      fs.rmSync(target, { force: true });
      writeFresh(true);
    } finally {
      fs.closeSync(reapDescriptor);
      fs.rmSync(reapTarget, { force: true });
    }
  }

  return () => {
    const current = readLock();
    if (current?.token === token) fs.rmSync(target, { force: true });
  };
}

module.exports = { assertNoLinks, ensureDirectory, readJson, atomicWrite, acquireLock };
