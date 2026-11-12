import { createAppServer } from './app-server.mjs';
import { logger as defaultLogger } from './log.mjs';

const TOOL_OUTPUT_MAX = 4096;
const MAX_ANSWER_BUFFER = 200_000;
const DEFAULT_APPSERVER_ARGS = [
  'app-server',
  '--listen',
  'stdio://',
  '-c',
  'shell_environment_policy.inherit="all"',
];
const DEFAULT_DEVELOPER_INSTRUCTIONS = [
  'You are accessed through a chat bridge.',
  'Long-running commands (builds, tests, downloads, remote experiments) MUST be started',
  'in a detached tmux session and the turn must return promptly with the session name',
  'and log path. Never block the turn waiting for long-running work.',
].join(' ');

function clip(value, max) {
  if (typeof value !== 'string') return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n…[truncated]`;
}

function mergeAnswer(current, text) {
  if (typeof text !== 'string' || !text) return current;
  if (!current) return text;
  if (text === current || current.endsWith(text)) return current;
  if (text.startsWith(current)) return text;
  return `${current}\n\n${text}`;
}

function turnError(turn) {
  if (!turn || !turn.error) return '';
  if (typeof turn.error === 'string') return turn.error;
  return turn.error.message || '';
}

export function createCodexRunner({
  codexBin,
  logger = defaultLogger,
  env = {},
  appServerArgs = DEFAULT_APPSERVER_ARGS,
  developerInstructions = DEFAULT_DEVELOPER_INSTRUCTIONS,
  clientInfo = { name: 'agent-courier', title: 'Agent Courier', version: '0.2.0' },
}) {
  let server = null;
  let starting = null;
  const activeByThread = new Map();
  const loadedThreads = new Set();
  const unknownEvents = new Set();

  function finish(ctx, result) {
    if (ctx.finished) return;
    ctx.finished = true;
    activeByThread.delete(ctx.threadId);
    ctx.resolve({
      ok: Boolean(result.ok),
      threadId: ctx.threadId,
      turnId: ctx.turnId,
      answer: ctx.answer,
      error: result.error || null,
      cancelled: Boolean(result.cancelled),
      unknownEventTypes: [...unknownEvents],
    });
  }

  function handleTerminal(ctx, turn) {
    const status = turn?.status;
    if (status === 'inProgress') return;
    if (status === 'completed') {
      finish(ctx, { ok: true });
      return;
    }
    if (status === 'interrupted') {
      finish(ctx, { ok: false, cancelled: true, error: '已停止' });
      return;
    }
    finish(ctx, {
      ok: false,
      error: turnError(turn) || ctx.lastError || 'codex turn failed',
    });
  }

  function handleNotification(method, params) {
    if (method === 'exit') {
      const error = params?.error || 'app-server exited';
      logger.error?.('appserver.exited', { error });
      server = null;
      loadedThreads.clear();
      for (const ctx of [...activeByThread.values()]) {
        finish(ctx, { ok: false, error });
      }
      return;
    }

    const threadId = params?.threadId;
    if (!threadId) return;
    const ctx = activeByThread.get(threadId);
    if (!ctx) return;

    switch (method) {
      case 'turn/started': {
        if (!ctx.turnId && params.turn?.id) ctx.turnId = params.turn.id;
        break;
      }
      case 'item/agentMessage/delta': {
        if (typeof params.delta === 'string' && params.delta) {
          ctx.answer = `${ctx.answer}${params.delta}`.slice(-MAX_ANSWER_BUFFER);
          ctx.onAnswer?.(ctx.answer);
        }
        break;
      }
      case 'item/started': {
        const item = params.item;
        if (item?.type === 'commandExecution' && item.command) {
          ctx.onTool?.({ command: item.command, phase: 'started' });
        }
        break;
      }
      case 'item/completed': {
        const item = params.item;
        if (!item || typeof item !== 'object') break;
        if (item.type === 'agentMessage' && typeof item.text === 'string' && item.text) {
          ctx.answer = mergeAnswer(ctx.answer, item.text).slice(-MAX_ANSWER_BUFFER);
          ctx.onAnswer?.(ctx.answer);
        } else if (item.type === 'commandExecution') {
          ctx.onTool?.({
            command: item.command || '',
            output: clip(item.aggregatedOutput, TOOL_OUTPUT_MAX),
            exitCode: item.exitCode,
            phase: 'completed',
          });
        }
        break;
      }
      case 'error': {
        const message =
          params.error?.message || params.message || 'codex turn error';
        ctx.lastError = message;
        logger.warn?.('appserver.turn_error', {
          message: message.slice(0, 300),
          willRetry: Boolean(params.willRetry),
        });
        break;
      }
      case 'turn/completed': {
        handleTerminal(ctx, params.turn);
        break;
      }
      case 'thread/started':
      case 'thread/status/changed':
      case 'thread/goal/cleared':
      case 'thread/goal/updated':
      case 'turn/plan/updated':
      case 'turn/diff/updated':
      case 'thread/tokenUsage/updated':
      case 'item/reasoning/textDelta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/summaryPartAdded':
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta':
      case 'item/fileChange/patchUpdated':
      case 'item/mcpToolCall/progress':
      case 'hook/started':
      case 'hook/completed':
      case 'mcpServer/startupStatus/updated':
      case 'account/rateLimits/updated':
      case 'remoteControl/status/changed':
      case 'configWarning':
        break;
      default: {
        if (!unknownEvents.has(method)) {
          unknownEvents.add(method);
          logger.warn?.('appserver.unknown_event', { method });
        }
        break;
      }
    }
  }

  async function ensureServer() {
    if (server?.alive) return server;
    if (starting) return starting;
    starting = (async () => {
      const client = createAppServer({
        command: codexBin,
        args: appServerArgs,
        cwd: process.cwd(),
        env,
        logger,
        clientInfo,
      });
      client.onNotification(handleNotification);
      try {
        await client.start();
        server = client;
        return client;
      } catch (err) {
        await client.stop().catch(() => {});
        throw err;
      }
    })().finally(() => {
      starting = null;
    });
    return starting;
  }

  async function start() {
    const client = await ensureServer();
    return { pid: client.pid, alive: client.alive };
  }

  async function ensureThread({ threadId, cwd, sandbox, model }) {
    const client = await ensureServer();
    const params = {
      cwd,
      approvalPolicy: 'never',
      sandbox,
      ...(model ? { model } : {}),
      ...(developerInstructions ? { developerInstructions } : {}),
    };

    if (threadId) {
      if (loadedThreads.has(threadId)) {
        return { threadId, resumed: true };
      }
      try {
        await client.request('thread/resume', { threadId, ...params });
        loadedThreads.add(threadId);
        return { threadId, resumed: true };
      } catch (err) {
        const error = new Error(err.message);
        error.code = 'THREAD_RESUME_FAILED';
        throw error;
      }
    }

    const response = await client.request('thread/start', {
      ...params,
      ephemeral: false,
    });
    const id = response?.thread?.id;
    if (!id) throw new Error('thread/start returned no thread id');
    loadedThreads.add(id);
    logger.info?.('appserver.thread', { threadId: id, cwd });
    return { threadId: id, resumed: false };
  }

  async function startTurn({
    threadId,
    prompt,
    cwd,
    sandbox,
    model,
    onAnswer,
    onTool,
  }) {
    if (activeByThread.has(threadId)) {
      const error = new Error(`thread already has an active turn: ${threadId}`);
      error.code = 'TURN_ACTIVE';
      throw error;
    }

    const client = await ensureServer();
    let resolveRun;
    const done = new Promise((resolve) => {
      resolveRun = resolve;
    });
    const ctx = {
      threadId,
      turnId: null,
      answer: '',
      lastError: '',
      finished: false,
      onAnswer,
      onTool,
      resolve: resolveRun,
    };
    activeByThread.set(threadId, ctx);

    try {
      const response = await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
      });
      if (!ctx.turnId) ctx.turnId = response?.turn?.id || null;
    } catch (err) {
      finish(ctx, {
        ok: false,
        error: `failed to start codex turn: ${err.message}`,
      });
    }

    return { threadId, turnId: ctx.turnId, done };
  }

  async function steer({ threadId, turnId, prompt }) {
    const client = await ensureServer();
    return client.request('turn/steer', {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
  }

  async function interrupt({ threadId, turnId }) {
    if (!threadId || !turnId) return false;
    const client = await ensureServer();
    try {
      await client.request(
        'turn/interrupt',
        { threadId, turnId },
        { timeoutMs: 5000 },
      );
      return true;
    } catch (err) {
      logger.warn?.('appserver.interrupt_failed', { message: err.message });
      return false;
    }
  }

  function activeTurn(threadId) {
    const ctx = activeByThread.get(threadId);
    return ctx ? { threadId: ctx.threadId, turnId: ctx.turnId } : null;
  }

  async function close() {
    for (const ctx of [...activeByThread.values()]) {
      finish(ctx, { ok: false, error: 'app-server is shutting down' });
    }
    const client = server;
    server = null;
    loadedThreads.clear();
    if (client) await client.stop().catch(() => {});
  }

  return {
    start,
    ensureThread,
    startTurn,
    steer,
    interrupt,
    activeTurn,
    close,
    get pid() {
      return server?.pid ?? 0;
    },
  };
}
