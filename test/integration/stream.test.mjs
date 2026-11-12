import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  readJsonl,
  botLog,
  delay,
} from '../helpers/harness.mjs';
import { dmMessage } from '../helpers/messages.mjs';
import { STREAM_MAX, DELIVERY_CHUNK } from '../../src/format.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

test('falls back to a normal reply when card creation fails', async () => {
  const fixture = createFixture({
    name: 'stream-fail',
    env: { FAKE_STREAM_FAIL: '1' },
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const channel = readJsonl(fixture.channelLog);
    assert.equal(channel.some((entry) => entry.type === 'stream.content'), false);
    const replies = channel.filter((entry) => entry.type === 'reply');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].input.markdown, 'MOCK_OK');
    assert.ok(botLog(fixture).some((entry) => entry.event === 'stream.failed'));
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('falls back when a card content update fails', async () => {
  const fixture = createFixture({
    name: 'stream-content-fail',
    env: { FAKE_STREAM_CONTENT_FAIL: '1' },
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const channel = readJsonl(fixture.channelLog);
    const replies = channel.filter((entry) => entry.type === 'reply');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].input.markdown, 'MOCK_OK');
    assert.ok(botLog(fixture).some((entry) => entry.event === 'stream.update_failed'));
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('caps the streamed card and sends the remainder in paced chunks', async () => {
  const fixture = createFixture({
    name: 'stream-overflow',
    env: { MOCK_CODEX_ANSWER_BYTES: '40000' },
    scenario: [{ delayMs: 100, event: 'message', msg: dmMessage() }],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');
    const channel = readJsonl(fixture.channelLog);
    const contents = channel.filter((entry) => entry.type === 'stream.content');
    const last = contents[contents.length - 1];
    assert.ok(last.content.length < 28000);
    assert.match(last.content, /剩余部分将在任务结束后发送/);
    const replies = channel.filter((entry) => entry.type === 'reply');
    assert.equal(replies.length, 5);
    for (const reply of replies) {
      assert.ok(reply.input.markdown.length <= DELIVERY_CHUNK);
    }
    const remainderLength = replies.reduce(
      (sum, entry) => sum + entry.input.markdown.length,
      0,
    );
    assert.equal(remainderLength, 40000 - STREAM_MAX);
    const end = botLog(fixture).find((entry) => entry.event === 'run.end');
    assert.equal(end.overflow, true);
    assert.equal(end.streamed, true);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

