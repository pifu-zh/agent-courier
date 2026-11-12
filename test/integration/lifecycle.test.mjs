import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  stopBot,
  waitForExit,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  readJsonl,
  botLog,
  botLogFile,
  updateConfig,
} from '../helpers/harness.mjs';
import { dmCommand, dmMessage } from '../helpers/messages.mjs';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

test('/stop interrupts the active turn and reports stopped', async () => {
  const fixture = createFixture({
    name: 'lifecycle-stop',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ content: 'long task [[sleep=30000]]' }),
      },
      { delayMs: 500, event: 'message', msg: dmCommand('/stop') },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    const end = await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    assert.equal(end.ok, false);
    const channel = readJsonl(fixture.channelLog);
    const contents = channel
      .filter((entry) => entry.type === 'stream.content')
      .map((entry) => entry.content)
      .join('\n');
    assert.match(contents, /已停止/);
    assert.ok(
      channel.some(
        (entry) =>
          entry.type === 'reply' &&
          entry.input?.markdown?.includes('已发送停止信号'),
      ),
    );
    assert.ok(
      readJsonl(fixture.codexLog).some((entry) => entry.type === 'signal'),
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('/new interrupts the active turn and clears the thread', async () => {
  const fixture = createFixture({
    name: 'lifecycle-new',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ content: 'long task [[sleep=30000]]' }),
      },
      { delayMs: 500, event: 'message', msg: dmCommand('/new') },
    ],
  });
  let handle;
  try {
    updateConfig(fixture, {
      seedSessions: {
        oc_test: { threadId: 'thread_seed', cwd: fixture.work },
      },
    });
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const sessions = JSON.parse(
      readFileSync(join(fixture.root, 'sessions.json'), 'utf8'),
    );
    assert.equal(sessions.main.threadId, null);
    assert.ok(
      readJsonl(fixture.channelLog).some(
        (entry) =>
          entry.type === 'reply' && entry.input?.markdown?.includes('已开始新会话'),
      ),
    );
    assert.ok(
      readJsonl(fixture.codexLog).some((entry) => entry.type === 'signal'),
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('a missing rollout triggers one fresh thread and a notice', async () => {
  const fixture = createFixture({
    name: 'lifecycle-stale',
    env: {
      MOCK_CODEX_MODE: 'missing_thread',
      MOCK_CODEX_THREAD_ID: 'thread_new',
    },
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
  });
  let handle;
  try {
    updateConfig(fixture, {
      seedSessions: {
        oc_test: { threadId: 'thread_missing', cwd: fixture.work },
      },
    });
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const starts = readJsonl(fixture.codexLog).filter(
      (entry) => entry.type === 'start',
    );
    assert.equal(starts.length, 2);
    assert.equal(starts[0].resume, true);
    assert.equal(starts[0].threadArg, 'thread_missing');
    assert.equal(starts[1].resume, false);
    const contents = readJsonl(fixture.channelLog)
      .filter((entry) => entry.type === 'stream.content')
      .map((entry) => entry.content)
      .join('\n');
    assert.match(contents, /旧会话已失效/);
    const sessions = JSON.parse(
      readFileSync(join(fixture.root, 'sessions.json'), 'utf8'),
    );
    assert.equal(sessions.main.threadId, 'thread_new');
    assert.ok(
      botLog(fixture).some((entry) => entry.event === 'session.resume_missing'),
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('SIGTERM during a run interrupts the turn and exits cleanly', async () => {
  const fixture = createFixture({
    name: 'lifecycle-shutdown',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ content: 'long task [[sleep=30000]]' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitFor(fixture.codexLog, (entry) => entry.type === 'start');
    const startedAt = Date.now();
    const exit = await stopBot(handle, 'SIGTERM', 4000);
    assert.equal(exit.code, 0);
    assert.ok(Date.now() - startedAt < 4000);
    assert.ok(
      readJsonl(fixture.codexLog).some((entry) => entry.type === 'signal'),
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('persists the new thread and never logs the prompt or app secret', async () => {
  const fixture = createFixture({
    name: 'lifecycle-session',
    env: { MOCK_CODEX_THREAD_ID: 'thread_persist' },
    scenario: [
      { delayMs: 100, event: 'message', msg: dmMessage({ content: 'SECRET_PROMPT_XYZ' }) },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const file = join(fixture.root, 'sessions.json');
    const sessions = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(sessions.main.threadId, 'thread_persist');
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = readFileSync(botLogFile(fixture), 'utf8');
    assert.equal(raw.includes('SECRET_PROMPT_XYZ'), false);
    assert.equal(raw.includes('test-secret-value'), false);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('a second bot process is refused by the instance lock', async () => {
  const fixture = createFixture({ name: 'lifecycle-lock' });
  let first;
  let second;
  try {
    first = await start(fixture);
    second = spawnBot(fixture);
    const exit = await waitForExit(second, 3000);
    assert.equal(exit.code, 1);
    assert.equal(first.exitInfo, null);
    assert.ok(botLog(fixture).some((entry) => entry.event === 'bot.lock_held'));
  } finally {
    cleanupFixture(fixture, first);
  }
});
