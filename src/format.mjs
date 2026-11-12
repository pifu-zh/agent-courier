export const ANSWER_MAX = 100_000;
export const PROGRESS_MAX = 20_000;
export const TOOL_SUMMARY_MAX = 200;
export const STREAM_MAX = 26_000;
export const DELIVERY_MAX = ANSWER_MAX + 1_000;
export const DELIVERY_CHUNK = 3_000;

export function clipAnswer(answer) {
  if (typeof answer !== 'string') return '';
  if (answer.length <= ANSWER_MAX) return answer;
  return `${answer.slice(0, ANSWER_MAX)}\n…[truncated]`;
}

export function toolSummary(command) {
  if (typeof command !== 'string') return '';
  return command
    .replace(/\s+/g, ' ')
    .replace(/`/g, "'")
    .trim()
    .slice(0, TOOL_SUMMARY_MAX);
}

export function appendProgress(progress, command) {
  const summary = toolSummary(command);
  if (!summary) return { progress, summary: '' };
  const next = `${progress}\n> 🔧 \`${summary}\``.slice(-PROGRESS_MAX).trimStart();
  return { progress: next, summary };
}

export function render(latest, progress) {
  if (latest && progress) return `${latest}\n\n${progress}`;
  return latest || progress || '正在处理…';
}

export function renderForStream(latest, progress) {
  const full = render(latest, progress);
  if (full.length <= STREAM_MAX) return { text: full, truncated: false };
  return {
    text: `${full.slice(0, STREAM_MAX)}\n\n…（内容较长，剩余部分将在任务结束后发送）`,
    truncated: true,
  };
}
