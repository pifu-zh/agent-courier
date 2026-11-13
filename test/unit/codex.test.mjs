import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCodexRunner } from '../../src/codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, '../helpers/mock-app-server.mjs');
chmodSync(MOCK, 0o755);

const silent = { info() {}, warn() {}, error() {} };

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: line };
      }
    });
}

function setup(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const log = join(dir, 'mock.jsonl');
  const runner = createCodexRunner({
    codexBin: MOCK,
    logger: silent,
    env: { MOCK_CODEX_LOG: log, ...env },
  });
  return { dir, log, runner };
}

async function close(runner, dir) {
  await runner.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

test('starts one thread, streams deltas and returns the final answer', async () => {
  const { dir, log, runner } = setup({ MOCK_CODEX_THREAD_ID: 'thread_test' });
  try {
    const started = await runner.start();
    assert.ok(started.pid > 0);
    const thread = await runner.ensureThread({
      cwd: dir,
      sandbox: 'read-only',
    });
    assert.equal(thread.threadId, 'thread_test');
    const answers = [];
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'hello',
      cwd: dir,
      sandbox: 'read-only',
      onAnswer: (answer) => answers.push(answer),
    });
    const result = await turn.done;
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'MOCK_OK');
    assert.ok(answers.length >= 1);
    const events = readJsonl(log);
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(events.find((event) => event.type === 'prompt').prompt, 'hello');
    assert.equal(events.find((event) => event.type === 'start').hasSecret, false);
  } finally {
    await close(runner, dir);
  }
});

test('reuses one app-server and one thread across turns', async () => {
  const { dir, log, runner } = setup({ MOCK_CODEX_THREAD_ID: 'thread_reuse' });
  try {
    const firstThread = await runner.ensureThread({
      cwd: dir,
      sandbox: 'read-only',
    });
    const first = await runner.startTurn({
      threadId: firstThread.threadId,
      prompt: 'one',
      cwd: dir,
      sandbox: 'read-only',
    });
    await first.done;
    const pid = runner.pid;
    const secondThread = await runner.ensureThread({
      cwd: dir,
      sandbox: 'read-only',
      threadId: firstThread.threadId,
    });
    assert.equal(secondThread.threadId, firstThread.threadId);
    const second = await runner.startTurn({
      threadId: secondThread.threadId,
      prompt: 'two',
      cwd: dir,
      sandbox: 'read-only',
    });
    await second.done;
    assert.equal(runner.pid, pid);
    const events = readJsonl(log);
    assert.equal(events.filter((event) => event.type === 'start').length, 2);
    assert.equal(events.filter((event) => event.type === 'thread').length, 1);
    assert.equal(events.filter((event) => event.type === 'thread')[0].action, 'start');
  } finally {
    await close(runner, dir);
  }
});

test('recycle stops the app-server and clears loaded threads', async () => {
  const { dir, runner } = setup({ MOCK_CODEX_THREAD_ID: 'thread_recycle' });
  try {
    const first = await runner.start();
    await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    assert.equal(runner.threadCount, 1);
    assert.equal(await runner.recycle('test'), true);
    assert.equal(runner.pid, 0);
    assert.equal(runner.threadCount, 0);
    assert.equal(await runner.recycle('again'), false);

    const second = await runner.start();
    assert.ok(second.pid > 0);
    assert.notEqual(second.pid, first.pid);
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    assert.equal(thread.threadId, 'thread_recycle');
    assert.equal(runner.threadCount, 1);
  } finally {
    await close(runner, dir);
  }
});

test('steers a message into an active turn', async () => {
  const { dir, log, runner } = setup();
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'long [[sleep=500]]',
      cwd: dir,
      sandbox: 'read-only',
    });
    await sleep(80);
    await runner.steer({
      threadId: thread.threadId,
      turnId: turn.turnId,
      prompt: 'extra',
    });
    const result = await turn.done;
    assert.match(result.answer, /STEERED:extra/);
    const events = readJsonl(log);
    assert.equal(events.filter((event) => event.type === 'start').length, 1);
    assert.equal(events.filter((event) => event.type === 'steer').length, 1);
  } finally {
    await close(runner, dir);
  }
});

test('interrupts an active turn', async () => {
  const { dir, log, runner } = setup();
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'long [[sleep=30000]]',
      cwd: dir,
      sandbox: 'read-only',
    });
    await sleep(80);
    assert.equal(
      await runner.interrupt({
        threadId: thread.threadId,
        turnId: turn.turnId,
      }),
      true,
    );
    const result = await turn.done;
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.ok(readJsonl(log).some((event) => event.type === 'signal'));
  } finally {
    await close(runner, dir);
  }
});

test('reports a failed turn', async () => {
  const { dir, runner } = setup({
    MOCK_CODEX_FAIL_TURN: '1',
    MOCK_CODEX_FAIL_MESSAGE: 'mock failure detail',
  });
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'fail',
      cwd: dir,
      sandbox: 'read-only',
    });
    const result = await turn.done;
    assert.equal(result.ok, false);
    assert.match(result.error, /mock failure detail/);
  } finally {
    await close(runner, dir);
  }
});

test('surfaces a missing rollout as THREAD_RESUME_FAILED', async () => {
  const { dir, runner } = setup({ MOCK_CODEX_MODE: 'missing_thread' });
  try {
    await runner.start();
    await assert.rejects(
      () =>
        runner.ensureThread({
          threadId: 'missing_thread_id',
          cwd: dir,
          sandbox: 'read-only',
        }),
      (err) => err.code === 'THREAD_RESUME_FAILED' && /no rollout found/.test(err.message),
    );
  } finally {
    await close(runner, dir);
  }
});

test('fails cleanly when the app-server cannot start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runner-test-'));
  const runner = createCodexRunner({
    codexBin: join(dir, 'missing-app-server'),
    logger: silent,
  });
  try {
    await assert.rejects(() => runner.start(), /spawn|ENOENT|not found/i);
  } finally {
    await close(runner, dir);
  }
});

test('does not expose LARK_APP_SECRET to the app-server', async () => {
  const { dir, log, runner } = setup({
    LARK_APP_SECRET: 'super-secret-test',
  });
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'hello',
      cwd: dir,
      sandbox: 'read-only',
    });
    await turn.done;
    assert.equal(readJsonl(log).find((event) => event.type === 'start').hasSecret, false);
  } finally {
    await close(runner, dir);
  }
});

test('joins multiple agent messages', async () => {
  const { dir, runner } = setup({ MOCK_CODEX_MULTI_MESSAGES: '1' });
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'multi',
      cwd: dir,
      sandbox: 'read-only',
    });
    const result = await turn.done;
    assert.equal(result.ok, true);
    assert.match(result.answer, /first message/);
    assert.match(result.answer, /second message/);
  } finally {
    await close(runner, dir);
  }
});

test('reports unknown event types once', async () => {
  const { dir, runner } = setup({ MOCK_CODEX_UNKNOWN_EVENT: '1' });
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'unknown',
      cwd: dir,
      sandbox: 'read-only',
    });
    const result = await turn.done;
    assert.deepEqual(result.unknownEventTypes, ['future.event']);
  } finally {
    await close(runner, dir);
  }
});

test('rejects a turn on a thread that is already active', async () => {
  const { dir, runner } = setup();
  try {
    const thread = await runner.ensureThread({ cwd: dir, sandbox: 'read-only' });
    const turn = await runner.startTurn({
      threadId: thread.threadId,
      prompt: 'long [[sleep=30000]]',
      cwd: dir,
      sandbox: 'read-only',
    });
    await assert.rejects(
      () =>
        runner.startTurn({
          threadId: thread.threadId,
          prompt: 'second',
          cwd: dir,
          sandbox: 'read-only',
        }),
      (err) => err.code === 'TURN_ACTIVE',
    );
    await runner.interrupt({ threadId: thread.threadId, turnId: turn.turnId });
    await turn.done;
  } finally {
    await close(runner, dir);
  }
});
