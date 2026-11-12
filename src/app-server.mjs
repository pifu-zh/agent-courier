import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { logger as defaultLogger } from './log.mjs';

const MAX_LINE_CHARS = 16 * 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const STARTUP_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;

class LineLimiter extends Transform {
  constructor(maxChars = MAX_LINE_CHARS) {
    super();
    this.maxChars = maxChars;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  _transform(chunk, encoding, callback) {
    this.buffer += this.decoder.write(chunk);
    if (this.buffer.length > this.maxChars) {
      callback(new Error(`app-server JSONL line exceeds ${this.maxChars} characters`));
      return;
    }
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      this.push(this.buffer.slice(0, index + 1));
      this.buffer = this.buffer.slice(index + 1);
    }
    callback();
  }

  _flush(callback) {
    this.buffer += this.decoder.end();
    if (this.buffer) this.push(this.buffer);
    callback();
  }
}

function errorMessage(error) {
  if (!error) return 'unknown app-server error';
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string') return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function createAppServer({
  command,
  args,
  cwd,
  env = {},
  logger = defaultLogger,
  clientInfo = { name: 'agent-courier', title: 'Agent Courier', version: '0.1.0' },
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let child = null;
  let rl = null;
  let pending = new Map();
  let listeners = new Set();
  let seq = 0;
  let alive = false;
  let stopping = false;
  let stderrTail = '';
  let info = null;
  let fatalError = null;

  const notify = (method, params) => {
    for (const listener of listeners) {
      try {
        listener(method, params);
      } catch (err) {
        logger.warn?.('appserver.listener_failed', { message: err.message });
      }
    }
  };

  const rejectPending = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const handleMessage = (message) => {
    if (!message || typeof message !== 'object') return;

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(errorMessage(message.error)));
      else waiter.resolve(message.result);
      return;
    }

    if (message.id !== undefined && typeof message.method === 'string') {
      logger.warn?.('appserver.server_request', { method: message.method });
      try {
        child?.stdin.write(
          `${JSON.stringify({
            id: message.id,
            error: { code: -32601, message: `unsupported request: ${message.method}` },
          })}\n`,
        );
      } catch {
        // the server is gone
      }
      return;
    }

    if (typeof message.method === 'string') {
      notify(message.method, message.params);
    }
  };

  const onExit = (code, signal) => {
    alive = false;
    const detail = stderrTail.trim().slice(-2000);
    const error = new Error(
      `app-server exited (code=${code ?? 'null'}, signal=${signal ?? 'none'})${detail ? `: ${detail}` : ''}`,
    );
    rejectPending(error);
    if (stopping) return;
    notify('exit', { code, signal, error: error.message });
  };

  async function start() {
    if (alive) return info;
    if (child) throw new Error('app-server has already been started');

    const childEnv = { ...process.env, ...env };
    delete childEnv.LARK_APP_SECRET;

    child = spawn(command, args, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });

    const limiter = new LineLimiter();
    child.stdout.pipe(limiter);
    limiter.on('error', (err) => {
      fatalError = err;
      logger.error?.('appserver.line_too_large', { message: err.message });
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
    });
    rl = createInterface({ input: limiter, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      handleMessage(message);
    });

    child.once('error', (err) => {
      fatalError = err;
      alive = false;
      rejectPending(new Error(`failed to spawn app-server: ${err.message}`));
      notify('exit', { error: err.message });
    });
    child.once('exit', onExit);
    child.stdin.on('error', () => {
      // writes fail after the server exits; pending requests carry the error
    });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`app-server did not spawn within ${startupTimeoutMs}ms`)),
        startupTimeoutMs,
      );
      child.once('spawn', () => {
        clearTimeout(timer);
        alive = true;
        resolve();
      });
      child.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`failed to spawn app-server: ${err.message}`));
      });
    });

    info = await request(
      'initialize',
      { clientInfo, capabilities: null },
      { timeoutMs: startupTimeoutMs },
    );
    logger.info?.('appserver.ready', {
      pid: child.pid,
      userAgent: info?.userAgent,
      platformOs: info?.platformOs,
    });
    return info;
  }

  function request(method, params, { timeoutMs = requestTimeoutMs, signal } = {}) {
    if (!alive || !child?.stdin) {
      return Promise.reject(
        fatalError
          ? new Error(`app-server unavailable: ${fatalError.message}`)
          : new Error('app-server is not running'),
      );
    }
    if (signal?.aborted) {
      return Promise.reject(new Error('request aborted'));
    }

    seq += 1;
    const id = seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();

      const onAbort = () => {
        pending.delete(id);
        clearTimeout(timer);
        reject(new Error('request aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (err) => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
        timer,
      });

      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`failed to write to app-server: ${err.message}`));
      }
    });
  }

  async function stop({ graceMs = 2000 } = {}) {
    if (!child) return;
    stopping = true;
    alive = false;
    try {
      child.stdin.end();
    } catch {
      // already closed
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // already gone
        }
        resolve();
      }, graceMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      rl?.close();
    } catch {
      // already closed
    }
    child = null;
    rl = null;
    info = null;
    stopping = false;
  }

  return {
    start,
    stop,
    request,
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get pid() {
      return child?.pid ?? 0;
    },
    get alive() {
      return alive;
    },
    get stopping() {
      return stopping;
    },
  };
}
