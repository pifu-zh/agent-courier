import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(HERE, '../..');

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function writePrivate(file, content) {
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function createFixture({
  name = 'bot',
  configOverrides = {},
  scenario = [],
  env = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), `agent-courier-${name}-`));
  cpSync(join(PROJECT_ROOT, 'src'), join(root, 'src'), { recursive: true });

  const channelDir = join(root, 'node_modules', '@larksuite', 'channel');
  mkdirSync(channelDir, { recursive: true });
  writeFileSync(
    join(channelDir, 'package.json'),
    JSON.stringify({
      name: '@larksuite/channel',
      version: '0.0.0-test',
      type: 'module',
      main: 'index.mjs',
      exports: './index.mjs',
    }),
  );
  copyFileSync(join(HERE, 'fake-channel.mjs'), join(channelDir, 'index.mjs'));

  const mockCodex = join(root, 'mock-app-server.mjs');
  copyFileSync(join(HERE, 'mock-app-server.mjs'), mockCodex);
  chmodSync(mockCodex, 0o755);

  const work = join(root, 'work');
  mkdirSync(join(work, 'sub'), { recursive: true });

  const config = {
    allowedDmUsers: ['ou_test'],
    defaultCwd: work,
    allowedCwdRoots: [root],
    sandbox: 'read-only',
    model: null,
    codexBin: mockCodex,
    replyMode: 'stream',
    seedSessions: {},
    ...configOverrides,
  };
  writePrivate(join(root, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writePrivate(
    join(root, '.env'),
    'LARK_APP_ID=cli_test\nLARK_APP_SECRET=test-secret-value\n',
  );
  writePrivate(join(root, 'scenario.json'), `${JSON.stringify(scenario, null, 2)}\n`);

  return {
    root,
    work,
    config,
    env,
    scenarioPath: join(root, 'scenario.json'),
    channelLog: join(root, 'channel.jsonl'),
    codexLog: join(root, 'codex.jsonl'),
    logsDir: join(root, 'logs'),
  };
}

function cleanEnv(extra = {}) {
  const base = { ...process.env };
  delete base.LARK_APP_ID;
  delete base.LARK_APP_SECRET;
  return {
    ...base,
    FAKE_CHANNEL_LOG: '',
    FAKE_CHANNEL_SCENARIO: '',
    MOCK_CODEX_LOG: '',
    BOT_TEST_GC: '1',
    ...extra,
  };
}

export function updateConfig(fixture, overrides) {
  fixture.config = { ...fixture.config, ...overrides };
  writePrivate(
    join(fixture.root, 'config.json'),
    `${JSON.stringify(fixture.config, null, 2)}\n`,
  );
}

export function spawnBot(fixture, { env = {}, nodeArgs = [] } = {}) {
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--report-on-signal',
      '--report-signal=SIGUSR2',
      `--report-directory=${fixture.root}`,
      ...nodeArgs,
      join(fixture.root, 'src', 'bot.mjs'),
    ],
    {
      cwd: fixture.root,
      env: cleanEnv({
        FAKE_CHANNEL_LOG: fixture.channelLog,
        FAKE_CHANNEL_SCENARIO: fixture.scenarioPath,
        MOCK_CODEX_LOG: fixture.codexLog,
        ...fixture.env,
        ...env,
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });
  let exitInfo = null;
  const exited = new Promise((resolveExit) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolveExit(exitInfo);
    });
  });

  return {
    child,
    exited,
    get exitInfo() {
      return exitInfo;
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: line };
      }
    });
}

export async function waitFor(
  file,
  predicate,
  { timeout = 8000, interval = 25 } = {},
) {
  const startedAt = Date.now();
  let last = [];
  while (Date.now() - startedAt < timeout) {
    last = readJsonl(file);
    const found = last.find(predicate);
    if (found) return found;
    await delay(interval);
  }
  const tail = last
    .slice(-8)
    .map((entry) => JSON.stringify(entry).slice(0, 400))
    .join('\n');
  throw new Error(
    `waitFor timeout after ${timeout}ms for ${file}\nlast entries:\n${tail}`,
  );
}

export async function waitForCount(
  file,
  predicate,
  count,
  options = {},
) {
  const startedAt = Date.now();
  const timeout = options.timeout || 15000;
  while (Date.now() - startedAt < timeout) {
    const matches = readJsonl(file).filter(predicate);
    if (matches.length >= count) return matches;
    await delay(options.interval || 25);
  }
  throw new Error(`waitForCount timeout: wanted ${count} matches in ${file}`);
}

export function botLogFile(fixture) {
  const dir = fixture.logsDir;
  if (!existsSync(dir)) return join(dir, 'bot-missing.jsonl');
  const files = readdirSync(dir)
    .filter((name) => /^bot-\d{8}\.jsonl$/.test(name))
    .sort();
  return files.length ? join(dir, files[files.length - 1]) : join(dir, 'bot-missing.jsonl');
}

export function botLog(fixture) {
  return readJsonl(botLogFile(fixture));
}

export async function waitForBotEvent(fixture, predicate, options) {
  return waitFor(botLogFile(fixture), predicate, options);
}

export async function waitForBotCount(fixture, predicate, count, options) {
  return waitForCount(botLogFile(fixture), predicate, count, options);
}

export async function waitForExit(handle, timeout = 5000) {
  let timer;
  const timeoutPromise = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(null), timeout);
  });
  const raced = await Promise.race([handle.exited, timeoutPromise]);
  clearTimeout(timer);
  if (!raced) {
    handle.child.kill('SIGKILL');
    throw new Error(`process did not exit within ${timeout}ms`);
  }
  return raced;
}

export async function stopBot(handle, signal = 'SIGTERM', timeout = 5000) {
  if (!handle.exitInfo) {
    try {
      handle.child.kill(signal);
    } catch {
      // already gone
    }
  }
  return waitForExit(handle, timeout);
}

export function sampleProcess(pid) {
  const result = { pid, rssKb: 0, pssKb: 0, hwmKb: 0 };
  try {
    const status = readFileSync(`/proc/${pid}/status`, 'utf8');
    result.rssKb = Number(status.match(/^VmRSS:\s+(\d+) kB/m)?.[1] || 0);
    result.hwmKb = Number(status.match(/^VmHWM:\s+(\d+) kB/m)?.[1] || 0);
  } catch {
    // process exited
  }
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8');
    result.pssKb = Number(rollup.match(/^Pss:\s+(\d+) kB/m)?.[1] || 0);
  } catch {
    // process exited
  }
  return result;
}

export async function triggerGc(handle, waitMs = 250) {
  try {
    handle.child.kill('SIGUSR1');
  } catch {
    return;
  }
  await delay(waitMs);
}

function reportFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith('report.') && name.endsWith('.json'))
    .map((name) => join(root, name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
}

export async function triggerReport(handle, fixture, { timeout = 5000 } = {}) {
  const before = new Set(reportFiles(fixture.root));
  try {
    handle.child.kill('SIGUSR2');
  } catch {
    return null;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const fresh = reportFiles(fixture.root).filter((file) => !before.has(file));
    if (fresh.length) {
      const file = fresh[fresh.length - 1];
      return { file, report: JSON.parse(readFileSync(file, 'utf8')) };
    }
    await delay(50);
  }
  return null;
}

export function cleanupFixture(fixture, handle) {
  if (handle && !handle.exitInfo) {
    try {
      handle.child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
  try {
    rmSync(fixture.root, { recursive: true, force: true });
  } catch {
    // best effort
  }
}
