import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANSWER_MAX,
  PROGRESS_MAX,
  STREAM_MAX,
  clipAnswer,
  toolSummary,
  appendProgress,
  render,
  renderForStream,
} from '../../src/format.mjs';

test('clipAnswer leaves short answers untouched', () => {
  assert.equal(clipAnswer('hello'), 'hello');
  assert.equal(clipAnswer(null), '');
  assert.equal(clipAnswer(undefined), '');
});

test('clipAnswer truncates at the configured limit', () => {
  const result = clipAnswer('A'.repeat(ANSWER_MAX + 10));
  assert.equal(result.slice(0, ANSWER_MAX), 'A'.repeat(ANSWER_MAX));
  assert.match(result, /\[truncated\]$/);
  assert.ok(result.length < ANSWER_MAX + 50);
});

test('toolSummary collapses whitespace, removes backticks and caps length', () => {
  assert.equal(toolSummary('  echo   a\tb\n`x`  '), "echo a b 'x'");
  assert.equal(toolSummary(null), '');
  assert.equal(toolSummary('x'.repeat(500)).length, 200);
});

test('appendProgress caps total progress and returns the summary', () => {
  let progress = '';
  for (let i = 0; i < 100; i += 1) {
    const next = appendProgress(progress, `echo ${i} ${'x'.repeat(400)}`);
    progress = next.progress;
    assert.equal(next.summary.length, 200);
    assert.ok(progress.length <= PROGRESS_MAX);
  }
  assert.ok(progress.includes('🔧'));
});

test('render prefers answer, then progress, then placeholder', () => {
  assert.equal(render('answer', ''), 'answer');
  assert.equal(render('', 'progress'), 'progress');
  assert.equal(render('answer', 'progress'), 'answer\n\nprogress');
  assert.equal(render('', ''), '正在处理…');
});

test('renderForStream caps the card below the Feishu element limit', () => {
  const short = renderForStream('short', '');
  assert.deepEqual(short, { text: 'short', truncated: false });
  const long = renderForStream('A'.repeat(STREAM_MAX + 5000), '');
  assert.equal(long.truncated, true);
  assert.ok(long.text.length < STREAM_MAX + 100);
  assert.match(long.text, /剩余部分将在任务结束后发送/);
});
