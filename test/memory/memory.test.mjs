import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  stopBot,
  cleanupFixture,
  waitFor,
  waitForBotCount,
  botLog,
  sampleProcess,
  triggerGc,
  triggerReport,
  delay,
} from '../helpers/harness.mjs';
import { textMessage } from '../helpers/messages.mjs';

async function start(fixture) {
  const handle = spawnBot(fixture);
  await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
  return handle;
}

async function sampleBot(handle, fixture) {
  let heapUsed = 0;
  let proc = sampleProcess(handle.child.pid);
  // Transient work can still be in flight right after the last run.end.
  // Force GC and re-sample a few times; the minimum is the retained heap.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await triggerGc(handle, 400);
    proc = sampleProcess(handle.child.pid);
    const report = await triggerReport(handle, fixture);
    const used =
      report?.report?.javascriptHeap?.memoryUsage?.heapUsed ??
      report?.report?.javascriptHeap?.usedMemory ??
      0;
    if (used > 0) heapUsed = heapUsed ? Math.min(heapUsed, used) : used;
    if (heapUsed > 0 && heapUsed < 8 * 1024 * 1024) break;
  }
  return {
    rssKb: proc.rssKb,
    pssKb: proc.pssKb,
    hwmKb: proc.hwmKb,
    heapUsed,
  };
}

function assertNoRuntimeErrors(fixture) {
  const bad = botLog(fixture).filter((entry) =>
    ['run.unhandled', 'queue.execute_failed', 'uncaught_exception'].includes(
      entry.event,
    ),
  );
  assert.deepEqual(bad, []);
}

test('idle bot does not grow over time', async () => {
  const fixture = createFixture({ name: 'memory-idle' });
  let handle;
  try {
    handle = await start(fixture);
    await delay(1000);
    const first = await sampleBot(handle, fixture);
    await delay(8000);
    const second = await sampleBot(handle, fixture);
    console.log('MEMORY_IDLE', JSON.stringify({ first, second }));
    assert.ok(first.heapUsed > 0 && second.heapUsed > 0, 'diagnostic report missing heapUsage');
    assert.ok(
      second.rssKb - first.rssKb < 12 * 1024,
      `rss grew ${second.rssKb - first.rssKb} KiB`,
    );
    assert.ok(
      second.heapUsed - first.heapUsed < 6 * 1024 * 1024,
      `heap grew ${second.heapUsed - first.heapUsed} bytes`,
    );
    assertNoRuntimeErrors(fixture);
  } finally {
    cleanupFixture(fixture, handle);
  }
});

test('repeated large runs return to a bounded baseline', async () => {
  const scenario = [];
  for (let i = 0; i < 20; i += 1) {
    scenario.push({
      delayMs: 100 + i * 100,
      event: 'message',
      msg: textMessage({ content: `batch-a ${i} [[sleep=20]]` }),
    });
  }
  for (let i = 0; i < 20; i += 1) {
    scenario.push({
      delayMs: 4000 + i * 100,
      event: 'message',
      msg: textMessage({ content: `batch-b ${i} [[sleep=20]]` }),
    });
  }
  for (let i = 0; i < 20; i += 1) {
    scenario.push({
      delayMs: 8000 + i * 100,
      event: 'message',
      msg: textMessage({ content: `batch-c ${i} [[sleep=20]]` }),
    });
  }
  const fixture = createFixture({
    name: 'memory-load',
    env: {
      MOCK_CODEX_EVENTS: '10',
      MOCK_CODEX_TOOL_BYTES: '100000',
      MOCK_CODEX_ANSWER_BYTES: '20000',
      FAKE_CHANNEL_CLIP: '500',
    },
    scenario,
  });
  let handle;
  try {
    handle = await start(fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 20, {
      timeout: 20000,
    });
    await delay(500);
    const first = await sampleBot(handle, fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 40, {
      timeout: 30000,
    });
    await delay(500);
    const second = await sampleBot(handle, fixture);
    await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 60, {
      timeout: 40000,
    });
    await delay(500);
    const third = await sampleBot(handle, fixture);

    console.log('MEMORY_LOAD', JSON.stringify({ first, second, third }));
    assert.ok(first.heapUsed > 0 && second.heapUsed > 0 && third.heapUsed > 0, 'diagnostic report missing heapUsage');
    assert.ok(
      second.rssKb - first.rssKb < 30 * 1024,
      `rss grew ${second.rssKb - first.rssKb} KiB across batches`,
    );
    assert.ok(
      second.pssKb - first.pssKb < 30 * 1024,
      `pss grew ${second.pssKb - first.pssKb} KiB across batches`,
    );
    assert.ok(
      second.heapUsed - first.heapUsed < 12 * 1024 * 1024,
      `heap grew ${second.heapUsed - first.heapUsed} bytes across batches`,
    );
    assert.ok(
      third.rssKb - second.rssKb < 20 * 1024,
      `rss kept growing ${third.rssKb - second.rssKb} KiB in batch c`,
    );
    assert.ok(
      third.pssKb - second.pssKb < 20 * 1024,
      `pss kept growing ${third.pssKb - second.pssKb} KiB in batch c`,
    );
    assert.ok(
      third.heapUsed - second.heapUsed < 8 * 1024 * 1024,
      `heap kept growing ${third.heapUsed - second.heapUsed} bytes in batch c`,
    );
    assert.ok(third.heapUsed < 200 * 1024 * 1024);
    assertNoRuntimeErrors(fixture);
  } finally {
    cleanupFixture(fixture, handle);
  }
});
