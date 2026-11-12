import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  stopBot,
  cleanupFixture,
  waitFor,
  waitForCount,
  waitForBotEvent,
  readJsonl,
  updateConfig,
} from '../helpers/harness.mjs';
import { command } from '../helpers/messages.mjs';
import { join } from 'node:path';
import {
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

function setScenario(fixture, scenario) {
  writeFileSync(fixture.scenarioPath, JSON.stringify(scenario, null, 2), {
    mode: 0o600,
  });
}

test('help, status, unknown and empty commands reply without codex', async () => {
  const fixture = createFixture({ name: 'commands-basic' });
  let handle;
  try {
    setScenario(fixture, [
      { delayMs: 100, event: 'message', msg: command('/help') },
      { delayMs: 150, event: 'message', msg: command('/status') },
      { delayMs: 200, event: 'message', msg: command('/foo') },
      { delayMs: 250, event: 'message', msg: command('') },
      { delayMs: 300, event: 'message', msg: command('help') },
    ]);
    handle = await start(fixture);
    const replies = await waitForCount(
      fixture.channelLog,
      (entry) => entry.type === 'reply',
      5,
    );
    const text = replies.map((entry) => entry.input?.markdown || '').join('\n---\n');
    assert.match(text, /Codex bot 命令/);
    assert.match(text, /thread: 新会话/);
    assert.match(text, /未知命令/);
    assert.match(text, /请发送具体任务/);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('/cd validates roots and persists a new cwd', async () => {
  const fixture = createFixture({ name: 'commands-cd' });
  let handle;
  try {
    const valid = join(fixture.work, 'sub');
    setScenario(fixture, [
      { delayMs: 100, event: 'message', msg: command(`/cd ${valid}`) },
      { delayMs: 180, event: 'message', msg: command('/cd /etc') },
      { delayMs: 260, event: 'message', msg: command('/cd') },
    ]);
    handle = await start(fixture);
    const replies = await waitForCount(
      fixture.channelLog,
      (entry) => entry.type === 'reply',
      3,
    );
    const text = replies.map((entry) => entry.input?.markdown || '').join('\n---\n');
    assert.match(text, /已切换到/);
    assert.match(text, /不在允许范围/);
    assert.match(text, /用法/);
    const sessions = JSON.parse(readFileSync(join(fixture.root, 'sessions.json'), 'utf8'));
    assert.equal(sessions.oc_test.cwd, valid);
    assert.equal(sessions.oc_test.threadId, null);
    assert.equal(
      statSync(join(fixture.root, 'sessions.json')).mode & 0o777,
      0o600,
    );
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('/new clears the seeded thread and /status reflects it', async () => {
  const fixture = createFixture({ name: 'commands-new' });
  let handle;
  try {
    updateConfig(fixture, {
      seedSessions: {
        oc_test: { threadId: 'thread_seed', cwd: fixture.work },
      },
    });
    setScenario(fixture, [
      { delayMs: 100, event: 'message', msg: command('/new') },
      { delayMs: 220, event: 'message', msg: command('/status') },
    ]);
    handle = await start(fixture);
    const replies = await waitForCount(
      fixture.channelLog,
      (entry) => entry.type === 'reply',
      2,
    );
    const text = replies.map((entry) => entry.input?.markdown || '').join('\n---\n');
    assert.match(text, /已开始新会话/);
    assert.match(text, /thread: 新会话/);
    const sessions = JSON.parse(readFileSync(join(fixture.root, 'sessions.json'), 'utf8'));
    assert.equal(sessions.oc_test.threadId, null);
    assert.equal(sessions.oc_test.cwd, fixture.work);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('/cd rejects a symlink that escapes the allowed roots', async () => {
  const fixture = createFixture({ name: 'commands-symlink' });
  let handle;
  try {
    const escape = join(fixture.work, 'escape');
    symlinkSync('/etc', escape);
    setScenario(fixture, [
      { delayMs: 100, event: 'message', msg: command(`/cd ${escape}`) },
    ]);
    handle = await start(fixture);
    const reply = await waitFor(
      fixture.channelLog,
      (entry) => entry.type === 'reply',
    );
    assert.match(reply.input.markdown, /不在允许范围/);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('a normal prompt starting with "help" is not hijacked', async () => {
  const fixture = createFixture({
    name: 'commands-help-prompt',
    scenario: [{ delayMs: 100, event: 'message', msg: command('help me fix this') }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    assert.equal(
      readJsonl(fixture.codexLog).filter((entry) => entry.type === 'start').length,
      1,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('/stop with no active run is a no-op reply', async () => {
  const fixture = createFixture({
    name: 'commands-stop-idle',
    scenario: [{ delayMs: 100, event: 'message', msg: command('/stop') }],
  });
  let handle;
  try {
    handle = await start(fixture);
    const reply = await waitFor(
      fixture.channelLog,
      (entry) => entry.type === 'reply',
    );
    assert.match(reply.input.markdown, /当前没有运行中的任务/);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
