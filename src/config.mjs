import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = resolve(here, '..');
export const DEFAULT_ENV_FILE = join(ROOT_DIR, '.env');
export const DEFAULT_CONFIG_FILE = join(ROOT_DIR, 'config.json');

const SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const REPLY_MODES = new Set(['stream', 'final']);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function expandHome(value) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

// Relative paths in config.json are resolved against the project root so the
// repository stays portable; absolute paths and `~/...` keep working.
function resolveFrom(rootDir, value) {
  const expanded = expandHome(value);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(rootDir, expanded);
}

function resolveExecutable(value, rootDir, env) {
  const expanded = expandHome(value);
  if (expanded.includes('/')) return resolveFrom(rootDir, expanded);
  const searchPath = env.PATH ?? process.env.PATH ?? '';
  for (const dir of searchPath.split(delimiter).filter(Boolean)) {
    const candidate = join(dir, expanded);
    if (existsSync(candidate)) return candidate;
  }
  return expanded;
}

export function loadDotEnv(file, env = process.env) {
  if (!existsSync(file)) return env;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in env)) env[key] = value;
  }
  return env;
}

export function loadConfig({
  envFile = DEFAULT_ENV_FILE,
  configFile = DEFAULT_CONFIG_FILE,
  env = process.env,
} = {}) {
  loadDotEnv(envFile, env);

  const rootDir = dirname(resolve(configFile));
  const raw = JSON.parse(readFileSync(configFile, 'utf8'));

  assert(env.LARK_APP_ID, 'LARK_APP_ID is missing in .env');
  assert(
    env.LARK_APP_SECRET && String(env.LARK_APP_SECRET).trim(),
    'LARK_APP_SECRET is missing in .env',
  );
  if (existsSync(envFile)) {
    assert(
      (statSync(envFile).mode & 0o077) === 0,
      '.env must not be readable by group or others (chmod 600)',
    );
  }
  assert(
    Array.isArray(raw.allowedDmUsers) &&
      raw.allowedDmUsers.length > 0 &&
      raw.allowedDmUsers.every((id) => typeof id === 'string' && id),
    'allowedDmUsers must be a non-empty array of strings',
  );
  assert(
    Array.isArray(raw.allowedChats) &&
      raw.allowedChats.length > 0 &&
      raw.allowedChats.every((id) => typeof id === 'string' && id),
    'allowedChats must be a non-empty array of strings',
  );
  assert(SANDBOXES.has(raw.sandbox), `sandbox must be one of ${[...SANDBOXES].join(', ')}`);
  assert(REPLY_MODES.has(raw.replyMode), `replyMode must be one of ${[...REPLY_MODES].join(', ')}`);
  assert(
    typeof raw.defaultCwd === 'string' && raw.defaultCwd.trim(),
    'defaultCwd must be a non-empty path',
  );
  assert(
    Array.isArray(raw.allowedCwdRoots) &&
      raw.allowedCwdRoots.length > 0 &&
      raw.allowedCwdRoots.every((p) => typeof p === 'string' && p.trim()),
    'allowedCwdRoots must be a non-empty array of paths',
  );
  const defaultCwd = resolveFrom(rootDir, raw.defaultCwd);
  const allowedCwdRoots = raw.allowedCwdRoots.map((p) => resolveFrom(rootDir, p));
  assert(
    !allowedCwdRoots.includes('/'),
    'allowedCwdRoots must not contain the filesystem root',
  );
  assert(
    allowedCwdRoots.some(
      (root) =>
        defaultCwd === root ||
        defaultCwd.startsWith(root === '/' ? '/' : `${root}/`),
    ),
    'defaultCwd must be inside allowedCwdRoots',
  );
  assert(
    raw.requireMention === undefined || typeof raw.requireMention === 'boolean',
    'requireMention must be a boolean',
  );
  assert(
    raw.model === null ||
      raw.model === undefined ||
      (typeof raw.model === 'string' && raw.model.trim()),
    'model must be null or a non-empty string',
  );
  assert(
    Number.isInteger(raw.maxConcurrentRuns) &&
      raw.maxConcurrentRuns >= 1 &&
      raw.maxConcurrentRuns <= 10,
    'maxConcurrentRuns must be an integer from 1 to 10',
  );
  assert(
    Number.isInteger(raw.runTimeoutMs) &&
      raw.runTimeoutMs >= 1000 &&
      raw.runTimeoutMs <= 2_147_483_647,
    'runTimeoutMs must be an integer from 1000 to 2147483647',
  );
  assert(
    Number.isInteger(raw.stopGraceMs) &&
      raw.stopGraceMs >= 0 &&
      raw.stopGraceMs <= 2_147_483_647,
    'stopGraceMs must be an integer from 0 to 2147483647',
  );
  assert(
    raw.queueTtlMs === undefined ||
      (Number.isInteger(raw.queueTtlMs) &&
        raw.queueTtlMs >= 0 &&
        raw.queueTtlMs <= 2_147_483_647),
    'queueTtlMs must be a non-negative integer',
  );
  assert(
    typeof raw.codexBin === 'string' && raw.codexBin.trim(),
    'codexBin must be a non-empty string',
  );
  const codexBin = resolveExecutable(raw.codexBin, rootDir, env);
  assert(
    existsSync(codexBin),
    `codexBin is missing or not on PATH: ${raw.codexBin}`,
  );
  assert(
    (statSync(codexBin).mode & 0o111) !== 0,
    `codexBin is not executable: ${raw.codexBin}`,
  );
  const isolation = raw.codexIsolation || { enabled: false, hidePaths: [] };
  assert(
    typeof isolation.enabled === 'boolean',
    'codexIsolation.enabled must be a boolean',
  );
  assert(
    Array.isArray(isolation.hidePaths) &&
      isolation.hidePaths.every((p) => typeof p === 'string' && p.trim()),
    'codexIsolation.hidePaths must be an array of paths',
  );
  const hidePaths = isolation.hidePaths.map((p) => resolveFrom(rootDir, p));
  if (isolation.enabled) {
    const bwrap = process.env.BWRAP_BIN || '/usr/bin/bwrap';
    assert(
      existsSync(bwrap),
      `codexIsolation requires bubblewrap (${bwrap}); install it or set BWRAP_BIN`,
    );
  }

  const seedSessions = {};
  for (const [scope, entry] of Object.entries(raw.seedSessions || {})) {
    seedSessions[scope] =
      entry && typeof entry === 'object' && typeof entry.cwd === 'string'
        ? { ...entry, cwd: resolveFrom(rootDir, entry.cwd) }
        : entry;
  }

  return {
    rootDir,
    appId: env.LARK_APP_ID,
    appSecret: env.LARK_APP_SECRET,
    allowedDmUsers: raw.allowedDmUsers,
    allowedChats: raw.allowedChats,
    requireMention: raw.requireMention !== false,
    defaultCwd,
    allowedCwdRoots,
    sandbox: raw.sandbox,
    model: raw.model || undefined,
    maxConcurrentRuns: raw.maxConcurrentRuns,
    runTimeoutMs: raw.runTimeoutMs,
    stopGraceMs: raw.stopGraceMs,
    queueTtlMs: raw.queueTtlMs === undefined ? 10 * 60 * 1000 : raw.queueTtlMs,
    codexBin,
    codexIsolation: {
      enabled: isolation.enabled,
      hidePaths,
    },
    replyMode: raw.replyMode,
    seedSessions,
    sessionsFile: join(rootDir, 'sessions.json'),
    logsDir: join(rootDir, 'logs'),
  };
}

function realOrResolved(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

export function isCwdAllowed(config, cwd) {
  const target = realOrResolved(cwd);
  return config.allowedCwdRoots.some((root) => {
    const realRoot = realOrResolved(root);
    return (
      target === realRoot ||
      target.startsWith(realRoot === '/' ? '/' : `${realRoot}/`)
    );
  });
}

export function createCwdGuard(config) {
  return (cwd) => isCwdAllowed(config, cwd);
}
