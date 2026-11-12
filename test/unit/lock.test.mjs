import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from '../../src/lock.mjs';

test('acquires and releases a lock file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const file = join(dir, 'bot.lock');
    const lock = acquireLock(file);
    assert.ok(lock);
    assert.equal(readFileSync(file, 'utf8'), String(process.pid));
    lock.release();
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a lock held by a live process', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const file = join(dir, 'bot.lock');
    writeFileSync(file, String(process.ppid), { mode: 0o600 });
    const lock = acquireLock(file);
    assert.equal(lock, null);
    assert.equal(existsSync(file), true);
    assert.equal(readFileSync(file, 'utf8'), String(process.ppid));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('takes over a stale lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const file = join(dir, 'bot.lock');
    writeFileSync(file, '0', { mode: 0o600 });
    const lock = acquireLock(file);
    assert.ok(lock);
    assert.equal(readFileSync(file, 'utf8'), String(process.pid));
    lock.release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('does not treat EPERM as a stale lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lock-test-'));
  try {
    const file = join(dir, 'bot.lock');
    writeFileSync(file, '1', { mode: 0o600 });
    const lock = acquireLock(file);
    assert.equal(lock, null);
    assert.equal(readFileSync(file, 'utf8'), '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
