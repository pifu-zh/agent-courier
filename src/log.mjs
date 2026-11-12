import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(here, '..');
export const DEFAULT_LOG_DIR = process.env.BOT_LOG_DIR || join(ROOT_DIR, 'logs');
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_KEEP = 3;
const SENSITIVE_KEYS = new Set([
  'appSecret',
  'secret',
  'token',
  'authorization',
  'password',
  'prompt',
  'content',
  'text',
  'answer',
]);
const MAX_STRING = 4096;
const CREDENTIAL_PATTERN =
  /(["']?(?:app_secret|appSecret|access_token|tenant_access_token|refresh_token|authorization|password|secret|token)["']?\s*[:=]\s*["']?)([^"'\s,}]+)/gi;

function redactString(value) {
  let out = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(CREDENTIAL_PATTERN, '$1[REDACTED]');
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated]`;
  return out;
}

export function redact(value) {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = Object.create(null);
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = typeof val === 'string' ? `[redacted len=${val.length}]` : '[redacted]';
    } else {
      out[key] = redact(val);
    }
  }
  return out;
}

export function createLogger({
  dir = DEFAULT_LOG_DIR,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  echo = true,
  now = () => new Date(),
} = {}) {
  if (!Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('maxBytes must be a positive integer');
  }
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error('keep must be a positive integer');
  }
  mkdirSync(dir, { recursive: true });

  let writes = 0;

  function dayFile(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return join(dir, `bot-${y}${m}${day}.jsonl`);
  }

  function rotate(file) {
    try {
      if (!existsSync(file) || statSync(file).size < maxBytes) return;
      for (let i = keep; i >= 1; i -= 1) {
        const from = `${file}.${i}`;
        const to = `${file}.${i + 1}`;
        if (!existsSync(from)) continue;
        if (i === keep) unlinkSync(from);
        else renameSync(from, to);
      }
      renameSync(file, `${file}.1`);
    } catch {
      // Logging must never crash the bot.
    }
  }

  function log(level, event, fields = {}) {
    const date = now();
    let line;
    try {
      const entry = { ts: date.toISOString(), level, event, ...redact(fields) };
      line = JSON.stringify(entry);
    } catch (err) {
      line = JSON.stringify({
        ts: date.toISOString(),
        level: 'error',
        event: 'log.serialize_failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    if (echo) console.log(line);
    try {
      const file = dayFile(date);
      writes += 1;
      if (writes % 50 === 0) rotate(file);
      appendFileSync(file, `${line}\n`, { mode: 0o600 });
    } catch (err) {
      if (echo) console.error('log write failed:', err.message);
    }
  }

  return {
    log,
    info: (event, fields) => log('info', event, fields),
    warn: (event, fields) => log('warn', event, fields),
    error: (event, fields) => log('error', event, fields),
  };
}

export const logger = createLogger();
