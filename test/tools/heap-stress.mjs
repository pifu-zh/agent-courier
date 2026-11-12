import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexRunner } from '../../src/codex.mjs';
import { BoundedCache } from '../../src/cache.mjs';

const silent = { info() {}, warn() {}, error() {} };
const mockBin = new URL('../helpers/mock-app-server.mjs', import.meta.url).pathname;
const mockLog = join(tmpdir(), 'heap-stress-mock.jsonl');

const cache = new BoundedCache({ maxEntries: 10_000 });
for (let i = 0; i < 20_000; i += 1) {
  await cache.set(`key-${i}`, 'x'.repeat(100), Date.now() + 60_000);
}

const runner = createCodexRunner({
  codexBin: mockBin,
  logger: silent,
  env: {
    MOCK_CODEX_LOG: mockLog,
    MOCK_CODEX_EVENTS: '5',
    MOCK_CODEX_TOOL_BYTES: '50000',
    MOCK_CODEX_ANSWER_BYTES: '20000',
  },
});
await runner.start();
const thread = await runner.ensureThread({
  cwd: process.cwd(),
  sandbox: 'read-only',
});

for (let i = 0; i < 10; i += 1) {
  const turn = await runner.startTurn({
    threadId: thread.threadId,
    prompt: `stress ${i}`,
    cwd: process.cwd(),
    sandbox: 'read-only',
  });
  const result = await turn.done;
  if (!result.ok) throw new Error(result.error);
}

await runner.close();
if (global.gc) global.gc();
console.log(
  JSON.stringify({
    cacheSize: cache.size,
    memory: process.memoryUsage(),
  }),
);
