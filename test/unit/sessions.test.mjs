import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionStore } from '../../src/sessions.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'sessions-test-'));
}

function makeStore(dir, seedSessions = {}, options = {}) {
  return createSessionStore({
    file: join(dir, 'sessions.json'),
    seedSessions,
    defaultCwd: '/tmp/default-work',
    ...options,
  });
}

test('seeds a missing file and writes mode 600', async () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir, {
      oc_test: { threadId: 'thread_seed', cwd: '/tmp/work' },
    });
    await store.persist();
    const file = join(dir, 'sessions.json');
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(store.getSession('oc_test'), {
      threadId: 'thread_seed',
      cwd: '/tmp/work',
      updatedAt: store.getSession('oc_test').updatedAt,
    });
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(parsed.oc_test.threadId, 'thread_seed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setSession persists and clearThread resets only the thread', async () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    store.setSession('oc_test', { threadId: 'thread_1', cwd: '/tmp/work' });
    await store.persist();
    assert.equal(store.getSession('oc_test').threadId, 'thread_1');

    store.setSession('oc_test', { cwd: '/tmp/work2' });
    await store.persist();
    assert.equal(store.getSession('oc_test').threadId, 'thread_1');
    assert.equal(store.getSession('oc_test').cwd, '/tmp/work2');

    store.clearThread('oc_test');
    await store.persist();
    assert.equal(store.getSession('oc_test').threadId, null);
    assert.equal(store.getSession('oc_test').cwd, '/tmp/work2');

    const reloaded = makeStore(dir);
    assert.equal(reloaded.getSession('oc_test').threadId, null);
    assert.equal(reloaded.getSession('oc_test').cwd, '/tmp/work2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an existing empty file disables seeding', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'sessions.json');
    writeFileSync(file, '{}\n');
    const store = makeStore(dir, {
      oc_test: { threadId: 'thread_seed', cwd: '/tmp/work' },
    });
    assert.equal(store.getSession('oc_test'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed JSON does not throw and starts empty', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'sessions.json'), '{not json');
    const store = makeStore(dir);
    assert.deepEqual(store.allSessions(), {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid seed entries are ignored', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir, {
      bad1: { threadId: 'x', cwd: 'relative' },
      bad2: { threadId: 3, cwd: '/tmp/work' },
      good: { threadId: null, cwd: '/tmp/work' },
    });
    assert.deepEqual(Object.keys(store.allSessions()), ['good']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clearThread on an unknown scope is a no-op', () => {
  const dir = tempDir();
  try {
    const store = makeStore(dir);
    store.clearThread('missing');
    assert.equal(store.getSession('missing'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid file argument throws', () => {
  assert.throws(
    () => createSessionStore({ file: 'relative.json', defaultCwd: '/tmp/x' }),
    /absolute path/,
  );
});

test('prunes by maxEntries and ttlMs', async () => {
  const dir = tempDir();
  try {
    let time = 1000;
    const store = makeStore(dir, {}, {
      maxEntries: 2,
      ttlMs: 100,
      now: () => time,
    });
    store.setSession('a', { threadId: 'ta', cwd: '/tmp/a' });
    await store.persist();
    time = 1050;
    store.setSession('b', { threadId: 'tb', cwd: '/tmp/b' });
    await store.persist();
    time = 1100;
    store.setSession('c', { threadId: 'tc', cwd: '/tmp/c' });
    await store.persist();
    assert.deepEqual(Object.keys(store.allSessions()).sort(), ['b', 'c']);
    time = 1300;
    store.setSession('d', { threadId: 'td', cwd: '/tmp/d' });
    await store.persist();
    assert.deepEqual(Object.keys(store.allSessions()).sort(), ['d']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
