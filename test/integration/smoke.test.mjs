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
import { dmMessage } from '../helpers/messages.mjs';

test('smoke: one owner DM runs codex and streams a reply', async () => {
  const fixture = createFixture({
    name: 'smoke',
    scenario: [
      { delayMs: 100, event: 'message', msg: dmMessage({ content: 'hello' }) },
    ],
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
    const ends = botLog(fixture).filter((entry) => entry.event === 'run.end');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].ok, true);
    await stopBot(handle);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
