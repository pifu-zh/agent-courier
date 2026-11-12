#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const logPath = process.env.MOCK_CODEX_LOG;
const mode = process.env.MOCK_CODEX_MODE || 'ok';
const fixedThreadId = process.env.MOCK_CODEX_THREAD_ID;
const hasSecret = Boolean(process.env.LARK_APP_SECRET);
let threadSequence = 0;
let turnSequence = 0;
const turns = new Map();
const resumedThreads = new Set();

function record(entry) {
  if (!logPath) return;
  try {
    appendFileSync(
      logPath,
      `${JSON.stringify({ ts: Date.now(), pid: process.pid, ...entry })}\n`,
    );
  } catch {
    // test logging must never break the mock
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ method, params });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function newThreadId() {
  threadSequence += 1;
  if (!fixedThreadId) return `mock-thread-${threadSequence}`;
  return threadSequence === 1 ? fixedThreadId : `${fixedThreadId}-${threadSequence}`;
}

function answerText(prompt) {
  if (process.env.MOCK_CODEX_MULTI_MESSAGES === '1') return null;
  let answer = process.env.MOCK_CODEX_ANSWER ?? 'MOCK_OK';
  const bytes = Number(process.env.MOCK_CODEX_ANSWER_BYTES || 0);
  if (bytes > 0) answer = 'A'.repeat(bytes);
  if (process.env.MOCK_CODEX_ECHO === '1') answer = `OK: ${prompt}`;
  return answer;
}

function emitAgentMessage(threadId, turnId, text) {
  const item = {
    type: 'agentMessage',
    id: `item_msg_${turnSequence}`,
    text,
    phase: null,
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  notify('item/started', { threadId, turnId, item: { ...item, text: '' }, startedAtMs: Date.now() });
  notify('item/completed', {
    threadId,
    turnId,
    item,
    completedAtMs: Date.now(),
  });
}

function emitDeltas(threadId, turnId, text) {
  const chunk = 64;
  for (let offset = 0; offset < text.length; offset += chunk) {
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: `item_msg_${turnSequence}`,
      delta: text.slice(offset, offset + chunk),
    });
  }
}

function completeTurn(threadId, turnId, status, error) {
  const state = turns.get(turnId);
  if (!state || state.done) return;
  state.done = true;
  clearTimeout(state.timer);
  notify('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      rootTurnId: turnId,
      items: [],
      itemsView: 'notLoaded',
      status,
      error: error ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null,
      startedAt: state.startedAt,
      completedAt: Math.floor(Date.now() / 1000),
      durationMs: Date.now() - state.startedAtMs,
    },
  });
  record({ type: 'end', threadId, turnId, status, code: status === 'completed' ? 0 : 143 });
  if (process.env.MOCK_CODEX_AFTER_TERMINAL === '1' && status === 'completed') {
    notify('item/agentMessage/delta', {
      threadId,
      turnId,
      itemId: 'late',
      delta: 'LATE MESSAGE',
    });
  }
  if (process.env.MOCK_CODEX_EXIT_AFTER_TERMINAL) {
    process.exit(Number(process.env.MOCK_CODEX_EXIT_AFTER_TERMINAL));
  }
}

async function runTurn({ threadId, turnId, prompt }) {
  const state = turns.get(turnId);
  if (!state) return;

  const sleepMatch = prompt.match(/\[\[sleep=(\d+)\]\]/);
  const sleepMs = sleepMatch
    ? Number(sleepMatch[1])
    : Number(process.env.MOCK_CODEX_SLEEP_MS || 0);
  if (sleepMs > 0) {
    await sleep(sleepMs);
    if (state.done) return;
  }

  if (mode === 'hang') {
    return;
  }

  if (process.env.MOCK_CODEX_GARBAGE === '1') {
    process.stdout.write('this is not json\n\n');
  }

  const eventCount = Number(process.env.MOCK_CODEX_EVENTS || 0);
  const toolBytes = Number(process.env.MOCK_CODEX_TOOL_BYTES || 0);
  const eventDelayMs = Number(process.env.MOCK_CODEX_EVENT_DELAY_MS || 0);
  for (let index = 0; index < eventCount; index += 1) {
    if (state.done) return;
    const id = `item_${index}`;
    const command = `echo event-${index}`;
    notify('item/started', {
      threadId,
      turnId,
      item: {
        type: 'commandExecution',
        id,
        command,
        status: 'inProgress',
        aggregatedOutput: null,
        exitCode: null,
      },
      startedAtMs: Date.now(),
    });
    notify('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'commandExecution',
        id,
        command,
        status: 'completed',
        aggregatedOutput: 'X'.repeat(toolBytes),
        exitCode: 0,
        durationMs: 1,
      },
      completedAtMs: Date.now(),
    });
    if (eventDelayMs > 0) await sleep(eventDelayMs);
  }

  if (process.env.MOCK_CODEX_UNKNOWN_EVENT === '1') {
    notify('future.event', { threadId, turnId, payload: { ignored: true } });
  }

  const failTurn = mode === 'fail_turn' || process.env.MOCK_CODEX_FAIL_TURN === '1';
  if (failTurn) {
    completeTurn(
      threadId,
      turnId,
      'failed',
      process.env.MOCK_CODEX_FAIL_MESSAGE || 'mock turn failed',
    );
    return;
  }

  if (process.env.MOCK_CODEX_HUGE_LINE_BYTES) {
    const bytes = Number(process.env.MOCK_CODEX_HUGE_LINE_BYTES);
    completeTurn(threadId, turnId, 'completed', null);
    notify('item/completed', {
      threadId,
      turnId,
      item: { type: 'agentMessage', id: 'huge', text: 'A'.repeat(bytes) },
      completedAtMs: Date.now(),
    });
    return;
  }

  if (process.env.MOCK_CODEX_MULTI_MESSAGES === '1') {
    emitAgentMessage(threadId, turnId, 'first message');
    emitAgentMessage(threadId, turnId, 'second message');
  } else {
    const steered = state.steered || [];
    const answer =
      answerText(prompt) +
      (steered.length ? `\nSTEERED:${steered.join('|')}` : '');
    emitDeltas(threadId, turnId, answer);
    emitAgentMessage(threadId, turnId, answer);
  }

  if (mode === 'no_terminal') {
    return;
  }

  completeTurn(threadId, turnId, 'completed', null);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message.method !== 'string') return;
  const { id, method, params = {} } = message;

  if (method === 'initialize') {
    send({
      id,
      result: {
        userAgent: 'mock-app-server/0.1.0',
        codexHome: '/tmp/mock-codex-home',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    return;
  }

  if (method === 'thread/start') {
    const threadId = newThreadId();
    record({ type: 'thread', action: 'start', threadId });
    send({
      id,
      result: {
        thread: {
          id: threadId,
          status: { type: 'idle' },
          cwd: params.cwd,
          source: 'mock',
        },
      },
    });
    return;
  }

  if (method === 'thread/resume') {
    const threadId = params.threadId;
    if (mode === 'missing_thread') {
      record({
        type: 'start',
        cwd: params.cwd,
        resume: true,
        threadArg: threadId,
        threadId,
        hasSecret,
      });
      send({
        id,
        error: {
          code: -32600,
          message: `thread/resume failed: no rollout found for thread id ${threadId}`,
        },
      });
      return;
    }
    send({
      id,
      result: {
        thread: {
          id: threadId,
          status: { type: 'idle' },
          cwd: params.cwd,
          source: 'mock',
        },
      },
    });
    resumedThreads.add(threadId);
    record({ type: 'thread', action: 'resume', threadId });
    return;
  }

  if (method === 'turn/start') {
    const threadId = params.threadId;
    const resume = resumedThreads.has(threadId);
    turnSequence += 1;
    const turnId = `mock-turn-${turnSequence}`;
    const prompt = params.input?.find((input) => input.type === 'text')?.text || '';
    const startedAtMs = Date.now();
    const state = {
      done: false,
      startedAt: Math.floor(startedAtMs / 1000),
      startedAtMs,
      timer: null,
    };
    turns.set(turnId, state);
    record({
      type: 'start',
      cwd: params.cwd,
      resume,
      threadArg: resume ? threadId : null,
      threadId,
      hasSecret,
    });
    record({ type: 'prompt', prompt, threadId, turnId });
    send({
      id,
      result: {
        turn: {
          id: turnId,
          rootTurnId: turnId,
          items: [],
          itemsView: 'notLoaded',
          status: 'inProgress',
          error: null,
          startedAt: state.startedAt,
          completedAt: null,
          durationMs: null,
        },
      },
    });
    notify('turn/started', {
      threadId,
      turn: {
        id: turnId,
        rootTurnId: turnId,
        items: [],
        itemsView: 'notLoaded',
        status: 'inProgress',
        error: null,
        startedAt: state.startedAt,
        completedAt: null,
        durationMs: null,
      },
    });
    void runTurn({ threadId, turnId, prompt });
    return;
  }

  if (method === 'turn/steer') {
    const state = turns.get(params.expectedTurnId);
    const prompt = params.input?.find((input) => input.type === 'text')?.text || '';
    if (!state || state.done) {
      send({
        id,
        error: {
          code: -32600,
          message: `turn/steer failed: turn ${params.expectedTurnId} is not active`,
        },
      });
      return;
    }
    record({ type: 'steer', prompt, threadId: params.threadId, turnId: params.expectedTurnId });
    state.steered = [...(state.steered || []), prompt];
    send({ id, result: { turnId: params.expectedTurnId } });
    return;
  }

  if (method === 'turn/interrupt') {
    record({ type: 'signal', signal: 'interrupt', threadId: params.threadId, turnId: params.turnId });
    const state = turns.get(params.turnId);
    if (state) {
      completeTurn(params.threadId, params.turnId, 'interrupted', null);
    }
    send({ id, result: {} });
    return;
  }

  send({ id, error: { code: -32601, message: `unknown method: ${method}` } });
});

process.on('SIGTERM', () => {
  process.exit(0);
});
