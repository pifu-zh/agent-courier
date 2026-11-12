import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodex } from '../../src/codex.mjs';
import { BoundedCache } from '../../src/cache.mjs';

const silent = { info() {}, warn() {}, error() {} };
const mockBin = new URL('../helpers/mock-codex.mjs', import.meta.url).pathname;
const mockLog = join(tmpdir(), 'heap-stress-mock.jsonl');

const cache = new BoundedCache({ maxEntries: 10_000 });
for (let i = 0; i < 20_000; i += 1) {
  await cache.set(`key-${i}`, 'x'.repeat(100), Date.now() + 60_000);
}

for (let i = 0; i < 10; i += 1) {
  const result = await runCodex({
    prompt: `stress ${i} [[sleep=0]]`,
    cwd: process.cwd(),
    sandbox: 'read-only',
    codexBin: mockBin,
    timeoutMs: 10_000,
    stopGraceMs: 500,
    logger: silent,
    env: {
      MOCK_CODEX_LOG: mockLog,
      MOCK_CODEX_EVENTS: '5',
      MOCK_CODEX_TOOL_BYTES: '50000',
      MOCK_CODEX_ANSWER_BYTES: '20000',
    },
  });
  if (!result.ok) throw new Error(result.error);
}

if (global.gc) global.gc();
console.log(
  JSON.stringify({
    cacheSize: cache.size,
    memory: process.memoryUsage(),
  }),
);
