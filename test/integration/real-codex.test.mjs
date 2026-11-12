import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createFixture,
  spawnBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  waitForBotCount,
  readJsonl,
} from '../helpers/harness.mjs';
import { dmMessage } from '../helpers/messages.mjs';

const enabled = process.env.RUN_REAL_CODEX === '1';
const codexBin = process.env.CODEX_BIN || 'codex';

test(
  'real codex runs through the app-server and streams the answer',
  { skip: enabled ? false : 'set RUN_REAL_CODEX=1 to run' },
  async () => {
    const fixture = createFixture({
      name: 'real-codex',
      configOverrides: {
        codexBin,
      },
      scenario: [
        {
          delayMs: 100,
          event: 'message',
          msg: dmMessage({ content: 'Reply with exactly: E2E_OK' }),
        },
      ],
    });
    let handle;
    try {
      handle = spawnBot(fixture);
      await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
      const end = await waitForBotEvent(
        fixture,
        (entry) => entry.event === 'run.end',
        { timeout: 120000 },
      );
      assert.equal(end.ok, true);
      const contents = readJsonl(fixture.channelLog)
        .filter((entry) => entry.type === 'stream.content')
        .map((entry) => entry.content)
        .join('\n');
      assert.match(contents, /E2E_OK/);
    } finally {
      cleanupFixture(fixture, handle);
    }
  },
);

test(
  'real codex reuses the same thread for a second message',
  { skip: enabled ? false : 'set RUN_REAL_CODEX=1 to run' },
  async () => {
    const fixture = createFixture({
      name: 'real-codex-reuse',
      configOverrides: {
        codexBin,
      },
      scenario: [
        {
          delayMs: 100,
          event: 'message',
          msg: dmMessage({ content: 'Reply with exactly: FIRST_OK' }),
        },
        {
          delayMs: 10000,
          event: 'message',
          msg: dmMessage({ content: 'Reply with exactly: SECOND_OK' }),
        },
      ],
    });
    let handle;
    try {
      handle = spawnBot(fixture);
      await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
      await waitForBotCount(fixture, (entry) => entry.event === 'run.end', 2, {
        timeout: 240000,
      });
      const contents = readJsonl(fixture.channelLog)
        .filter((entry) => entry.type === 'stream.content')
        .map((entry) => entry.content)
        .join('\n');
      assert.match(contents, /FIRST_OK/);
      assert.match(contents, /SECOND_OK/);
    } finally {
      cleanupFixture(fixture, handle);
    }
  },
);
