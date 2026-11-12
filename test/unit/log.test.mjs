import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger, redact } from '../../src/log.mjs';

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'log-test-'));
}

const fixedNow = () => new Date(2026, 10, 12, 12, 0, 0);

test('redacts sensitive fields recursively', () => {
  const input = {
    secret: 'abc',
    prompt: 'hello',
    nested: { token: 'tok', ok: 'yes' },
    list: [{ content: 'x' }],
  };
  const out = redact(input);
  assert.equal(out.secret, '[redacted len=3]');
  assert.equal(out.prompt, '[redacted len=5]');
  assert.equal(out.nested.token, '[redacted len=3]');
  assert.equal(out.nested.ok, 'yes');
  assert.equal(out.list[0].content, '[redacted len=1]');
});

test('redacts credential patterns in non-sensitive string fields', () => {
  const out = redact({
    note: 'Authorization: Bearer abc123',
    detail: 'app_secret=topsecret',
    json: '"token":"tok_123"',
  });
  assert.equal(out.note.includes('abc123'), false);
  assert.equal(out.detail.includes('topsecret'), false);
  assert.equal(out.json.includes('tok_123'), false);
  assert.match(out.note, /\[REDACTED\]/);
  assert.match(out.detail, /app_secret=\[REDACTED\]/);
  assert.match(out.json, /"token":"\[REDACTED\]"/);
});

test('truncates long non-sensitive strings to a fixed bound', () => {
  const out = redact({ detail: 'x'.repeat(10_000) });
  assert.ok(out.detail.length < 4200);
  assert.match(out.detail, /\[truncated\]$/);
});

test('writes JSONL with mode 600 and no plaintext secret', () => {
  const dir = tempDir();
  try {
    const logger = createLogger({ dir, echo: false, now: fixedNow });
    logger.info('demo', {
      secret: 'super-secret',
      prompt: 'do not log me',
      answer: 'private answer',
      ok: 'visible',
    });
    const file = join(dir, 'bot-20261112.jsonl');
    assert.equal(existsSync(file), true);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const raw = readFileSync(file, 'utf8');
    assert.equal(raw.includes('super-secret'), false);
    assert.equal(raw.includes('do not log me'), false);
    assert.equal(raw.includes('private answer'), false);
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.event, 'demo');
    assert.equal(entry.secret, '[redacted len=12]');
    assert.equal(entry.ok, 'visible');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rotates to .1/.2 and drops the oldest file', () => {
  const dir = tempDir();
  try {
    const logger = createLogger({
      dir,
      echo: false,
      now: fixedNow,
      maxBytes: 150,
      keep: 2,
    });
    for (let i = 0; i < 150; i += 1) {
      logger.info('tick', { i, padding: 'x'.repeat(40) });
    }
    const names = readdirSync(dir).sort();
    assert.ok(names.includes('bot-20261112.jsonl.1'));
    assert.ok(names.includes('bot-20261112.jsonl.2'));
    assert.equal(names.includes('bot-20261112.jsonl.3'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('logging never throws on unserializable fields', () => {
  const dir = tempDir();
  try {
    const logger = createLogger({ dir, echo: false, now: fixedNow });
    assert.doesNotThrow(() => logger.info('bad', { big: 1n }));
    const raw = readFileSync(join(dir, 'bot-20261112.jsonl'), 'utf8');
    assert.match(raw, /log.serialize_failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejects invalid rotation settings', () => {
  const dir = tempDir();
  try {
    assert.throws(() => createLogger({ dir, maxBytes: 0 }), /maxBytes/);
    assert.throws(() => createLogger({ dir, keep: 0 }), /keep/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
