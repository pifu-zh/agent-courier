import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLarkChannel } from '@larksuite/channel';
import { loadConfig, isCwdAllowed } from './config.mjs';
import { logger } from './log.mjs';
import { createSessionStore } from './sessions.mjs';
import { createCodexRunner } from './codex.mjs';
import {
  clipAnswer,
  renderForStream,
  appendProgress,
  STREAM_MAX,
  DELIVERY_MAX,
  DELIVERY_CHUNK,
} from './format.mjs';
import { acquireLock } from './lock.mjs';
import { BoundedCache } from './cache.mjs';

const SCOPE = 'main';
const config = loadConfig();
const lock = acquireLock(join(config.rootDir, 'bot.lock'), { logger });
if (!lock) process.exit(1);

const sessions = createSessionStore({
  file: config.sessionsFile,
  seedSessions: config.seedSessions,
  defaultCwd: config.defaultCwd,
  logger,
});

function ensureMainSession() {
  const current = sessions.getSession(SCOPE);
  if (current) return current;
  const existing = Object.values(sessions.allSessions())
    .filter((entry) => entry?.threadId)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  const seed = existing || Object.values(config.seedSessions)[0];
  sessions.setSession(SCOPE, {
    threadId: seed?.threadId || null,
    cwd: seed?.cwd || config.defaultCwd,
  });
  return sessions.getSession(SCOPE);
}

ensureMainSession();
const runner = createCodexRunner({
  codexBin: config.codexBin,
  logger,
  developerInstructions: config.developerInstructions,
});
try {
  const backend = await runner.start();
  logger.info('appserver.started', backend);
} catch (err) {
  logger.error('appserver.start_failed', { message: err.message });
  process.exit(1);
}

const HELP = [
  '**Codex 命令**',
  '- `/new` 或 `/reset`：开始新会话',
  '- `/stop`：停止当前任务',
  '- `/status`：查看 thread / cwd / 当前任务',
  '- `/cd <绝对路径>`：切换工作目录并开始新会话',
  '- `/help`：显示本帮助',
  '',
  '直接发消息即可继续和 Codex 对话。',
].join('\n');

for (const dir of new Set([
  config.defaultCwd,
  ...Object.values(config.seedSessions).map((s) => s?.cwd).filter(Boolean),
])) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

let streamUpdateFailures = 0;

function logArgToString(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

const sdkLogger = {
  debug() {},
  info() {},
  warn: (...args) => {
    const text = args.map(logArgToString).join(' ');
    if (text.includes('[stream] update failed')) streamUpdateFailures += 1;
    logger.warn('sdk.warn', { text });
  },
  error: (...args) => {
    logger.error('sdk.error', { text: args.map(logArgToString).join(' ') });
  },
};

const channel = createLarkChannel({
  appId: config.appId,
  appSecret: config.appSecret,
  policy: {
    dmMode: 'allowlist',
    dmAllowlist: config.allowedDmUsers,
    groupAllowlist: [],
    requireMention: false,
    respondToMentionAll: false,
  },
  safety: {
    chatQueue: { enabled: false },
    dedup: { ttl: 12 * 60 * 60 * 1000, maxEntries: 5000, sweepIntervalMs: 5 * 60 * 1000 },
    staleMessageWindowMs: 30 * 60 * 1000,
  },
  resolveChatMode: false,
  outbound: {
    streamThrottleMs: 400,
    textChunkLimit: 3500,
    streamInitialText: '正在处理…',
    streamMaxElementChars: 28000,
  },
  wsConfig: { pingTimeout: 10 },
  keepalive: {
    enabled: true,
    intervalMs: 15000,
    onUnrecoverable: (err) => {
      logger.error('channel.unrecoverable', {
        message: err?.message || String(err),
      });
      void shutdown('keepalive', 1);
    },
  },
  handshakeTimeoutMs: 8000,
  connectTimeoutMs: 15000,
  httpTimeoutMs: 30000,
  respectProxyEnv: true,
  logger: sdkLogger,
  cache: new BoundedCache({ maxEntries: 10_000 }),
  source: 'agent-courier',
});

let shuttingDown = false;
let active = null;
let startingTurn = null;

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isRetryableSendError(err) {
  const status = err?.response?.status;
  const code = err?.response?.data?.code ?? err?.code;
  return (
    status === 429 ||
    code === 99991400 ||
    code === 'rate_limited' ||
    code === 'unknown'
  );
}

async function sendChunk(msg, markdown) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const result = await channel.reply(msg, { markdown });
      if (!result?.messageId) throw new Error('reply returned no messageId');
      return result;
    } catch (err) {
      logger.warn('reply.chunk_failed', {
        attempt,
        message: err?.message || String(err),
        code: err?.code,
        status: err?.response?.status,
        feishuCode: err?.response?.data?.code,
      });
      if (attempt === 2 || !isRetryableSendError(err)) return null;
      await sleep(250 * (attempt + 1));
    }
  }
  return null;
}

function safeReply(msg, markdown) {
  return sendChunk(msg, markdown);
}

async function sendLong(msg, markdown) {
  if (!markdown) return;
  const text =
    markdown.length > DELIVERY_MAX
      ? `${markdown.slice(0, DELIVERY_MAX)}\n\n…[内容过长，已截断]`
      : markdown;
  for (let offset = 0; offset < text.length; offset += DELIVERY_CHUNK) {
    const chunk = text.slice(offset, offset + DELIVERY_CHUNK);
    if (!chunk) continue;
    const result = await sendChunk(msg, chunk);
    if (!result) {
      logger.error('reply.delivery_failed', {
        offset,
        chunkLen: chunk.length,
        totalLen: text.length,
      });
      break;
    }
    if (offset + DELIVERY_CHUNK < text.length) await sleep(250);
  }
}

function createDisplay(msg) {
  let latest = '';
  let progress = '';
  let lastTool = '';
  let controller = null;
  let streamError = null;
  let updateTimer = null;
  const failuresBefore = streamUpdateFailures;
  let resolveGate;
  const gate = new Promise((resolveStreamGate) => {
    resolveGate = resolveStreamGate;
  });

  const flush = async () => {
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (!controller) return;
    try {
      await controller.setContent(renderForStream(latest, progress).text);
    } catch (err) {
      streamError = err;
      logger.warn('stream.update_failed', {
        message: err.message,
        code: err?.code,
        status: err?.response?.status,
        feishuCode: err?.response?.data?.code,
      });
    }
  };

  const schedule = () => {
    if (!controller || updateTimer) return;
    updateTimer = setTimeout(() => {
      updateTimer = null;
      void flush();
    }, 400);
  };

  const streamPromise = (async () => {
    if (config.replyMode !== 'stream') {
      await gate;
      return null;
    }
    try {
      return await channel.stream(
        msg.chatId,
        {
          markdown: async (ctrl) => {
            controller = ctrl;
            await flush();
            await gate;
            await flush();
          },
        },
        { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) },
      );
    } catch (err) {
      streamError = err;
      logger.warn('stream.failed', {
        message: err.message,
        code: err?.code,
        status: err?.response?.status,
        feishuCode: err?.response?.data?.code,
      });
      await gate;
      return null;
    }
  })();

  return {
    onAnswer(answer) {
      latest = clipAnswer(answer);
      schedule();
    },
    onTool(tool) {
      const next = appendProgress(progress, tool?.command);
      if (!next.summary || next.summary === lastTool) return;
      lastTool = next.summary;
      progress = next.progress;
      schedule();
    },
    async finalize(result, { stale = false } = {}) {
      const prefix = stale ? '（旧会话已失效，已自动开始新会话。）\n\n' : '';
      const finalText =
        prefix +
        (result.ok
          ? latest || '已完成，但没有返回文本。'
          : result.cancelled
            ? '已停止。'
            : `执行失败：${result.error || '未知错误'}`);
      latest = finalText;
      progress = '';
      resolveGate();
      await flush();
      await streamPromise.catch(() => null);

      const updateFailed = streamUpdateFailures > failuresBefore;
      const streamedOk =
        config.replyMode === 'stream' && !streamError && !updateFailed;
      const overflow = finalText.length > STREAM_MAX;
      if (!streamedOk) {
        await sendLong(msg, finalText);
      } else if (overflow) {
        await sendLong(msg, finalText.slice(STREAM_MAX));
      }
      return { streamed: streamedOk, overflow, updateFailed };
    },
  };
}

async function beginTurn(msg, text) {
  const current = ensureMainSession();
  const cwd = current.cwd || config.defaultCwd;
  if (!isCwdAllowed(config, cwd)) {
    throw new Error(`cwd not allowed: ${cwd}`);
  }

  let threadId = current.threadId || null;
  let stale = false;
  try {
    const ensured = await runner.ensureThread({
      threadId,
      cwd,
      sandbox: config.sandbox,
      model: config.model,
    });
    threadId = ensured.threadId;
    if (current.threadId !== threadId) {
      sessions.setSession(SCOPE, { threadId, cwd });
      logger.info('session.thread', { threadId });
    }
  } catch (err) {
    if (threadId && /no rollout found/i.test(err.message)) {
      stale = true;
      logger.warn('session.resume_missing', { threadId });
      sessions.clearThread(SCOPE);
      const ensured = await runner.ensureThread({
        threadId: null,
        cwd,
        sandbox: config.sandbox,
        model: config.model,
      });
      threadId = ensured.threadId;
      sessions.setSession(SCOPE, { threadId, cwd });
      logger.info('session.thread', { threadId });
    } else {
      throw err;
    }
  }

  const display = createDisplay(msg);
  const startedAt = Date.now();
  logger.info('run.start', {
    threadId,
    cwd,
    resume: Boolean(current.threadId) && !stale,
    stale,
    sandbox: config.sandbox,
    model: config.model || 'default',
  });

  let turn;
  try {
    turn = await runner.startTurn({
      threadId,
      prompt: text,
      cwd,
      sandbox: config.sandbox,
      model: config.model,
      onAnswer: display.onAnswer,
      onTool: display.onTool,
    });
  } catch (err) {
    await display.finalize({ ok: false, error: err.message });
    err.notified = true;
    throw err;
  }

  const state = {
    threadId,
    turnId: turn.turnId,
    startedAt,
    display,
    done: turn.done,
  };
  active = state;

  turn.done
    .then(async (result) => {
      if (active === state) active = null;
      const delivery = await display.finalize(result, { stale });
      logger.info('run.end', {
        threadId,
        turnId: result.turnId || state.turnId,
        ok: result.ok,
        cancelled: Boolean(result.cancelled),
        durationMs: Date.now() - startedAt,
        answerLen: result.answer.length,
        ...delivery,
      });
    })
    .catch(async (err) => {
      if (active === state) active = null;
      logger.error('run.unhandled', { message: err.message });
      await display.finalize({ ok: false, error: err.message });
    });

  return state;
}

async function settleActive({ interrupt = false } = {}) {
  if (startingTurn) {
    await startingTurn.catch(() => {});
  }
  const state = active;
  if (!state) return null;
  if (interrupt) {
    await runner.interrupt({
      threadId: state.threadId,
      turnId: state.turnId,
    });
    // Wait for turn/completed so the backend accepts the next turn on this thread.
    await Promise.race([state.done.catch(() => {}), sleep(5000)]);
  }
  if (active === state) active = null;
  return state;
}

async function steerActive(msg, text) {
  const state = active;
  try {
    await runner.steer({
      threadId: state.threadId,
      turnId: state.turnId,
      prompt: text,
    });
    logger.info('turn.steer', {
      threadId: state.threadId,
      turnId: state.turnId,
      len: text.length,
    });
    return true;
  } catch (err) {
    logger.warn('turn.steer_failed', {
      message: err.message,
      threadId: state.threadId,
      turnId: state.turnId,
    });
    if (active === state) {
      try {
        await state.done;
      } catch {
        // the display already reports the turn failure
      }
    }
    return false;
  }
}

function isOwnerDm(msg) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.senderIsBot || msg.senderType === 'bot' || msg.senderType === 'app') {
    return false;
  }
  if (msg.chatType !== 'p2p') return false;
  return config.allowedDmUsers.includes(msg.senderId);
}

async function handleCommand(msg, text) {
  const command = text.split(/\s+/)[0].toLowerCase();

  if (
    command === '/help' ||
    (command === 'help' && text.trim().toLowerCase() === 'help')
  ) {
    await safeReply(msg, HELP);
    return true;
  }

  if (command === '/new' || command === '/reset') {
    await settleActive({ interrupt: true });
    sessions.clearThread(SCOPE);
    await safeReply(msg, '已开始新会话。');
    return true;
  }

  if (command === '/stop') {
    if (startingTurn) await startingTurn.catch(() => {});
    if (!active) {
      await safeReply(msg, '当前没有运行中的任务。');
      return true;
    }
    const state = active;
    const stopped = await runner.interrupt({
      threadId: state.threadId,
      turnId: state.turnId,
    });
    await Promise.race([state.done.catch(() => {}), sleep(5000)]);
    if (active === state) active = null;
    await safeReply(
      msg,
      stopped ? '已发送停止信号。' : '停止失败，当前任务可能已经结束。',
    );
    return true;
  }

  if (command === '/status') {
    const current = ensureMainSession();
    const elapsed = active
      ? Math.max(0, Math.round((Date.now() - active.startedAt) / 1000))
      : 0;
    await safeReply(
      msg,
      [
        '**状态**',
        `- thread: ${current.threadId ? `\`${current.threadId}\`` : '新会话'}`,
        `- cwd: \`${current.cwd || config.defaultCwd}\``,
        `- sandbox: \`${config.sandbox}\``,
        `- model: \`${config.model || 'default'}\``,
        `- app-server: ${runner.pid ? `\`pid ${runner.pid}\`` : '未运行'}`,
        `- turn: ${active ? `\`${active.turnId}\`（${elapsed}s）` : '空闲'}`,
      ].join('\n'),
    );
    return true;
  }

  if (command === '/cd') {
    const argument = text.slice(3).trim();
    if (!argument) {
      await safeReply(msg, '用法：`/cd /absolute/path`');
      return true;
    }
    const home = homedir();
    const expanded = argument === '~' ? home : argument.replace(/^~\//, `${home}/`);
    const target = resolve(expanded);
    if (
      !isCwdAllowed(config, target) ||
      !existsSync(target) ||
      !statSync(target).isDirectory()
    ) {
      await safeReply(msg, `目录不可用或不在允许范围内：\`${target}\``);
      return true;
    }
    await settleActive({ interrupt: true });
    sessions.setSession(SCOPE, { cwd: target, threadId: null });
    await safeReply(msg, `已切换到 \`${target}\`，并开始新会话。`);
    return true;
  }

  if (command.startsWith('/')) {
    await safeReply(msg, `未知命令：\`${command}\`\n\n${HELP}`);
    return true;
  }

  return false;
}

async function onMessage(msg) {
  try {
    if (shuttingDown) return;
    if (!isOwnerDm(msg)) {
      logger.warn('message.ignored', {
        chatId: msg.chatId,
        senderId: msg.senderId,
        chatType: msg.chatType,
      });
      return;
    }

    const text = (msg.content || '').trim();
    logger.info('message.in', {
      chatType: msg.chatType,
      senderId: msg.senderId,
      len: text.length,
    });

    if (await handleCommand(msg, text)) return;

    if (!text) {
      await safeReply(msg, `请发送具体内容。\n\n${HELP}`);
      return;
    }

    if (startingTurn) {
      await startingTurn.catch(() => {});
    }

    if (active) {
      const steered = await steerActive(msg, text);
      if (steered) return;
    }

    startingTurn = beginTurn(msg, text);
    try {
      await startingTurn;
    } finally {
      startingTurn = null;
    }
  } catch (err) {
    logger.error('message.handler_failed', { message: err.message });
    if (!err.notified) await safeReply(msg, `处理消息失败：${err.message}`);
  }
}

channel.on({
  message: onMessage,
  reject: (event) =>
    logger.warn('message.policy_reject', {
      chatId: event.chatId,
      senderId: event.senderId,
      reason: event.reason,
    }),
  error: (err) =>
    logger.error('channel.error', {
      message: err?.message || String(err),
      code: err?.code,
    }),
  reconnecting: () => logger.warn('channel.reconnecting', {}),
  reconnected: () => logger.info('channel.reconnected', {}),
});

let shutdownStarted = false;

async function shutdown(signal, exitCode = 0) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  shuttingDown = true;
  logger.info('bot.shutdown', { signal, exitCode });

  if (startingTurn) await startingTurn.catch(() => {});
  await settleActive({ interrupt: true });
  await sessions.flush();
  await runner.close();

  try {
    await Promise.race([channel.disconnect(), sleep(5000)]);
  } catch (err) {
    logger.warn('channel.disconnect_failed', { message: err.message });
  }
  lock.release();
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('unhandled_rejection', {
    message: err instanceof Error ? err.message : String(err),
  });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaught_exception', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});

if (process.env.BOT_TEST_GC === '1') {
  process.on('SIGUSR1', () => {
    global.gc?.();
  });
}

logger.info('bot.starting', {
  appId: config.appId,
  sandbox: config.sandbox,
  replyMode: config.replyMode,
  cwd: config.defaultCwd,
  mode: 'single-thread',
  allowedUsers: config.allowedDmUsers.length,
});

try {
  await channel.connect();
  const identity = await channel.getBotIdentity?.();
  const status = await channel.getConnectionStatus?.();
  logger.info('bot.connected', {
    botName: identity?.name,
    botOpenId: identity?.openId,
    status: status?.state,
  });
  const watchdog = setInterval(() => {
    const current = channel.getConnectionStatus?.();
    if (current?.state === 'failed') {
      logger.error('channel.failed', { state: current.state });
      void shutdown('channel_failed', 1);
    }
  }, 30000);
  watchdog.unref?.();
} catch (err) {
  logger.error('bot.connect_failed', { message: err.message, code: err.code });
  lock.release();
  process.exit(1);
}
