import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFixture,
  spawnBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  updateConfig,
  botLog,
  readJsonl,
} from '../helpers/harness.mjs';
import { textMessage } from '../helpers/messages.mjs';

const enabled = process.env.RUN_REAL_CODEX === '1';
const codexBin = process.env.CODEX_BIN || 'codex';
const bwrapBin = process.env.BWRAP_BIN || '/usr/bin/bwrap';

test(
  'real codex runs through the bot and streams the answer',
  { skip: enabled ? false : 'set RUN_REAL_CODEX=1 to run' },
  async () => {
    const fixture = createFixture({
      name: 'real-codex',
      configOverrides: {
        codexBin,
        runTimeoutMs: 120000,
      },
      scenario: [
        {
          delayMs: 100,
          event: 'message',
          msg: textMessage({ content: 'Reply with exactly: E2E_OK' }),
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
  'real codex cannot see a hidden path under codexIsolation',
  {
    skip: enabled
      ? existsSync(bwrapBin)
        ? false
        : 'bubblewrap is not installed'
      : 'set RUN_REAL_CODEX=1 to run',
  },
  async () => {
    const fixture = createFixture({
      name: 'real-codex-isolated',
      configOverrides: {
        codexBin,
        runTimeoutMs: 120000,
      },
    });
    let handle;
    try {
      const hiddenDir = join(fixture.root, 'isolated');
      mkdirSync(hiddenDir);
      const hiddenFile = join(hiddenDir, 'notes.txt');
      writeFileSync(hiddenFile, 'TOP_SECRET');
      updateConfig(fixture, {
        codexIsolation: { enabled: true, hidePaths: [hiddenDir] },
      });
      fixture.scenario = [
        {
          delayMs: 100,
          event: 'message',
          msg: textMessage({
            content: `Run this shell command and reply with exactly its stdout: test -f ${hiddenFile} && echo PRESENT || echo HIDDEN`,
          }),
        },
      ];
      writeFileSync(
        fixture.scenarioPath,
        `${JSON.stringify(fixture.scenario, null, 2)}\n`,
      );

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
      assert.match(contents, /HIDDEN/);
      assert.equal(contents.includes('TOP_SECRET'), false);
      const spawn = botLog(fixture).find((entry) => entry.event === 'codex.spawn');
      assert.equal(spawn?.isolated, true);
    } finally {
      cleanupFixture(fixture, handle);
    }
  },
);
