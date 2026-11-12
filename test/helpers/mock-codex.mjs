#!/usr/bin/env node
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const logPath = process.env.MOCK_CODEX_LOG;

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

function emit(event) {
  return new Promise((resolve) => {
    process.stdout.write(`${JSON.stringify(event)}\n`, resolve);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const resumeIndex = args.indexOf('resume');
const resume = resumeIndex !== -1;
let threadArg = null;
if (resume) {
  const rest = args.slice(resumeIndex + 1).filter((arg) => !arg.startsWith('-'));
  threadArg = rest[0] || null;
}

const newThread =
  process.env.MOCK_CODEX_THREAD_ID ||
  `01a1ce4f-${Date.now().toString(16)}-7000-8000-${String(process.pid).padStart(12, '0')}`;
const threadId = resume ? threadArg : newThread;
const mode = process.env.MOCK_CODEX_MODE || 'ok';
const stderrBytes = Number(process.env.MOCK_CODEX_STDERR_BYTES || 0);

record({
  type: 'start',
  args,
  resume,
  threadArg,
  threadId,
  cwd: process.cwd(),
  hasSecret: Boolean(process.env.LARK_APP_SECRET),
});

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
const promptReady = new Promise((resolve) => {
  process.stdin.on('end', () => resolve(prompt));
});

function onSignal(signal) {
  record({ type: 'signal', signal });
  if (signal === 'SIGTERM' && process.env.MOCK_CODEX_IGNORE_SIGTERM === '1') {
    return;
  }
  process.exit(143);
}

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('exit', (code) => record({ type: 'end', code, at: Date.now() }));

if (mode === 'missing_thread' && resume) {
  process.stderr.write(
    `Error: thread/resume: thread/resume failed: no rollout found for thread id ${threadArg} (code -32600)\n`,
  );
  record({ type: 'missing_thread' });
  process.exit(1);
}

if (mode === 'exit') {
  process.exit(Number(process.env.MOCK_CODEX_EXIT_CODE || 1));
}

if (mode === 'stderr_fail') {
  process.stderr.write('F'.repeat(stderrBytes || 10000));
  process.exit(Number(process.env.MOCK_CODEX_EXIT_CODE || 1));
}

if (mode === 'hang') {
  record({ type: 'hang' });
  setInterval(() => {}, 1 << 30);
  await new Promise(() => {});
}

await promptReady;
record({ type: 'prompt', prompt });

const probePath = process.env.MOCK_CODEX_READ_PATH;
if (probePath) {
  let readable = false;
  let content = '';
  try {
    content = readFileSync(probePath, 'utf8');
    readable = true;
  } catch {
    // path is hidden or missing
  }
  let entries = null;
  if (process.env.MOCK_CODEX_LIST_PATH) {
    try {
      entries = readdirSync(process.env.MOCK_CODEX_LIST_PATH).length;
    } catch {
      entries = -1;
    }
  }
  await emit({ type: 'thread.started', thread_id: threadId });
  await emit({ type: 'turn.started' });
  await emit({
    type: 'item.completed',
    item: {
      id: 'item_probe',
      type: 'agent_message',
      text: `READABLE=${readable} CONTENT=${content.trim()} ENTRIES=${entries}`,
    },
  });
  await emit({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  process.exit(0);
}

if (mode === 'background_child') {
  const background = spawn('sleep', ['30'], { stdio: 'ignore' });
  record({ type: 'background_child', pid: background.pid });
  await emit({ type: 'thread.started', thread_id: threadId });
  await sleep(30_000);
  process.exit(0);
}

const hugeLineBytes = Number(process.env.MOCK_CODEX_HUGE_LINE_BYTES || 0);
if (hugeLineBytes > 0) {  await emit({ type: 'thread.started', thread_id: threadId });
  await emit({ type: 'turn.started' });
  await emit({
    type: 'item.completed',
    item: {
      id: 'item_msg',
      type: 'agent_message',
      text: 'A'.repeat(hugeLineBytes),
    },
  });
  await sleep(1000);
  process.exit(0);
}

if (mode === 'no_terminal') {
  await emit({ type: 'thread.started', thread_id: threadId });
  await emit({ type: 'turn.started' });
  await emit({
    type: 'item.completed',
    item: { id: 'item_msg', type: 'agent_message', text: 'PARTIAL' },
  });
  process.exit(0);
}

if (mode === 'orphan_stdout') {
  await emit({ type: 'thread.started', thread_id: threadId });
  await emit({ type: 'turn.started' });
  await emit({
    type: 'item.completed',
    item: { id: 'item_msg', type: 'agent_message', text: 'ORPHAN' },
  });
  await emit({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  const grandchild = spawn('sleep', ['5'], {
    stdio: ['ignore', 'inherit', 'ignore'],
    detached: true,
  });
  grandchild.unref();
  record({ type: 'grandchild', pid: grandchild.pid });
  process.exit(0);
}

const sleepMatch = prompt.match(/\[\[sleep=(\d+)\]\]/);
const sleepMs = sleepMatch
  ? Number(sleepMatch[1])
  : Number(process.env.MOCK_CODEX_SLEEP_MS || 0);
if (sleepMs > 0) await sleep(sleepMs);

await emit({ type: 'thread.started', thread_id: threadId });
await emit({ type: 'turn.started' });

if (process.env.MOCK_CODEX_GARBAGE === '1') {
  process.stdout.write('this is not json\n\n');
}

const eventCount = Number(process.env.MOCK_CODEX_EVENTS || 0);
const toolBytes = Number(process.env.MOCK_CODEX_TOOL_BYTES || 0);
const eventDelayMs = Number(process.env.MOCK_CODEX_EVENT_DELAY_MS || 0);
for (let i = 0; i < eventCount; i += 1) {
  const command = `echo event-${i}`;
  await emit({
    type: 'item.started',
    item: { id: `item_${i}`, type: 'command_execution', command },
  });
  const output = 'X'.repeat(toolBytes);
  await emit({
    type: 'item.completed',
    item: {
      id: `item_${i}`,
      type: 'command_execution',
      command,
      aggregated_output: output,
      output,
      exit_code: 0,
    },
  });
  if (eventDelayMs > 0) await sleep(eventDelayMs);
}

const failTurn = mode === 'fail_turn' || process.env.MOCK_CODEX_FAIL_TURN === '1';
if (failTurn) {
  await emit({
    type: 'turn.failed',
    error: { message: process.env.MOCK_CODEX_FAIL_MESSAGE || 'mock turn failed' },
  });
} else {
  if (process.env.MOCK_CODEX_UNKNOWN_EVENT === '1') {
    await emit({ type: 'future.event', payload: { ignored: true } });
  }
  if (process.env.MOCK_CODEX_MULTI_MESSAGES === '1') {
    await emit({
      type: 'item.completed',
      item: { id: 'item_msg_1', type: 'agent_message', text: 'first message' },
    });
    await emit({
      type: 'item.completed',
      item: { id: 'item_msg_2', type: 'agent_message', text: 'second message' },
    });
  } else {
    let answer = process.env.MOCK_CODEX_ANSWER ?? 'MOCK_OK';
    const answerBytes = Number(process.env.MOCK_CODEX_ANSWER_BYTES || 0);
    if (answerBytes > 0) answer = 'A'.repeat(answerBytes);
    if (process.env.MOCK_CODEX_ECHO === '1') answer = `OK: ${prompt}`;
    await emit({
      type: 'item.completed',
      item: { id: 'item_msg', type: 'agent_message', text: answer },
    });
  }
  await emit({
    type: 'turn.completed',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  if (process.env.MOCK_CODEX_EXIT_AFTER_TERMINAL) {
    process.exit(Number(process.env.MOCK_CODEX_EXIT_AFTER_TERMINAL));
  }
  if (process.env.MOCK_CODEX_AFTER_TERMINAL === '1') {
    await emit({ type: 'agent_message', message: 'LATE MESSAGE' });
  }
}

record({ type: 'turn_completed', at: Date.now() });

const postDoneSleepMs = Number(process.env.MOCK_CODEX_POST_DONE_SLEEP_MS || 0);
if (postDoneSleepMs > 0) {
  record({ type: 'post_done_sleep', ms: postDoneSleepMs });
  await sleep(postDoneSleepMs);
}

process.exit(0);
