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
  botLog,
  readJsonl,
  delay,
} from '../helpers/harness.mjs';
import { textMessage, dmMessage } from '../helpers/messages.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

test('allows an owner DM and runs codex', async () => {
  const fixture = createFixture({
    name: 'access-dm',
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    assert.equal(readJsonl(fixture.codexLog).filter((e) => e.type === 'start').length, 1);
    assert.equal(botLog(fixture).filter((e) => e.event === 'run.end')[0].ok, true);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('allows an owner group message with a mention', async () => {
  const fixture = createFixture({
    name: 'access-group-ok',
    scenario: [{ delayMs: 100, event: 'message', msg: textMessage() }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    assert.equal(readJsonl(fixture.codexLog).filter((e) => e.type === 'start').length, 1);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('requires a mention when configured', async () => {
  const fixture = createFixture({
    name: 'access-no-mention',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ mentionedBot: false }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.not_allowed');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
    assert.equal(
      readJsonl(fixture.channelLog).some((e) => e.type === 'stream.start'),
      false,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('allows group messages without mention when requireMention=false', async () => {
  const fixture = createFixture({
    name: 'access-no-mention-ok',
    configOverrides: { requireMention: false },
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ mentionedBot: false }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    assert.equal(readJsonl(fixture.codexLog).filter((e) => e.type === 'start').length, 1);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('denies an unknown DM sender', async () => {
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
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.not_allowed');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
    assert.equal(
      readJsonl(fixture.channelLog).some((e) => e.type === 'reply'),
      false,
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('denies messages sent by another bot', async () => {
  const fixture = createFixture({
    name: 'access-bot-sender',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ senderIsBot: true }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.not_allowed');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('denies a group that is not in the allowlist', async () => {
  const fixture = createFixture({
    name: 'access-other-group',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ chatId: 'oc_other' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'message.not_allowed');
    await delay(150);
    assert.equal(readJsonl(fixture.codexLog).length, 0);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('runs one codex process per accepted message', async () => {
  const fixture = createFixture({
    name: 'access-two-messages',
    scenario: [
      { delayMs: 100, event: 'message', msg: textMessage({ content: 'one' }) },
      { delayMs: 150, event: 'message', msg: textMessage({ content: 'two' }) },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 2);
    const starts = readJsonl(fixture.codexLog).filter((e) => e.type === 'start');
    assert.equal(starts.length, 2);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
