import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  stopBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  waitForBotCount,
  readJsonl,
  botLog,
} from '../helpers/harness.mjs';
import { dmMessage, textMessage } from '../helpers/messages.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

test('a message during an active turn is steered into the same turn', async () => {
  const fixture = createFixture({
    name: 'conversation-steer',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ content: 'first [[sleep=800]]' }),
      },
      {
        delayMs: 250,
        event: 'message',
        msg: dmMessage({ content: 'second' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const events = readJsonl(fixture.codexLog);
    assert.equal(events.filter((entry) => entry.type === 'start').length, 1);
    assert.equal(events.filter((entry) => entry.type === 'end').length, 1);
    const steer = events.find((entry) => entry.type === 'steer');
    assert.equal(steer?.prompt, 'second');
    assert.ok(botLog(fixture).some((entry) => entry.event === 'turn.steer'));
    const contents = readJsonl(fixture.channelLog)
      .filter((entry) => entry.type === 'stream.content')
      .map((entry) => entry.content)
      .join('\n');
    assert.match(contents, /STEERED:second/);
    await stopBot(handle);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('two idle messages reuse one app-server and one thread', async () => {
  const fixture = createFixture({
    name: 'conversation-reuse',
    scenario: [
      { delayMs: 100, event: 'message', msg: dmMessage({ content: 'one' }) },
      { delayMs: 900, event: 'message', msg: dmMessage({ content: 'two' }) },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 2, {
      timeout: 10000,
    });
    const events = readJsonl(fixture.codexLog);
    const starts = events.filter((entry) => entry.type === 'start');
    assert.equal(starts.length, 2);
    assert.equal(starts[0].threadId, starts[1].threadId);
    assert.equal(starts[0].resume, false);
    assert.equal(starts[1].resume, false);
    const threadEvents = events.filter((entry) => entry.type === 'thread');
    assert.equal(threadEvents.filter((entry) => entry.action === 'start').length, 1);
    assert.equal(threadEvents.filter((entry) => entry.action === 'resume').length, 0);
    assert.equal(
      botLog(fixture).filter((entry) => entry.event === 'appserver.started').length,
      1,
    );
    await stopBot(handle);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('group messages are ignored', async () => {
  const fixture = createFixture({
    name: 'conversation-group-ignore',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ chatType: 'group', content: 'group task' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.ignored');
    await stopBot(handle);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
    assert.equal(
      readJsonl(fixture.channelLog).filter((entry) => entry.type === 'reply').length,
      0,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});
