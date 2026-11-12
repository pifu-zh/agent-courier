import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLarkChannel } from '@larksuite/channel';
import { loadConfig, isCwdAllowed } from './config.mjs';
import { logger } from './log.mjs';
import { createSessionStore } from './sessions.mjs';
import { runCodex } from './codex.mjs';
import { scopeOf, isAllowed } from './policy.mjs';
import { clipAnswer, renderForStream, appendProgress, STREAM_MAX, DELIVERY_MAX, DELIVERY_CHUNK } from './format.mjs';
import { createRunQueue } from './run-queue.mjs';
import { acquireLock } from './lock.mjs';
import { BoundedCache } from './cache.mjs';

const MAX_QUEUE_PER_SCOPE = 20;
const config = loadConfig();
const lock = acquireLock(join(config.rootDir, 'bot.lock'), { logger });
if (!lock) process.exit(1);
const sessions = createSessionStore({
  file: config.sessionsFile,
  seedSessions: config.seedSessions,
  defaultCwd: config.defaultCwd,
  logger,
});

const HELP = [
  '**Codex bot 命令**',
  '- `/new` 或 `/reset`：开始新会话',
  '- `/stop`：停止当前任务',
  '- `/status`：查看 thread / cwd / 队列状态',
  '- `/cd <绝对路径>`：切换工作目录并开始新会话',
  '- `/help`：显示本帮助',
  '',
  '直接发消息即可让 Codex 执行任务。',
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
    groupAllowlist: config.allowedChats,
    requireMention: config.requireMention,
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

const queue = createRunQueue({
  maxConcurrent: config.maxConcurrentRuns,
  maxQueuePerScope: MAX_QUEUE_PER_SCOPE,
  execute: executeRun,
  logger,
});

const sessionEpochs = new Map();

function currentEpoch(scope) {
  return sessionEpochs.get(scope) || 0;
}

function bumpEpoch(scope) {
  sessionEpochs.set(scope, currentEpoch(scope) + 1);
}

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
      const details = {
        attempt,
        message: err?.message || String(err),
        code: err?.code,
        status: err?.response?.status,
        feishuCode: err?.response?.data?.code,
      };
      logger.warn('reply.chunk_failed', details);
      if (attempt === 2 || !isRetryableSendError(err)) return null;
      await sleep(250 * (attempt + 1));
    }
  }
  return null;
}

async function safeReply(msg, markdown) {
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

async function runWithReply(scope, msg, text, signal, startedAt, epoch) {
  const session = sessions.getSession(scope) || {
    threadId: null,
    cwd: config.defaultCwd,
  };
  const cwd = session.cwd || config.defaultCwd;
  if (!isCwdAllowed(config, cwd)) {
    throw new Error(`cwd not allowed: ${cwd}`);
  }

  let latest = '';
  let progress = '';
  let lastTool = '';
  let controller = null;
  let streamError = null;
  let updateTimer = null;
  const failuresBefore = streamUpdateFailures;
  let resolveRun;
  const runGate = new Promise((resolveGate) => {
    resolveRun = resolveGate;
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
        scope,
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
      await runGate;
      return null;
    }
    try {
      return await channel.stream(
        msg.chatId,
        {
          markdown: async (ctrl) => {
            controller = ctrl;
            await flush();
            await runGate;
            await flush();
          },
        },
        { replyTo: msg.messageId, replyInThread: Boolean(msg.threadId) },
      );
    } catch (err) {
      streamError = err;
      logger.warn('stream.failed', {
        scope,
        message: err.message,
        code: err?.code,
        status: err?.response?.status,
        feishuCode: err?.response?.data?.code,
      });
      await runGate;
      return null;
    }
  })();

  logger.info('run.start', {
    scope,
    cwd,
    resume: Boolean(session.threadId),
    sandbox: config.sandbox,
    model: config.model || 'default',
  });

  const invoke = (threadId) =>
    runCodex({
      prompt: text,
      cwd,
      sandbox: config.sandbox,
      model: config.model,
      threadId,
      codexBin: config.codexBin,
      isolation: config.codexIsolation,
      timeoutMs: config.runTimeoutMs,
      stopGraceMs: config.stopGraceMs,
      signal,
      onThreadId: (threadId) => {
        if (currentEpoch(scope) !== epoch) {
          logger.info('session.thread_ignored', { scope, threadId });
          return;
        }
        sessions.setSession(scope, { threadId, cwd });
        logger.info('session.thread', { scope, threadId });
      },
      onAnswer: (answer) => {
        latest = clipAnswer(answer);
        schedule();
      },
      onTool: (tool) => {
        const next = appendProgress(progress, tool?.command);
        if (!next.summary || next.summary === lastTool) return;
        lastTool = next.summary;
        progress = next.progress;
        schedule();
      },
    });

  let result;
  let staleThread = false;
  try {
    result = await invoke(session.threadId || undefined);
    if (
      !result.ok &&
      !result.cancelled &&
      session.threadId &&
      /no rollout found/i.test(result.error || '')
    ) {
      staleThread = true;
      logger.warn('session.resume_missing', {
        scope,
        threadId: session.threadId,
      });
      sessions.clearThread(scope);
      latest = '';
      progress = '';
      lastTool = '';
      schedule();
      result = await invoke(undefined);
    }
  } catch (err) {
    result = {
      ok: false,
      answer: latest,
      threadId: session.threadId,
      exitCode: -1,
      error: err.message,
    };
  }

  const prefix = staleThread ? '（旧会话已失效，已自动开始新会话。）\n\n' : '';
  const finalText =
    prefix +
    (result.ok
      ? latest || '已完成，但没有返回文本。'
      : result.cancelled
        ? '已停止。'
        : `执行失败：${result.error || '未知错误'}`);

  latest = finalText;
  progress = '';
  resolveRun();
  await flush();
  await streamPromise.catch(() => null);

  const updateFailed = streamUpdateFailures > failuresBefore;
  const streamedOk = config.replyMode === 'stream' && !streamError && !updateFailed;
  const overflow = finalText.length > STREAM_MAX;
  if (!streamedOk) {
    await sendLong(msg, finalText);
  } else if (overflow) {
    await sendLong(msg, finalText.slice(STREAM_MAX));
  }

  logger.info('run.end', {
    scope,
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    answerLen: finalText.length,
    streamed: streamedOk,
    overflow,
    streamUpdateFailed: updateFailed,
  });
}

async function executeRun(scope, item, signal) {
  const { msg, text } = item;
  if (Date.now() - item.createdAt > config.queueTtlMs) {
    logger.warn('run.expired', { scope, ageMs: Date.now() - item.createdAt });
    await safeReply(msg, '任务已过期，请重新发送。');
    return;
  }
  if (!isAllowed(config, msg)) {
    logger.warn('run.not_allowed', { scope, senderId: msg.senderId });
    await safeReply(msg, '权限已变更，任务未执行。');
    return;
  }
  const startedAt = Date.now();
  const epoch = currentEpoch(scope);
  let settled = false;
  let removed = false;
  const removeReactionOnce = (reactionId) => {
    if (!reactionId || removed) return;
    removed = true;
    void channel.removeReaction(msg.messageId, reactionId).catch(() => {});
  };
  const reactionPromise = Promise.resolve()
    .then(() => channel.addReaction(msg.messageId, 'Typing'))
    .catch(() => undefined);
  reactionPromise.then((reactionId) => {
    if (settled) removeReactionOnce(reactionId);
  });

  try {
    await runWithReply(scope, msg, text, signal, startedAt, epoch);
  } catch (err) {
    logger.error('run.unhandled', { scope, message: err.message });
    await safeReply(msg, `执行失败：${err.message}`);
  } finally {
    settled = true;
    let reactionId;
    try {
      reactionId = await Promise.race([
        reactionPromise,
        new Promise((resolveTimeout) => {
          const timer = setTimeout(() => resolveTimeout(undefined), 2000);
          timer.unref?.();
        }),
      ]);
    } catch {
      reactionId = undefined;
    }
    removeReactionOnce(reactionId);
  }
}

async function handleCommand(msg, text, scope) {
  const command = text.split(/\s+/)[0].toLowerCase();

  if (
    command === '/help' ||
    (command === 'help' && text.trim().toLowerCase() === 'help')
  ) {
    await safeReply(msg, HELP);
    return true;
  }

  if (command === '/new' || command === '/reset') {
    queue.abort(scope);
    bumpEpoch(scope);
    sessions.clearThread(scope);
    await safeReply(msg, '已开始新会话。');
    return true;
  }

  if (command === '/stop') {
    const stopped = queue.abort(scope);
    if (!stopped) {
      await safeReply(msg, '当前没有运行中的任务。');
      return true;
    }
    await safeReply(msg, '已发送停止信号。');
    return true;
  }

  if (command === '/status') {
    const session = sessions.getSession(scope) || {};
    const state = queue.getState(scope);
    await safeReply(
      msg,
      [
        '**状态**',
        `- thread: ${session.threadId ? `\`${session.threadId}\`` : '新会话'}`,
        `- cwd: \`${session.cwd || config.defaultCwd}\``,
        `- sandbox: \`${config.sandbox}\``,
        `- model: \`${config.model || 'default'}\``,
        `- running: ${state.running ? '是' : '否'}`,
        `- waiting: ${state.waiting ? '是' : '否'}`,
        `- queued: ${state.queued}`,
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
    queue.abort(scope);
    bumpEpoch(scope);
    sessions.setSession(scope, { cwd: target, threadId: null });
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
  const scope = scopeOf(msg);
  try {
    if (shuttingDown) return;
    if (!isAllowed(config, msg)) {
      logger.warn('message.not_allowed', {
        chatId: msg.chatId,
        senderId: msg.senderId,
        chatType: msg.chatType,
        mentioned: msg.mentionedBot,
      });
      return;
    }

    const text = (msg.content || '').trim();
    logger.info('message.in', {
      scope,
      chatType: msg.chatType,
      senderId: msg.senderId,
      len: text.length,
      mentioned: msg.mentionedBot,
    });

    if (await handleCommand(msg, text, scope)) return;

    if (!text) {
      await safeReply(msg, `请发送具体任务。\n\n${HELP}`);
      return;
    }

    const result = queue.enqueue(scope, { msg, text, createdAt: Date.now() });
    if (!result.accepted) {
      await safeReply(
        msg,
        result.reason === 'full'
          ? '队列已满，请等当前任务结束后再发。'
          : '机器人正在关闭，暂时不能执行任务。',
      );
      return;
    }
    if (result.queued && result.depth === 1) {
      await safeReply(msg, '已排队，当前任务结束后会继续处理。');
    }
  } catch (err) {
    logger.error('message.handler_failed', { scope, message: err.message });
    await safeReply(msg, `处理消息失败：${err.message}`);
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

  queue.shutdown();
  const idle = await queue.waitForIdle(config.stopGraceMs + 1000);
  if (!idle) {
    logger.error('bot.shutdown_incomplete', {
      signal,
      stopGraceMs: config.stopGraceMs,
    });
  }
  await sessions.flush();

  try {
    await Promise.race([
      channel.disconnect(),
      sleep(5000),
    ]);
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
  maxConcurrentRuns: config.maxConcurrentRuns,
  requireMention: config.requireMention,
  allowedUsers: config.allowedDmUsers.length,
  allowedChats: config.allowedChats.length,
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
  process.exit(1);
}
