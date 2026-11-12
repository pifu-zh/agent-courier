import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  waitFor,
  waitForBotEvent,
  stopBot,
  cleanupFixture,
  botLog,
  readJsonl,
} from '../helpers/harness.mjs';

function message(overrides = {}) {
  return {
    messageId: 'om_1',
    chatId: 'oc_test',
    chatType: 'group',
    senderId: 'ou_test',
    senderIsBot: false,
    content: 'hello',
    mentionedBot: true,
    mentions: [],
    mentionAll: false,
    createTime: Date.now(),
    rawContentType: 'text',
    resources: [],
    ...overrides,
  };
}

test('smoke: one group message runs codex and streams a reply', async () => {
  const fixture = createFixture({
    name: 'smoke',
    scenario: [{ delayMs: 100, event: 'message', msg: message() }],
  });
  let handle;
  try {
    handle = spawnBot(fixture);
    await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const channel = readJsonl(fixture.channelLog);
    const stream = channel.filter((entry) => entry.type === 'stream.content');
    assert.ok(stream.length >= 1);
    assert.ok(stream.some((entry) => entry.content.includes('MOCK_OK')));
    assert.ok(channel.some((entry) => entry.type === 'reaction.add'));
    assert.ok(channel.some((entry) => entry.type === 'reaction.remove'));
    const ends = botLog(fixture).filter((entry) => entry.event === 'run.end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].ok, true);
    await stopBot(handle);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
