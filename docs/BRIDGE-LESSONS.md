# 从 lark-channel-bridge 借鉴了什么

子代理对 `lark-channel-bridge` v0.7.1 的 npm 包 `dist/cli.js`（17,495 行）做了只读审计。结论：它不是一无是处，**进程生命周期、取消语义、队列占位、cwd 安全、日志脱敏、实例锁**这几块有明确可借鉴价值；它的无界事件/状态缓冲则必须避开。

下面只列已经落地或明确决定不做的项。bridge 行号是 bundle 行号。

## 已落地

| 借鉴点 | bridge 证据 | 本项目的实现 |
|---|---|---|
| 没有终止事件不能算成功 | `CodexJsonlTranslator.finish()` `cli.js:6467-6499` | `codex.mjs` 在 EOF 且没有 `turn.completed`/`turn.failed` 时返回 `codex stream ended before a terminal event` |
| `turn.completed` 后进程赖着不退 | `waitForExit(2s)` + stop `cli.js:12324-12460` | `POST_DONE_EXIT_GRACE_MS=5s`，超时 SIGTERM→SIGKILL；terminal 成功不被非零退出码覆盖 |
| 子进程退出但 stdout 被孙进程持有 | exit 后 50ms destroy stdout `cli.js:6794-6801` | exit 后 250ms `rl.close()` + `stdout.destroy()`；单测用 `orphan_stdout` 假 Codex 验证 |
| 关停要等子进程和状态落盘 | `Promise.allSettled([... channel.disconnect, activeRuns.stopAll, sessions.flush ...])` `cli.js:14207-14246`、`17290-17310` | `shutdown()`：`queue.shutdown()` → `waitForIdle(stopGrace+1s)` → `sessions.flush()` → `channel.disconnect()` |
| 运行占位必须先于异步取槽 | `ActiveRuns.reserve(scope)` `cli.js:12194-12214` | `run-queue.mjs` 在 `launch()` 里同步写 `pending`，再 `await acquire()`；另一条消息看到 pending 就排队 |
| 运行句柄身份校验 | `unregister` 只在 `existing.run === run` 时删除 `cli.js:12238-12242` | 队列的 `active/pending` 以 scope 为键，启动/结束路径不会误删新条目；`/stop` 后队列清空 |
| 队列任务过期 + 出队二次校验 | `expiresAt = now+5min`，spawn 前检查 `cli.js:8728-8771`、`12330-12332` | `config.queueTtlMs`（默认 10min）；`executeRun` 出队时重新 `isAllowed`，再检查 TTL |
| cwd 必须 realpath 后校验 | `resolveWorkingDirectory` `cli.js:777-841` | `config.isCwdAllowed()` 用 `realpathSync.native()`；`/cd` symlink 逃逸测试 |
| 日志值级脱敏 | `redactDiagnosticText` `cli.js:3910-3929` | `log.mjs` 对所有字符串跑 `Bearer ...` / `app_secret=...` / `"token":"..."` 替换，并截断 4096 |
| 单实例锁 | `proper-lockfile` + `meta.json` `cli.js:1704-1738` | `lock.mjs` 用 `open(...,'wx',0600)` + pid 存活检查 + stale takeover |
| reaction 不阻塞 agent 启动 | Typing reaction fire-and-forget `cli.js:14598` | `executeRun` 先发起 `addReaction` promise，不 await，再启动 Codex；finally 里 2s race 后清理 |
| 终止锁存 + 多段 agent_message | `if (this.terminal) return []` `cli.js:6429-6432`；`queueAgentMessage` `cli.js:6527-6560` | `codex.mjs` 终止后忽略后续事件；`appendAgentMessage` 处理累计快照/多段消息，最终缓冲上限 200k |
| 未知事件计数 | `unknownEvents`/`protocolDrift()` `cli.js:6458`、`6497-6532` | `unknownEvents` Set，每类只 warn 一次，`run.end` 可见 |
| 附件/图片管线 | `MediaCache` + `normalizeAttachments` `cli.js:11920-12145` | **暂未做**：当前文本-only；需要时按 `msg.resources` → `--image` 扩展 |
| 懒开流 + 失败降级 | `createLazyProgressStream` / `awaitRenderAwareStream` `cli.js:14812-15088` | 已做失败降级和 26k 上限；懒开流暂未做（当前先发“正在处理…”卡片） |
| idle watchdog | 工具在飞时暂停的 idle timer `cli.js:14948-15020` | 暂未做；当前只有总时长 `runTimeoutMs` |
| 会话身份绑定 | `(scope, agent, cwdRealpath, policyFingerprint)` `cli.js:16558-16618` | 目前只存 `threadId+cwd`；sandbox/model 变化后的 thread 复用暂未拦截 |
| 600ms 批处理 | `PendingQueue` `cli.js:13256-13310` | 未做；当前 `maxMessages:1`，避免无界合并 |

## 明确没有照搬

- `RunState.blocks` 和 `EventFanout.buffer`：每个工具/事件块无界保留（`cli.js:8232-8299`、`12507-12561`）。本项目的答案缓冲 200k、工具输出 4k、进度 20k、最终 100k。
- `stderrChunks` 全量缓存（`cli.js:6708-6712`）：本项目只保留尾部 64KB。
- `PendingQueue` 无批量上限（`cli.js:13256-13310`）：本项目每 scope 最多 20 条。
- 每次运行前 `codex --version`（`cli.js:6665-6676`）：本项目只在启动时由 `config.mjs` 检查二进制存在，实际错误由 spawn/JSONL 返回。
- “立即删运行句柄 + 异步 stop”只抄一半（`cli.js:12253-12265`）：没有身份校验会误删新运行；本项目用队列的 pending/active 状态解决。
- 把 access policy 纳入会话指纹（`cli.js:7730-7768`）：改白名单会让所有会话失效，对单用户 bot 过度；未来只用 `cwd+sandbox+model`。
- 17.5k 行功能蔓延（meeting/comment/Web UI/supervisor/多 profile）：本项目保持 11 个小模块。

## 官方 SDK 审计带来的额外修正

不是 bridge 的功劳，但同样重要：

- `setContent(full)` 超过 30k 会触发 CardKit rollover，SDK 会把整段内容重新写进旧卡，造成卡片刷屏/内容丢失（`@larksuite/channel` `index.mjs:4132-4158`）。本项目把流内容硬限制在 26k，剩余部分走 `sendLong`。
- `setContent` 的远端更新失败只记 SDK warn，不会让 `stream()` reject（`index.mjs:4115-4126`）。本项目用自定义 SDK logger 统计 `[stream] update failed`，检测到就回退发送最终答案。
- node-sdk 的 `internalCache` 无界（`node-sdk/lib/index.js:237-272`）。本项目注入 `BoundedCache(10000)`，并有 5 万次写入测试。
- WS 首次连接后的终态失败不会触发 `channel.on('error')`（`index.mjs:5402-5407`）。本项目启用 `keepalive`，不可恢复时退出 1，让 systemd 重启。
- `resolveChatMode:true` 会为每个 chat 调一次 `chat.get` 且缓存无界；本项目已关闭。
- `channel.reply` 不会切分超长单行；本项目 `sendLong` 按 3k 强制切分并限速。
- `addReaction/removeReaction` 没有重试且可能等 30s；本项目不阻塞启动，并用 2s race 清理。

## 由审计推导出的测试

- 无 terminal、exit 0 → 必须失败。
- `turn.completed` 后赖着不退 → 5s 内返回成功并杀进程。
- 孙进程继承 stdout → 250ms 内结束 readline，不能泄漏全局槽。
- 忽略 SIGTERM → SIGKILL 后返回。
- 两条同 scope 消息 → 串行；三条不同 scope + 并发 2 → 最大并发 2。
- 队列满 20 / TTL 过期 / 权限变更 → 不执行并回复。
- `/cd` 到 symlink → 拒绝。
- 第二个 bot 进程 → 锁冲突退出 1。
- 40k 答案 → 卡片 ≤28k，剩余分片；单条分片 ≤3k。
- reaction 延迟 700ms → Codex 启动延迟 <450ms。
- 60 轮大输出 → JS heap 基本不变（见 `docs/TESTING.md`）。
