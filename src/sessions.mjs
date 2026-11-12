import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const NOOP_LOGGER = {
  info() {},
  warn() {},
  error() {},
};

function validEntry(entry) {
  return (
    entry &&
    typeof entry === 'object' &&
    (typeof entry.threadId === 'string' || entry.threadId === null) &&
    typeof entry.cwd === 'string' &&
    entry.cwd.startsWith('/')
  );
}

export function createSessionStore({
  file,
  seedSessions = {},
  defaultCwd,
  logger = NOOP_LOGGER,
  maxEntries = 500,
  ttlMs = 90 * 24 * 60 * 60 * 1000,
  now = () => Date.now(),
}) {
  if (typeof file !== 'string' || !file.startsWith('/')) {
    throw new Error('sessions file must be an absolute path');
  }
  if (typeof defaultCwd !== 'string' || !defaultCwd.startsWith('/')) {
    throw new Error('defaultCwd must be an absolute path');
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error('maxEntries must be a positive integer');
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new Error('ttlMs must be a positive integer');
  }

  const TMP = `${file}.tmp`;
  const data = new Map();
  let writeChain = Promise.resolve();

  function persist() {
    const snapshot = Object.fromEntries(data);
    writeChain = writeChain.then(() => {
      try {
        writeFileSync(TMP, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
        chmodSync(TMP, 0o600);
        renameSync(TMP, file);
        chmodSync(file, 0o600);
      } catch (err) {
        logger.error('sessions.persist_failed', { message: err.message });
      }
    });
    return writeChain;
  }

  function prune() {
    const timestamp = now();
    let changed = false;
    for (const [scope, entry] of data) {
      if (timestamp - entry.updatedAt > ttlMs) {
        data.delete(scope);
        changed = true;
      }
    }
    while (data.size > maxEntries) {
      let oldestScope = null;
      let oldestAt = Infinity;
      for (const [scope, entry] of data) {
        if (entry.updatedAt < oldestAt) {
          oldestAt = entry.updatedAt;
          oldestScope = scope;
        }
      }
      if (!oldestScope) break;
      data.delete(oldestScope);
      changed = true;
    }
    return changed;
  }

  function load() {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          for (const [scope, entry] of Object.entries(parsed)) {
            if (!validEntry(entry)) continue;
            data.set(scope, {
              threadId: entry.threadId,
              cwd: entry.cwd,
              updatedAt: Number(entry.updatedAt) || now(),
            });
          }
        }
      } catch (err) {
        logger.error('sessions.load_failed', { message: err.message });
      }
      return;
    }

    for (const [scope, seed] of Object.entries(seedSessions)) {
      if (!validEntry(seed)) continue;
      data.set(scope, { threadId: seed.threadId, cwd: seed.cwd, updatedAt: now() });
    }
    persist();
    logger.info('sessions.seeded', { count: data.size });
  }

  mkdirSync(dirname(file), { recursive: true });
  load();
  if (prune()) persist();

  function getSession(scope) {
    return data.get(scope);
  }

  function setSession(scope, updates = {}) {
    const prev = data.get(scope) || {
      threadId: null,
      cwd: defaultCwd,
      updatedAt: now(),
    };
    data.set(scope, {
      threadId: updates.threadId === undefined ? prev.threadId : updates.threadId,
      cwd: updates.cwd || prev.cwd || defaultCwd,
      updatedAt: now(),
    });
    prune();
    persist();
  }

  function clearThread(scope) {
    const prev = data.get(scope);
    if (!prev) return;
    data.set(scope, { ...prev, threadId: null, updatedAt: now() });
    prune();
    persist();
  }

  function allSessions() {
    return Object.fromEntries(data);
  }

  return {
    file,
    getSession,
    setSession,
    clearThread,
    allSessions,
    persist,
    flush: () => writeChain,
  };
}
