import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createFixture,
  spawnBot,
  stopBot,
  cleanupFixture,
  waitFor,
  waitForBotEvent,
  updateConfig,
  botLog,
  readJsonl,
} from '../helpers/harness.mjs';
import { textMessage } from '../helpers/messages.mjs';

const BWRAP = process.env.BWRAP_BIN || '/usr/bin/bwrap';

test(
  'bot runs codex with hidden paths when codexIsolation is enabled',
  { skip: existsSync(BWRAP) ? false : 'bubblewrap is not installed' },
  async () => {
    const fixture = createFixture({
      name: 'isolation',
      scenario: [{ delayMs: 100, event: 'message', msg: textMessage() }],
    });
    let handle;
    try {
      const secrets = join(fixture.root, 'secrets');
      mkdirSync(secrets);
      writeFileSync(join(secrets, 'token'), 'TOP_SECRET');
      updateConfig(fixture, {
        codexIsolation: { enabled: true, hidePaths: [secrets] },
      });
      fixture.env.MOCK_CODEX_READ_PATH = join(secrets, 'token');
      fixture.env.MOCK_CODEX_LIST_PATH = secrets;

      handle = spawnBot(fixture);
      await waitFor(fixture.channelLog, (entry) => entry.type === 'connected');
      await waitForBotEvent(fixture, (entry) => entry.event === 'run.end');

      const contents = readJsonl(fixture.channelLog)
        .filter((entry) => entry.type === 'stream.content')
        .map((entry) => entry.content || '');
      assert.ok(contents.length > 0, 'expected streamed content');
      assert.match(contents[contents.length - 1], /READABLE=false/);
      assert.match(contents[contents.length - 1], /ENTRIES=0/);
      assert.equal(contents.join('\n').includes('TOP_SECRET'), false);

      const spawn = botLog(fixture).find((entry) => entry.event === 'codex.spawn');
      assert.equal(spawn?.isolated, true);
      assert.equal(spawn?.hiddenPaths, 1);

      const exit = await stopBot(handle, 'SIGTERM', 8000);
      handle = null;
      assert.equal(exit.code, 0);
    } finally {
      cleanupFixture(fixture, handle);
    }
  },
);
