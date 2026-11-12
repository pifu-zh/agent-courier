import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  stopBot,
  cleanupFixture,
  waitFor,
  waitForCount,
  waitForBotCount,
  readJsonl,
} from '../helpers/harness.mjs';
import { textMessage } from '../helpers/messages.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

function maxConcurrency(events) {
  const starts = events.filter((entry) => entry.type === 'start');
  const ends = new Map(
    events
      .filter((entry) => entry.type === 'end')
      .map((entry) => [entry.pid, entry.at]),
  );
  const intervals = starts.map((entry) => ({
    start: entry.ts,
    end: ends.get(entry.pid) ?? Date.now(),
  }));
  let max = 0;
  for (const interval of intervals) {
    const active = intervals.filter(
      (other) => other.start <= interval.start && other.end > interval.start,
    ).length;
    max = Math.max(max, active);
  }
  return max;
}

test('serializes two messages in the same scope and marks the second as queued', async () => {
  const fixture = createFixture({
    name: 'queue-serial',
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ content: 'first [[sleep=300]]' }),
      },
      {
        delayMs: 120,
        event: 'message',
        msg: textMessage({ content: 'second [[sleep=300]]' }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 2);
    const events = readJsonl(fixture.codexLog);
    const starts = events.filter((entry) => entry.type === 'start');
    const ends = new Map(
      events.filter((entry) => entry.type === 'end').map((entry) => [entry.pid, entry.at]),
    );
    assert.equal(starts.length, 2);
    assert.ok(ends.get(starts[0].pid) <= starts[1].ts, 'second started before first ended');
    const replies = readJsonl(fixture.channelLog).filter(
      (entry) => entry.type === 'reply',
    );
    assert.ok(
      replies.some((entry) => entry.input?.markdown?.includes('已排队')),
      'missing queued acknowledgement',
    );
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('never exceeds the global concurrency limit', async () => {
  const fixture = createFixture({
    name: 'queue-global',
    configOverrides: {
      allowedChats: ['oc_test', 'oc_test2', 'oc_test3'],
    },
    scenario: [
      {
        delayMs: 100,
        event: 'message',
        msg: textMessage({ content: 'a [[sleep=300]]' }),
      },
      {
        delayMs: 110,
        event: 'message',
        msg: textMessage({
          chatId: 'oc_test2',
          content: 'b [[sleep=300]]',
        }),
      },
      {
        delayMs: 120,
        event: 'message',
        msg: textMessage({
          chatId: 'oc_test3',
          content: 'c [[sleep=300]]',
        }),
      },
    ],
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 3);
    const events = readJsonl(fixture.codexLog);
    assert.equal(events.filter((entry) => entry.type === 'start').length, 3);
    assert.equal(maxConcurrency(events), 2);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('rejects messages beyond the per-scope queue cap', async () => {
  const scenario = [];
  for (let i = 0; i < 25; i += 1) {
    scenario.push({
      delayMs: 100 + i * 10,
      event: 'message',
      msg: textMessage({ content: `burst ${i} [[sleep=5000]]` }),
    });
  }
  const fixture = createFixture({ name: 'queue-cap', scenario });
  let handle;
  try {
    handle = await start(fixture);
    const replies = await waitForCount(
      fixture.channelLog,
      (entry) =>
        entry.type === 'reply' &&
        entry.input?.markdown?.includes('队列已满'),
      4,
      { timeout: 5000 },
    );
    assert.equal(replies.length, 4);
    await stopBot(handle);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
