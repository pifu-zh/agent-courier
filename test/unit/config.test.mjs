import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig,
  loadDotEnv,
  isCwdAllowed,
  createCwdGuard,
} from '../../src/config.mjs';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'config-test-'));
  const codex = join(dir, 'codex');
  writeFileSync(codex, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  chmodSync(codex, 0o755);
  const work = join(dir, 'work');
  writeFileSync(join(dir, 'config.json'), '{}');
  return { dir, codex, work };
}

function baseConfig(dir, codex, work) {
  return {
    allowedDmUsers: ['ou_owner'],
    allowedChats: ['oc_group'],
    requireMention: true,
    defaultCwd: work,
    allowedCwdRoots: [dir],
    sandbox: 'read-only',
    model: null,
    maxConcurrentRuns: 2,
    runTimeoutMs: 10000,
    stopGraceMs: 500,
    codexBin: codex,
    replyMode: 'stream',
    seedSessions: {},
  };
}

function writeConfig(dir, config) {
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
}

test('loads env and config, resolves paths and defaults', () => {
  const { dir, codex, work } = setup();
  try {
    const config = baseConfig(dir, codex, work);
    writeConfig(dir, config);
    const envFile = join(dir, 'test.env');
    writeFileSync(
      envFile,
      'LARK_APP_ID=cli_test\nLARK_APP_SECRET="secret-value"\n',
      { mode: 0o600 },
    );
    const loaded = loadConfig({
      envFile,
      configFile: join(dir, 'config.json'),
      env: {},
    });
    assert.equal(loaded.appId, 'cli_test');
    assert.equal(loaded.appSecret, 'secret-value');
    assert.equal(loaded.rootDir, dir);
    assert.equal(loaded.defaultCwd, work);
    assert.equal(loaded.sessionsFile, join(dir, 'sessions.json'));
    assert.equal(loaded.logsDir, join(dir, 'logs'));
    assert.equal(loaded.requireMention, true);
    assert.equal(loaded.model, undefined);
    assert.equal(loaded.queueTtlMs, 10 * 60 * 1000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolves relative paths, home paths and commands from PATH', () => {
  const { dir, codex } = setup();
  try {
    const workspace = join(dir, 'workspace');
    mkdirSync(workspace);
    const config = baseConfig(dir, 'codex', 'workspace');
    config.allowedCwdRoots = ['workspace'];
    config.seedSessions = { oc_test: { threadId: 'thread_seed', cwd: 'workspace' } };
    config.codexIsolation = { enabled: false, hidePaths: ['~/.ssh', 'workspace'] };
    writeConfig(dir, config);
    const loaded = loadConfig({
      envFile: join(dir, 'missing.env'),
      configFile: join(dir, 'config.json'),
      env: {
        LARK_APP_ID: 'cli_test',
        LARK_APP_SECRET: 'secret',
        PATH: dir,
      },
    });
    assert.equal(loaded.codexBin, codex);
    assert.equal(loaded.defaultCwd, workspace);
    assert.deepEqual(loaded.allowedCwdRoots, [workspace]);
    assert.deepEqual(loaded.codexIsolation.hidePaths, [
      join(homedir(), '.ssh'),
      workspace,
    ]);
    assert.equal(loaded.seedSessions.oc_test.cwd, workspace);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDotEnv does not overwrite an existing environment value', () => {
  const { dir } = setup();
  try {
    const envFile = join(dir, 'test.env');
    writeFileSync(envFile, 'LARK_APP_ID=from_file\nLARK_APP_SECRET=from_file_secret\n');
    const env = { LARK_APP_ID: 'existing' };
    loadDotEnv(envFile, env);
    assert.equal(env.LARK_APP_ID, 'existing');
    assert.equal(env.LARK_APP_SECRET, 'from_file_secret');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid configs are rejected with clear messages', () => {
  const { dir, codex, work } = setup();
  const baseline = baseConfig(dir, codex, work);
  const env = { LARK_APP_ID: 'cli_test', LARK_APP_SECRET: 'secret' };
  const cases = [
    ['bad sandbox', { ...baseline, sandbox: 'bad' }, /sandbox/],
    ['bad reply mode', { ...baseline, replyMode: 'bad' }, /replyMode/],
    ['empty dm allowlist', { ...baseline, allowedDmUsers: [] }, /allowedDmUsers/],
    ['empty chat allowlist', { ...baseline, allowedChats: [] }, /allowedChats/],
    ['empty cwd', { ...baseline, defaultCwd: '' }, /defaultCwd/],
    ['cwd outside roots', { ...baseline, defaultCwd: '/tmp/outside' }, /defaultCwd/],
    ['empty cwd roots', { ...baseline, allowedCwdRoots: [] }, /allowedCwdRoots/],
    ['filesystem root', { ...baseline, allowedCwdRoots: ['/'] }, /filesystem root/],
    ['bad model', { ...baseline, model: 123 }, /model/],
    ['bad mention', { ...baseline, requireMention: 'false' }, /requireMention/],
    ['bad concurrency', { ...baseline, maxConcurrentRuns: 0 }, /maxConcurrentRuns/],
    ['bad timeout', { ...baseline, runTimeoutMs: 999 }, /runTimeoutMs/],
    ['bad grace', { ...baseline, stopGraceMs: -1 }, /stopGraceMs/],
    ['missing codex', { ...baseline, codexBin: '/nonexistent/codex' }, /codexBin/],
    [
      'missing codex command',
      { ...baseline, codexBin: 'definitely-not-a-real-codex-command' },
      /codexBin/,
    ],
  ];
  try {
    for (const [name, config, pattern] of cases) {
      writeConfig(dir, config);
      assert.throws(
        () =>
          loadConfig({
            envFile: join(dir, 'missing.env'),
            configFile: join(dir, 'config.json'),
            env,
          }),
        pattern,
        name,
      );
    }
    writeConfig(dir, baseline);
    assert.throws(
      () =>
        loadConfig({
          envFile: join(dir, 'missing.env'),
          configFile: join(dir, 'config.json'),
          env: { LARK_APP_ID: 'cli_test' },
        }),
      /LARK_APP_SECRET/,
    );
    assert.throws(
      () =>
        loadConfig({
          envFile: join(dir, 'missing.env'),
          configFile: join(dir, 'config.json'),
          env: { LARK_APP_SECRET: 'secret' },
        }),
      /LARK_APP_ID/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isCwdAllowed handles exact roots, children and prefix lookalikes', () => {
  const root = '/srv/agent';
  const config = { allowedCwdRoots: [root] };
  assert.equal(isCwdAllowed(config, '/srv/agent'), true);
  assert.equal(isCwdAllowed(config, '/srv/agent/project'), true);
  assert.equal(isCwdAllowed(config, '/srv/agentfoo'), false);
  assert.equal(isCwdAllowed(config, '/tmp'), false);
  assert.equal(isCwdAllowed({ allowedCwdRoots: ['/'] }, '/anything'), true);
  const guard = createCwdGuard(config);
  assert.equal(guard('/srv/agent/x'), true);
  assert.equal(guard('/etc'), false);
});

test('isCwdAllowed resolves symlinks before checking roots', () => {
  const dir = mkdtempSync(join(tmpdir(), 'config-symlink-'));
  try {
    const allowed = join(dir, 'allowed');
    mkdirSync(allowed);
    symlinkSync('/etc', join(dir, 'escape'));
    const config = { allowedCwdRoots: [allowed] };
    assert.equal(isCwdAllowed(config, allowed), true);
    assert.equal(isCwdAllowed(config, join(allowed, 'child')), true);
    assert.equal(isCwdAllowed(config, join(dir, 'escape')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
