# 从 lark-channel-bridge 借鉴了什么

子代理对 `lark-channel-bridge` v0.7.1 的 npm 包 `dist/cli.js`（17,495 行）做了只读审计。结论：它在**进程生命周期、终止语义、cwd 安全、日志脱敏、实例锁**上有可借鉴价值；无界事件/状态缓冲必须避开。

当前实现已经改成“一个常驻 `codex app-server` + 一个 thread”，因此旧 bridge 的队列、并发和 reaction 逻辑不再适用。下面只列与当前代码对应的部分。

## 已落地

| 借鉴点 | bridge 证据 | 当前实现 |
|---|---|---|
| 没有终止事件不能算成功 | `CodexJsonlTranslator.finish()` `cli.js:6467-6499` | 只认 `turn/completed`；`turn.failed`/`interrupted` 走失败/取消路径 |
| 终止后忽略后续事件 | `if (this.terminal) return []` `cli.js:6429-6432` | 每个 turn 完成后从 active map 移除，迟到通知不再影响结果 |
| 多段 agent_message | `queueAgentMessage` `cli.js:6527-6560` | `item/agentMessage/delta` 累积，`item/completed` 用最终文本校正，缓冲上限 200k |
| 中断要真正停掉后端 | active run stop | `/stop` → app-server `turn/interrupt`；`SIGTERM` 时先中断再关闭 app-server |
| 关停要等状态落盘 | `Promise.allSettled([...])` `cli.js:14207-14246` | `shutdown()`：中断 turn → `sessions.flush()` → `runner.close()` → `channel.disconnect()` |
| cwd 必须 realpath 后校验 | `resolveWorkingDirectory` `cli.js:777-841` | `config.isCwdAllowed()` 用 `realpathSync.native()`；`/cd` symlink 逃逸测试 |
| 日志值级脱敏 | `redactDiagnosticText` `cli.js:3910-3929` | `log.mjs` 对所有字符串跑 `Bearer ...` / `app_secret=...` / `"token":"..."` 替换，并截断 4096 |
| 单实例锁 | `proper-lockfile` + `meta.json` `cli.js:1704-1738` | `lock.mjs` 用 `open(...,'wx',0600)` + pid 存活检查 + stale takeover |
| 未知事件计数 | `unknownEvents`/`protocolDrift()` `cli.js:6458`、`6497-6532` | app-server 通知按 method 去重记录，`run.end` 可查 |
| 进程退出不能留下悬挂 promise | 子进程退出处理 | app-server exit 时拒绝所有 pending JSON-RPC，并结束所有 active turn |

## 单会话改造后不再采用

- 按 chat/scope 的运行队列和并发上限：现在只有一个 owner 私聊、一个 thread，不需要队列。
- `turn.completed` 后的进程退出宽限：app-server 常驻，turn 结束后进程不退出。
- reaction 作为“正在输入”提示：当前直接流式更新卡片。
- 30 分钟总超时：当前不设总超时，卡死由 `/stop` 处理；长任务要求放进后台 tmux。
- bwrap 隔离：当前按需求让 Codex 直接共享宿主环境。

## 明确没有照搬

- `RunState.blocks` 和 `EventFanout.buffer`：每个工具/事件块无界保留（`cli.js:8232-8299`、`12507-12561`）。当前答案缓冲 200k、工具输出 4k、进度 20k、最终 100k。
- `stderrChunks` 全量缓存（`cli.js:6708-6712`）：当前只保留尾部 64KB。
- `PendingQueue` 无批量上限（`cli.js:13256-13310`）：当前没有队列。
- 每次运行前 `codex --version`（`cli.js:6665-6676`）：当前只在启动时检查二进制，实际错误由 app-server JSON-RPC 返回。
- 17.5k 行功能蔓延（meeting/comment/Web UI/supervisor/多 profile）：当前保持 9 个小模块。

## 官方 SDK / Codex 审计带来的修正

- `setContent(full)` 超过 30k 会触发 CardKit rollover（`@larksuite/channel` `index.mjs:4132-4158`）。当前把流内容硬限制在 26k，剩余部分走 `sendLong`。
- `setContent` 的远端更新失败只记 SDK warn，不会让 `stream()` reject（`index.mjs:4115-4126`）。当前用自定义 SDK logger 统计 `[stream] update failed`，检测到就回退发送最终答案。
- node-sdk 的 `internalCache` 无界（`node-sdk/lib/index.js:237-272`）。当前注入 `BoundedCache(10000)`，并有 5 万次写入测试。
- WS 首次连接后的终态失败不会触发 `channel.on('error')`（`index.mjs:5402-5407`）。当前启用 `keepalive`，不可恢复时退出 1，让 systemd 重启。
- `resolveChatMode:true` 会为每个 chat 调一次 `chat.get` 且缓存无界；当前已关闭。
- `channel.reply` 不会切分超长单行；当前 `sendLong` 按 3k 强制切分并限速。

## 由审计推导出的测试

- 只接受 owner 私聊；群聊/未知发送者不触发 Codex。
- 第一条消息 `thread/start`，后续消息复用 thread。
- turn 活跃时新消息走 `turn/steer`，不新建 turn。
- `/stop` 中断；`/new` 清 thread；SIGTERM 关停。
- `/cd` 到 symlink → 拒绝。
- 第二个 bot 进程 → 锁冲突退出 1。
- 40k 答案 → 卡片 ≤28k，剩余分片；单条分片 ≤3k。
- 60 个 turn 大输出 → JS heap 基本不变（见 `docs/TESTING.md`）。
