import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodexArgs, runCodex } from '../../src/codex.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MOCK = resolve(HERE, '../helpers/mock-codex.mjs');
chmodSync(MOCK, 0o755);

const silent = { info() {}, warn() {}, error() {} };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: line };
      }
    });
}

async function run(
  env = {},
  {
    prompt = 'hello',
    threadId,
    timeoutMs = 5000,
    stopGraceMs = 200,
    postDoneGraceMs = 200,
    signal,
    codexBin = MOCK,
    isolation,
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const log = join(dir, 'mock.jsonl');
  const startedAt = Date.now();
  const result = await runCodex({
    prompt,
    cwd: dir,
    sandbox: 'read-only',
    codexBin,
    timeoutMs,
    stopGraceMs,
    postDoneGraceMs,
    signal,
    threadId,
    logger: silent,
    env: { MOCK_CODEX_LOG: log, ...env },
    ...(isolation ? { isolation } : {}),
  });
  return {
    result,
    events: readJsonl(log),
    dir,
    elapsed: Date.now() - startedAt,
  };
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

test('buildCodexArgs builds new and resume commands', () => {
  assert.deepEqual(
    buildCodexArgs({
      cwd: '/work',
      sandbox: 'workspace-write',
      model: null,
      threadId: null,
    }),
    [
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/work',
      '-',
    ],
  );

  assert.deepEqual(
    buildCodexArgs({
      cwd: '/work',
      sandbox: 'read-only',
      model: 'gpt-test',
      threadId: 'thread_1',
    }),
    [
      'exec',
      '--sandbox',
      'read-only',
      '--model',
      'gpt-test',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
      '--ignore-rules',
      '--skip-git-repo-check',
      '-C',
      '/work',
      'resume',
      '--json',
      'thread_1',
      '-',
    ],
  );
});

test('parses thread, answer, tool events and prompt from stdin', async () => {
  const { result, events, dir } = await run(
    {
      MOCK_CODEX_THREAD_ID: 'thread_test',
      MOCK_CODEX_EVENTS: '2',
      MOCK_CODEX_TOOL_BYTES: '8',
      MOCK_CODEX_ANSWER: 'hello back',
    },
    { prompt: 'say hello' },
  );
  try {
    assert.equal(result.ok, true);
    assert.equal(result.threadId, 'thread_test');
    assert.equal(result.answer, 'hello back');
    assert.equal(result.exitCode, 0);
    const start = events.find((entry) => entry.type === 'start');
    const promptEvent = events.find((entry) => entry.type === 'prompt');
    assert.equal(start.cwd, dir);
    assert.equal(start.hasSecret, false);
    assert.equal(promptEvent.prompt, 'say hello');
  } finally {
    cleanup(dir);
  }
});

test('invokes callbacks for thread, answer and tool progress', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const log = join(dir, 'mock.jsonl');
  const threads = [];
  const answers = [];
  const tools = [];
  try {
    const result = await runCodex({
      prompt: 'tool test',
      cwd: dir,
      sandbox: 'read-only',
      codexBin: MOCK,
      timeoutMs: 5000,
      stopGraceMs: 200,
      logger: silent,
      env: {
        MOCK_CODEX_LOG: log,
        MOCK_CODEX_THREAD_ID: 'thread_cb',
        MOCK_CODEX_EVENTS: '1',
        MOCK_CODEX_TOOL_BYTES: '5',
        MOCK_CODEX_ANSWER: 'answer',
      },
      onThreadId: (id) => threads.push(id),
      onAnswer: (answer) => answers.push(answer),
      onTool: (tool) => tools.push(tool),
    });
    assert.equal(result.ok, true);
    assert.deepEqual(threads, ['thread_cb']);
    assert.deepEqual(answers, ['answer']);
    assert.deepEqual(
      tools.map((tool) => tool.phase),
      ['started', 'completed'],
    );
    assert.equal(tools[0].command, 'echo event-0');
    assert.equal(tools[1].output.length, 5);
  } finally {
    cleanup(dir);
  }
});

test('ignores malformed JSONL lines', async () => {
  const { result, dir } = await run({ MOCK_CODEX_GARBAGE: '1', MOCK_CODEX_ANSWER: 'ok' });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'ok');
  } finally {
    cleanup(dir);
  }
});

test('clips large tool output but keeps the full final answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
  const log = join(dir, 'mock.jsonl');
  const tools = [];
  try {
    const result = await runCodex({
      prompt: 'large output',
      cwd: dir,
      sandbox: 'read-only',
      codexBin: MOCK,
      timeoutMs: 5000,
      stopGraceMs: 200,
      logger: silent,
      env: {
        MOCK_CODEX_LOG: log,
        MOCK_CODEX_EVENTS: '1',
        MOCK_CODEX_TOOL_BYTES: '10000',
        MOCK_CODEX_ANSWER_BYTES: '200000',
      },
      onTool: (tool) => tools.push(tool),
    });
    assert.equal(result.ok, true);
    assert.equal(result.answer.length, 200000);
    assert.ok(result.answer.startsWith('A'));
    assert.ok(result.answer.endsWith('A'));
    const completed = tools.find((tool) => tool.phase === 'completed');
    assert.ok(completed.output.length < 4200);
    assert.match(completed.output, /\[truncated\]$/);
  } finally {
    cleanup(dir);
  }
});

test('reports turn.failed with its message', async () => {
  const { result, dir } = await run({
    MOCK_CODEX_FAIL_TURN: '1',
    MOCK_CODEX_FAIL_MESSAGE: 'mock failure detail',
  });
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /mock failure detail/);
  } finally {
    cleanup(dir);
  }
});

test('reports non-zero exit with only a short stderr tail', async () => {
  const { result, dir } = await run({
    MOCK_CODEX_MODE: 'stderr_fail',
    MOCK_CODEX_STDERR_BYTES: '1000000',
    MOCK_CODEX_EXIT_CODE: '7',
  });
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /codex exited with code 7/);
    assert.ok(result.error.length < 3000);
  } finally {
    cleanup(dir);
  }
});

test('reports a missing resume thread', async () => {
  const { result, events, dir } = await run(
    { MOCK_CODEX_MODE: 'missing_thread' },
    { threadId: 'missing_thread_id' },
  );
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /no rollout found/);
    assert.equal(events.some((entry) => entry.type === 'missing_thread'), true);
  } finally {
    cleanup(dir);
  }
});

test('aborts a running codex process', async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const promise = run(
    { MOCK_CODEX_SLEEP_MS: '30000' },
    { signal: controller.signal, timeoutMs: 5000 },
  );
  setTimeout(() => controller.abort(), 100);
  const { result, events, dir, elapsed } = await promise;
  try {
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true);
    assert.equal(result.aborted, true);
    assert.ok(elapsed < 2000, `elapsed ${elapsed}ms`);
    assert.equal(events.some((entry) => entry.type === 'signal'), true);
    assert.ok(Date.now() - startedAt < 3000);
  } finally {
    cleanup(dir);
  }
});

test('abort kills background descendants in the process group', async () => {
  const controller = new AbortController();
  const promise = run(
    { MOCK_CODEX_MODE: 'background_child' },
    { signal: controller.signal, timeoutMs: 5000 },
  );
  await sleep(500);
  controller.abort();
  const { result, events, dir } = await promise;
  try {
    const background = events.find((entry) => entry.type === 'background_child');
    assert.ok(background?.pid);
    assert.equal(result.cancelled, true);
    await sleep(300);
    assert.throws(() => process.kill(background.pid, 0), /ESRCH/);
  } finally {
    cleanup(dir);
  }
});

test('timeout kills a hung codex process', async () => {
  const { result, dir, elapsed } = await run(
    { MOCK_CODEX_MODE: 'hang' },
    { timeoutMs: 300, stopGraceMs: 100 },
  );
  try {
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.match(result.error, /timed out/);
    assert.ok(elapsed < 2500, `elapsed ${elapsed}ms`);
  } finally {
    cleanup(dir);
  }
});

test('spawn failure resolves instead of hanging', async () => {
  const { result, dir, elapsed } = await run(
    {},
    { codexBin: '/nonexistent/codex-for-test', timeoutMs: 1000 },
  );
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to spawn codex/);
    assert.ok(elapsed < 1500, `elapsed ${elapsed}ms`);
  } finally {
    cleanup(dir);
  }
});

test('rejects an oversized JSONL line instead of buffering it', async () => {
  const { result, dir, elapsed } = await run(
    { MOCK_CODEX_HUGE_LINE_BYTES: String(9 * 1024 * 1024) },
    { timeoutMs: 5000, stopGraceMs: 200 },
  );
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /line too large/);
    assert.ok(elapsed < 3000, `elapsed ${elapsed}ms`);
  } finally {
    cleanup(dir);
  }
});

test('fails when codex exits nonzero after a terminal event', async () => {
  const { result, dir } = await run({
    MOCK_CODEX_EXIT_AFTER_TERMINAL: '7',
    MOCK_CODEX_ANSWER: 'done',
  });
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /codex exited with code 7/);
  } finally {
    cleanup(dir);
  }
});

test('kills a process that lingers after turn.completed', async () => {
  const { result, events, dir, elapsed } = await run(
    { MOCK_CODEX_POST_DONE_SLEEP_MS: '30000' },
    { postDoneGraceMs: 200, stopGraceMs: 200 },
  );
  try {
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'MOCK_OK');
    assert.ok(elapsed < 2500, `elapsed ${elapsed}ms`);
    assert.equal(events.some((entry) => entry.type === 'signal'), true);
  } finally {
    cleanup(dir);
  }
});

test('escalates to SIGKILL when codex ignores SIGTERM', async () => {
  const { result, dir, elapsed } = await run(
    {
      MOCK_CODEX_POST_DONE_SLEEP_MS: '30000',
      MOCK_CODEX_IGNORE_SIGTERM: '1',
    },
    { postDoneGraceMs: 100, stopGraceMs: 100 },
  );
  try {
    assert.equal(result.ok, true);
    assert.ok(elapsed < 2500, `elapsed ${elapsed}ms`);
  } finally {
    cleanup(dir);
  }
});

test('fails when stdout ends without a terminal event', async () => {
  const { result, dir } = await run({ MOCK_CODEX_MODE: 'no_terminal' });
  try {
    assert.equal(result.ok, false);
    assert.match(result.error, /stream ended before a terminal event/);
  } finally {
    cleanup(dir);
  }
});

test('does not hang when exit leaves stdout open in a grandchild', async () => {
  const { result, events, dir, elapsed } = await run(
    { MOCK_CODEX_MODE: 'orphan_stdout' },
    { timeoutMs: 1500, postDoneGraceMs: 200 },
  );
  try {
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'ORPHAN');
    assert.ok(elapsed < 2000, `elapsed ${elapsed}ms`);
    const grandchild = events.find((entry) => entry.type === 'grandchild');
    if (grandchild?.pid) {
      try {
        process.kill(grandchild.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  } finally {
    cleanup(dir);
  }
});

test('joins multiple agent messages without duplicating snapshots', async () => {
  const { result, dir } = await run({ MOCK_CODEX_MULTI_MESSAGES: '1' });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'first message\n\nsecond message');
  } finally {
    cleanup(dir);
  }
});

test('ignores events that arrive after a terminal event', async () => {
  const { result, dir } = await run({
    MOCK_CODEX_AFTER_TERMINAL: '1',
    MOCK_CODEX_ANSWER: 'final answer',
  });
  try {
    assert.equal(result.ok, true);
    assert.equal(result.answer, 'final answer');
    assert.equal(result.answer.includes('LATE MESSAGE'), false);
  } finally {
    cleanup(dir);
  }
});

test('reports unknown event types once', async () => {
  const { result, dir } = await run({ MOCK_CODEX_UNKNOWN_EVENT: '1' });
  try {
    assert.equal(result.ok, true);
    assert.deepEqual(result.unknownEventTypes, ['future.event']);
  } finally {
    cleanup(dir);
  }
});

test('does not expose LARK_APP_SECRET to the codex child', async () => {
  const { events, dir } = await run({
    LARK_APP_SECRET: 'super-secret-test',
    MOCK_CODEX_ANSWER: 'ok',
  });
  try {
    const start = events.find((entry) => entry.type === 'start');
    assert.equal(start.hasSecret, false);
  } finally {
    cleanup(dir);
  }
});

test(
  'bwrap isolation hides configured paths from the codex child',
  {
    skip: existsSync(process.env.BWRAP_BIN || '/usr/bin/bwrap')
      ? false
      : 'bubblewrap is not installed',
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-isolation-'));
    const secretDir = join(dir, 'secrets');
    mkdirSync(secretDir);
    writeFileSync(join(secretDir, 'token'), 'TOP_SECRET');
    const probe = join(secretDir, 'token');
    const env = {
      MOCK_CODEX_READ_PATH: probe,
      MOCK_CODEX_LIST_PATH: secretDir,
    };
    try {
      const control = await run(env);
      assert.equal(control.result.ok, true);
      assert.match(control.result.answer, /READABLE=true/);
      assert.match(control.result.answer, /CONTENT=TOP_SECRET/);
      assert.match(control.result.answer, /ENTRIES=1/);
      cleanup(control.dir);

      const hidden = await run(env, {
        isolation: { enabled: true, hidePaths: [secretDir] },
      });
      assert.equal(hidden.result.ok, true);
      assert.match(hidden.result.answer, /READABLE=false/);
      assert.match(hidden.result.answer, /ENTRIES=0/);
      assert.equal(hidden.result.answer.includes('TOP_SECRET'), false);
      cleanup(hidden.dir);

      const loneFile = join(dir, 'credentials');
      writeFileSync(loneFile, 'FILE_SECRET');
      const fileHidden = await run(
        { MOCK_CODEX_READ_PATH: loneFile },
        { isolation: { enabled: true, hidePaths: [loneFile] } },
      );
      assert.equal(fileHidden.result.ok, true);
      assert.match(fileHidden.result.answer, /READABLE=false/);
      assert.equal(fileHidden.result.answer.includes('FILE_SECRET'), false);
      cleanup(fileHidden.dir);
    } finally {
      cleanup(dir);
    }
  },
);
