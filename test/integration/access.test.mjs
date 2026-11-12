import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  readJsonl,
  delay,
} from '../helpers/harness.mjs';
import { dmMessage, textMessage } from '../helpers/messages.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

test('runs codex for the owner DM', async () => {
  const fixture = createFixture({
    name: 'access-dm',
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
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

test('ignores a DM from an unknown sender', async () => {
  const fixture = createFixture({
    name: 'access-unknown-dm',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ senderId: 'ou_other' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.ignored');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
    assert.equal(
      readJsonl(fixture.channelLog).some((entry) => entry.type === 'reply'),
      false,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('ignores messages sent by another bot', async () => {
  const fixture = createFixture({
    name: 'access-bot-sender',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: dmMessage({ senderIsBot: true }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.ignored');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('ignores group messages even from the owner', async () => {
  const fixture = createFixture({
    name: 'access-group',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ content: 'group task', mentionedBot: true }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.ignored');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
    assert.equal(
      readJsonl(fixture.channelLog).some((entry) => entry.type === 'reply'),
      false,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('ignores @all messages', async () => {
  const fixture = createFixture({
    name: 'access-mention-all',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ mentionAll: true }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.ignored');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
