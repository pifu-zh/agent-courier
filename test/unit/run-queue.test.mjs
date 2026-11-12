import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunQueue } from '../../src/run-queue.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, timeout = 1000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeout) throw new Error('waitUntil timeout');
    await delay(5);
  }
}

async function finish(queue) {
  queue.shutdown();
  await queue.waitForIdle(1000);
}

test('limits global concurrency and eventually runs every scope', async () => {
  let active = 0;
  let maxActive = 0;
  const started = [];
  const queue = createRunQueue({
    maxConcurrent: 2,
    execute: async (scope) => {
      started.push(scope);
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(40);
      active -= 1;
    },
  });
  try {
    queue.enqueue('a', {});
    queue.enqueue('b', {});
    queue.enqueue('c', {});
    assert.equal(await queue.waitForIdle(2000), true);
    assert.equal(maxActive, 2);
    assert.deepEqual(started.sort(), ['a', 'b', 'c']);
    assert.equal(queue.activeCount, 0);
  } finally {
    await finish(queue);
  }
});

test('runs the same scope strictly serially', async () => {
  const events = [];
  const queue = createRunQueue({
    maxConcurrent: 4,
    execute: async (scope, item) => {
      events.push(`start:${item.n}`);
      await delay(30);
      events.push(`end:${item.n}`);
    },
  });
  try {
    queue.enqueue('s', { n: 1 });
    queue.enqueue('s', { n: 2 });
    assert.equal(await queue.waitForIdle(2000), true);
    assert.deepEqual(events, ['start:1', 'end:1', 'start:2', 'end:2']);
  } finally {
    await finish(queue);
  }
});

test('caps the per-scope queue and rejects overflow', async () => {
  const gate = deferred();
  const calls = [];
  const queue = createRunQueue({
    maxConcurrent: 1,
    maxQueuePerScope: 2,
    execute: async (scope, item) => {
      calls.push(item.n);
      await gate.promise;
    },
  });
  try {
    const first = queue.enqueue('s', { n: 1 });
    const second = queue.enqueue('s', { n: 2 });
    const third = queue.enqueue('s', { n: 3 });
    const fourth = queue.enqueue('s', { n: 4 });
    assert.equal(first.accepted, true);
    assert.equal(first.queued, false);
    assert.deepEqual(
      [second.accepted, second.queued, second.depth],
      [true, true, 1],
    );
    assert.deepEqual(
      [third.accepted, third.queued, third.depth],
      [true, true, 2],
    );
    assert.deepEqual(
      [fourth.accepted, fourth.reason, fourth.depth],
      [false, 'full', 2],
    );
    gate.resolve();
    assert.equal(await queue.waitForIdle(2000), true);
    assert.deepEqual(calls, [1, 2, 3]);
  } finally {
    gate.resolve();
    await finish(queue);
  }
});

test('abort cancels an active run and releases its slot', async () => {
  const aborted = [];
  const queue = createRunQueue({
    maxConcurrent: 1,
    execute: async (scope, item, signal) => {
      if (signal.aborted) {
        aborted.push(item.n);
        return;
      }
      await new Promise((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted.push(item.n);
            resolve();
          },
          { once: true },
        );
      });
    },
  });
  try {
    queue.enqueue('a', { n: 1 });
    await waitUntil(() => queue.getState('a').running);
    assert.equal(queue.abort('a'), true);
    assert.equal(await queue.waitForIdle(1000), true);
    assert.deepEqual(aborted, [1]);
    assert.equal(queue.activeCount, 0);
  } finally {
    await finish(queue);
  }
});

test('abort cancels a pending run waiting for a global slot', async () => {
  const gate = deferred();
  const calls = [];
  const queue = createRunQueue({
    maxConcurrent: 1,
    execute: async (scope) => {
      calls.push(scope);
      await gate.promise;
    },
  });
  try {
    queue.enqueue('a', {});
    queue.enqueue('b', {});
    await waitUntil(() => queue.getState('b').waiting);
    assert.equal(queue.abort('b'), true);
    gate.resolve();
    assert.equal(await queue.waitForIdle(2000), true);
    assert.deepEqual(calls, ['a']);
    assert.equal(queue.getState('b').running, false);
    assert.equal(queue.getState('b').waiting, false);
  } finally {
    gate.resolve();
    await finish(queue);
  }
});

test('shutdown aborts active work and rejects new work', async () => {
  const queue = createRunQueue({
    maxConcurrent: 1,
    execute: async (scope, item, signal) => {
      if (signal.aborted) return;
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    },
  });
  try {
    queue.enqueue('a', { n: 1 });
    queue.enqueue('a', { n: 2 });
    await waitUntil(() => queue.getState('a').running);
    queue.shutdown();
    assert.equal(await queue.waitForIdle(1000), true);
    const result = queue.enqueue('a', { n: 3 });
    assert.deepEqual(
      [result.accepted, result.reason],
      [false, 'closed'],
    );
  } finally {
    await finish(queue);
  }
});

test('a failing execute releases the slot for the next scope', async () => {
  let calls = 0;
  const errors = [];
  const queue = createRunQueue({
    maxConcurrent: 1,
    execute: async () => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
    },
    logger: {
      info() {},
      warn() {},
      error: (event, fields) => errors.push({ event, fields }),
    },
  });
  try {
    queue.enqueue('a', {});
    queue.enqueue('b', {});
    assert.equal(await queue.waitForIdle(2000), true);
    assert.equal(calls, 2);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].event, 'queue.execute_failed');
  } finally {
    await finish(queue);
  }
});

test('waitForIdle reports timeout, then true when work finishes', async () => {
  const gate = deferred();
  const queue = createRunQueue({
    maxConcurrent: 1,
    execute: async () => {
      await gate.promise;
    },
  });
  try {
    queue.enqueue('a', {});
    assert.equal(await queue.waitForIdle(50), false);
    gate.resolve();
    assert.equal(await queue.waitForIdle(1000), true);
  } finally {
    gate.resolve();
    await finish(queue);
  }
});

test('validates constructor arguments', () => {
  assert.throws(
    () => createRunQueue({ maxConcurrent: 0, execute() {} }),
    /maxConcurrent/,
  );
  assert.throws(
    () => createRunQueue({ maxConcurrent: 1, maxQueuePerScope: -1, execute() {} }),
    /maxQueuePerScope/,
  );
  assert.throws(
    () => createRunQueue({ maxConcurrent: 1, execute: null }),
    /execute/,
  );
});
