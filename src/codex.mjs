import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { logger as defaultLogger } from './log.mjs';

const STDERR_TAIL_BYTES = 64 * 1024;
const TOOL_OUTPUT_MAX = 4096;
const POST_DONE_EXIT_GRACE_MS = 5000;
const STDOUT_DRAIN_GRACE_MS = 250;
const MAX_ANSWER_BUFFER = 200_000;
const MAX_LINE_CHARS = 8 * 1024 * 1024;

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
      callback(new Error(`codex JSONL line exceeds ${this.maxChars} characters`));
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

function clip(value, max) {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated]`;
}

function isolationHides(hidePaths = []) {
  const hides = [];
  for (const path of hidePaths) {
    if (typeof path !== 'string' || !path.startsWith('/') || !existsSync(path)) continue;
    try {
      const real = realpathSync.native(path);
      hides.push({ path: real, isDirectory: statSync(real).isDirectory() });
    } catch {
      // the path disappeared or cannot be resolved
    }
  }
  return hides;
}

export function buildCodexArgs({ cwd, sandbox, model, threadId }) {
  const flags = [
    '--sandbox',
    sandbox,
    ...(model ? ['--model', model] : []),
    '-c',
    'approval_policy="never"',
    '-c',
    'shell_environment_policy.inherit="all"',
    '--ignore-rules',
    '--skip-git-repo-check',
    '-C',
    cwd,
  ];

  if (threadId) {
    return ['exec', ...flags, 'resume', '--json', threadId, '-'];
  }
  return ['exec', '--json', ...flags, '-'];
}

export async function runCodex({
  prompt,
  cwd,
  sandbox,
  model,
  threadId,
  codexBin,
  timeoutMs,
  stopGraceMs,
  signal,
  onThreadId,
  onAnswer,
  onTool,
  logger = defaultLogger,
  postDoneGraceMs = POST_DONE_EXIT_GRACE_MS,
  env = {},
  isolation = { enabled: false, hidePaths: [] },
}) {
  const args = buildCodexArgs({ cwd, sandbox, model, threadId });
  const bwrapBin = process.env.BWRAP_BIN || '/usr/bin/bwrap';
  const isolated = isolation.enabled === true && existsSync(bwrapBin);
  const hides = isolated ? isolationHides(isolation.hidePaths) : [];
  const spawnBin = isolated ? bwrapBin : codexBin;
  const spawnArgs = isolated
    ? [
        '--die-with-parent',
        '--unshare-pid',
        '--dev-bind',
        '/',
        '/',
        '--proc',
        '/proc',
        ...hides.flatMap((hide) =>
          hide.isDirectory
            ? ['--tmpfs', hide.path]
            : ['--ro-bind', '/dev/null', hide.path],
        ),
        '--',
        codexBin,
        ...args,
      ]
    : args;
  logger.info?.('codex.spawn', {
    cwd,
    sandbox,
    resume: Boolean(threadId),
    model: model || 'default',
    isolated,
    hiddenPaths: hides.length,
  });

  const childEnv = { ...process.env, ...env };
  delete childEnv.LARK_APP_SECRET;

  const child = spawn(spawnBin, spawnArgs, {
    cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let stderrTail = '';
  let thread = threadId || null;
  let answer = '';
  let terminal = false;
  let failed = false;
  let lastError = '';
  let timedOut = false;
  let aborted = false;
  let spawnError = null;
  let postDoneTimer = null;
  let postDoneKilled = false;
  let rl = null;
  let lineError = null;
  const unknownEvents = new Set();

  const appendAgentMessage = (text) => {
    if (typeof text !== 'string' || !text) return;
    if (!answer) {
      answer = text;
    } else if (text === answer || answer.endsWith(text)) {
      return;
    } else if (text.startsWith(answer)) {
      answer = text;
    } else {
      answer = `${answer}\n\n${text}`;
    }
    if (answer.length > MAX_ANSWER_BUFFER) {
      answer = answer.slice(-MAX_ANSWER_BUFFER);
    }
    onAnswer?.(answer);
  };

  let killTimer = null;

  const signalTree = (signal) => {
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // fall back to the direct child
      }
    }
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  };

  const killGracefully = () => {
    signalTree('SIGTERM');
    if (killTimer) clearTimeout(killTimer);
    killTimer = setTimeout(() => {
      killTimer = null;
      signalTree('SIGKILL');
    }, stopGraceMs);
    killTimer.unref?.();
  };

  const armPostDoneKill = () => {
    if (postDoneTimer) return;
    postDoneTimer = setTimeout(() => {
      postDoneTimer = null;
      postDoneKilled = true;
      logger.warn?.('codex.post_done_exit_timeout', { graceMs: postDoneGraceMs });
      killGracefully();
    }, postDoneGraceMs);
    postDoneTimer.unref?.();
  };

  const clearPostDoneTimer = () => {
    if (!postDoneTimer) return;
    clearTimeout(postDoneTimer);
    postDoneTimer = null;
  };

  const timeout = setTimeout(() => {
    timedOut = true;
    killGracefully();
  }, timeoutMs);
  timeout.unref?.();

  const onAbort = () => {
    aborted = true;
    killGracefully();
  };

  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  child.on('error', (err) => {
    spawnError = err;
  });
  child.once('exit', () => {
    clearPostDoneTimer();
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (child.stdout && !child.stdout.readableEnded) {
      const drainTimer = setTimeout(() => {
        try {
          rl?.close();
          if (!child.stdout.readableEnded) child.stdout.destroy();
        } catch {
          // already closed
        }
      }, STDOUT_DRAIN_GRACE_MS);
    }
  });
  child.once('close', clearPostDoneTimer);

  if (!child.stdout || !child.stderr || !child.stdin) {
    clearTimeout(timeout);
    clearPostDoneTimer();
    if (signal) signal.removeEventListener('abort', onAbort);
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode: -1,
      error: spawnError ? `failed to spawn codex: ${spawnError.message}` : 'failed to open codex pipes',
      timedOut,
      aborted,
    };
  }

  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES);
  });

  child.stdin.on('error', () => {
    // Codex can close stdin early; the exit status carries the real error.
  });
  child.stdin.end(prompt, 'utf8');

  const limiter = new LineLimiter();
  child.stdout.pipe(limiter);
  limiter.on('error', (err) => {
    lineError = err;
    logger.warn?.('codex.line_too_large', { message: err.message });
    killGracefully();
    try {
      rl?.close();
    } catch {
      // already closed
    }
  });
  rl = createInterface({ input: limiter, crlfDelay: Infinity });
  rl.on('error', () => {
    // the limiter's error handler owns reporting and child termination
  });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!event || typeof event !== 'object') continue;
      if (terminal) continue;

      switch (event.type) {
        case 'thread.started': {
          const id = event.thread_id ?? event.threadId;
          if (typeof id === 'string' && id) {
            thread = id;
            onThreadId?.(id);
          }
          break;
        }
        case 'item.started': {
          const item = event.item;
          if (item && typeof item === 'object' && item.type === 'command_execution') {
            const command = typeof item.command === 'string' ? item.command : '';
            if (command) onTool?.({ command, phase: 'started' });
          }
          break;
        }
        case 'item.completed': {
          const item = event.item;
          if (!item || typeof item !== 'object') break;
          if (item.type === 'agent_message') {
            const text = item.text ?? item.message;
            if (typeof text === 'string' && text) appendAgentMessage(text);
          } else if (item.type === 'command_execution') {
            const command = typeof item.command === 'string' ? item.command : '';
            const rawOutput =
              typeof item.aggregated_output === 'string'
                ? item.aggregated_output
                : typeof item.output === 'string'
                  ? item.output
                  : '';
            onTool?.({
              command,
              output: clip(rawOutput, TOOL_OUTPUT_MAX),
              exitCode: item.exit_code,
              phase: 'completed',
            });
          }
          break;
        }
        case 'agent_message': {
          const text = event.message ?? event.text;
          if (typeof text === 'string' && text) appendAgentMessage(text);
          break;
        }
        case 'turn.started':
          break;
        case 'turn.completed':
          terminal = true;
          armPostDoneKill();
          break;
        case 'turn.failed': {
          terminal = true;
          failed = true;
          const failure = event.error;
          lastError = String(
            failure?.message ??
              (typeof failure === 'string' ? failure : event.message) ??
              'codex turn failed',
          );
          armPostDoneKill();
          break;
        }
        case 'error': {
          const failure = event.error;
          lastError = String(
            event.message ??
              (typeof failure === 'string' ? failure : failure?.message) ??
              'codex error',
          );
          logger.warn?.('codex.event_error', { message: lastError.slice(0, 300) });
          break;
        }
        default:
          if (typeof event.type === 'string' && !unknownEvents.has(event.type)) {
            unknownEvents.add(event.type);
            logger.warn?.('codex.unknown_event', { type: event.type });
          }
          break;
      }
    }
  } catch (err) {
    logger.warn?.('codex.stdout_error', { message: err?.message || String(err) });
  } finally {
    clearTimeout(timeout);
    if (signal) signal.removeEventListener('abort', onAbort);
    rl.close();
  }

  if (child.exitCode === null && child.signalCode === null) {
    armPostDoneKill();
  }

  const exitCode = await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    if (child.signalCode !== null) return resolve(1);
    if (spawnError) return resolve(-1);

    const done = (code) => {
      child.off('exit', onExit);
      child.off('error', onError);
      child.off('close', onClose);
      resolve(code);
    };
    const onExit = (code) => done(code ?? 1);
    const onError = () => done(-1);
    const onClose = (code) => done(code ?? -1);

    child.once('exit', onExit);
    child.once('error', onError);
    child.once('close', onClose);
  });

  if (spawnError) {
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode: -1,
      error: `failed to spawn codex: ${spawnError.message}`,
      timedOut,
      aborted,
    };
  }
  if (timedOut) {
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: `codex timed out after ${Math.round(timeoutMs / 1000)}s`,
      timedOut,
      aborted,
    };
  }
  if (aborted) {
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: '已停止',
      timedOut,
      aborted,
      cancelled: true,
    };
  }
  if (failed) {
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: lastError || 'codex turn failed',
      timedOut,
      aborted,
    };
  }
  if (lineError && !terminal) {
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: `codex output line too large: ${lineError.message}`,
      timedOut,
      aborted,
    };
  }
  if (exitCode !== 0 && !(terminal && !failed && postDoneKilled)) {
    const tail = stderrTail.trim().slice(-2000);
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: `codex exited with code ${exitCode}${tail ? `: ${tail}` : ''}`,
      timedOut,
      aborted,
    };
  }
  if (!terminal) {
    const detail = lastError ? `: ${lastError}` : '';
    return {
      ok: false,
      threadId: thread,
      answer,
      exitCode,
      error: `codex stream ended before a terminal event${detail}`,
      timedOut,
      aborted,
      unknownEventTypes: [...unknownEvents],
    };
  }

  return {
    ok: true,
    threadId: thread,
    answer,
    exitCode,
    error: null,
    timedOut,
    aborted,
    unknownEventTypes: [...unknownEvents],
  };
}
