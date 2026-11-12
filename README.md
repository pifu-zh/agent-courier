# agent-courier

用飞书**官方** [`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel) SDK 把飞书消息接到本机 Codex CLI 的最小实现。

```text
飞书消息（WebSocket 长连接）
  → 官方 Channel SDK（策略 / 去重 / 规范化）
  → 本机 codex exec --json
  → 流式 markdown 回复
```

## 特性

| 能力 | 实现 |
|---|---|
| 接入方式 | 飞书官方 Channel SDK，WebSocket 长连接 |
| 回复 | CardKit 流式卡片；失败时自动回退普通 markdown |
| 会话 | 每个 chat/thread 独立保存 `threadId + cwd`，支持 `/new`、`/cd` |
| 并发 | 单 scope 串行，全局默认 2 个 Codex 进程，其余排队 |
| 内存 | 只保留当前答案与最近进度；工具输出 4 KB、进度 20 KB、最终答案 100 KB |
| 安全 | allowlist、`workspace-write` sandbox、可选 bubblewrap 隐藏凭据路径 |

## 要求

- Linux，Node.js >= 20
- 已安装 Codex CLI，`codex exec --json` 可用
- 可选：`bubblewrap`（`codexIsolation.enabled=true` 时需要）
- 飞书自建应用已开启**长连接**事件订阅，订阅 `im.message.receive_v1`
- 应用具备机器人能力、发送消息、添加表情回应、CardKit（流式卡片）权限

## 安装

```bash
git clone https://github.com/pifu-zh/agent-courier.git ~/.local/share/agent-courier
cd ~/.local/share/agent-courier
npm install --omit=dev
```

创建 `.env`（权限必须是 600，不要把 secret 提交到任何地方）：

```bash
cp .env.example .env
# 编辑 .env，填入 LARK_APP_ID / LARK_APP_SECRET
chmod 600 .env
```

创建配置：

```bash
cp config.example.json config.json
```

`config.json` 已被 `.gitignore` 忽略。最小配置示例：

```json
{
  "allowedDmUsers": ["ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
  "allowedChats": ["oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
  "requireMention": true,
  "defaultCwd": "workspace",
  "allowedCwdRoots": ["workspace"],
  "sandbox": "workspace-write",
  "model": null,
  "maxConcurrentRuns": 2,
  "runTimeoutMs": 1800000,
  "stopGraceMs": 5000,
  "codexBin": "codex",
  "replyMode": "stream",
  "seedSessions": {}
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `allowedDmUsers` | 允许使用机器人的用户 open_id；DM 和群聊都会校验 |
| `allowedChats` | 允许的群 chat_id；DM 不受此限制 |
| `requireMention` | 群聊是否必须 @bot |
| `defaultCwd` | 默认工作目录；相对路径按项目根目录解析 |
| `allowedCwdRoots` | `/cd` 允许切换到的根目录；相对路径按项目根目录解析 |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` |
| `model` | 传给 `codex --model`；`null` 表示默认模型 |
| `maxConcurrentRuns` | 全局同时运行的 Codex 进程数，1–10 |
| `runTimeoutMs` | 单次任务超时，默认 30 分钟 |
| `stopGraceMs` | SIGTERM 后等待多久再 SIGKILL |
| `queueTtlMs` | 排队任务过期时间，默认 10 分钟 |
| `codexBin` | Codex 可执行文件；可写绝对路径、相对路径或 PATH 中的命令名 |
| `replyMode` | `stream`（流式卡片）或 `final`（只发最终结果） |
| `codexIsolation` | `enabled` 为 true 时用 bubblewrap 启动 Codex；`hidePaths` 支持 `~/...` |
| `seedSessions` | 首次启动时写入的 scope → thread/cwd |

`seedSessions` 示例（只想延续已有会话时使用）：

```json
{
  "oc_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": {
    "threadId": "00000000-0000-0000-0000-000000000000",
    "cwd": "workspace"
  }
}
```

> `sessions.json` 只在**不存在**时用 `seedSessions` 初始化；之后由运行过程维护。不要在 bot 运行时手工改 `sessions.json`。

## 运行

前台：

```bash
cd ~/.local/share/agent-courier
npm start
```

systemd user service（假设安装在 `~/.local/share/agent-courier`）：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/agent-courier.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-courier.service
systemctl --user status agent-courier.service
journalctl --user -u agent-courier.service -f
```

如果安装目录不同，修改 unit 里的 `WorkingDirectory`、`EnvironmentFile` 和 `ExecStart`。`PATH` 需要包含 `codex` 所在目录。

停止：

```bash
systemctl --user disable --now agent-courier.service
```

## 飞书命令

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/new`、`/reset` | 中断当前任务、清空该会话排队消息并开始新 thread |
| `/stop` | 中断当前任务并清空该会话排队消息 |
| `/status` | 显示 thread、cwd、sandbox、队列 |
| `/cd <路径>` | 切换 cwd 并开始新 thread；支持 `~` |

普通消息直接进入 Codex。同一 scope 同时只跑一个任务；后面的消息排队（每 scope 最多 20 条）。

## 日志

- `logs/bot-YYYYMMDD.jsonl`：JSONL，5 MB 轮转，保留 3 份
- `journalctl --user -u agent-courier.service`
- 不记录 App Secret、完整 prompt、完整答案；敏感字段会被替换为 `[redacted len=N]`

## 安全边界

- 默认只接受 allowlist 里的用户和群；群聊还要 @bot
- 默认 `workspace-write`，Codex 不能随意改工作区外文件
- `approval_policy="never"` 只在 sandbox 内生效；不要把 sandbox 改成 `danger-full-access`，除非明确需要
- `codexIsolation.enabled=true` 时，Codex 由 `bwrap --unshare-pid --dev-bind / /` 启动；`hidePaths` 中的目录用 tmpfs 覆盖、普通文件用 `/dev/null` 覆盖，Codex 读不到 bot 的 `.env`、SSH key、npm token 等
- 残余风险：`~/.codex/auth.json` 必须让 Codex 读到；被提示注入的任务仍可能打印它。要彻底隔离需要独立 UID 或容器
- `.env` 必须 600；不要提交、不要发到聊天里
- 单实例锁会阻止同一个目录启动两个 bot；不要同时运行两个连接同一飞书应用的服务

## 当前限制

- 只处理文本消息；图片/文件附件不会转发给 Codex。
- 超长答案：卡片最多 26k，剩余内容分片补发，单次总计最多 101k。
- 群聊里只有 `allowedDmUsers` 中的用户能触发，其他成员即使 @bot 也不会执行。
- `/stop` 和 `/new` 会静默丢弃该会话已排队的消息，不会逐条通知。
- `maxConcurrentRuns > 1` 时，SDK 的流更新失败计数是进程级的；极端情况下另一个会话的失败会让本会话回退为普通消息，可能重复一次内容。
- 流式卡片依赖应用具备 CardKit 权限；缺失时 SDK 自动回退普通 markdown。

## 内存

- 不保存事件数组；每个 run 只持有当前答案和最近 20 KB 进度
- 单条工具输出截断 4 KB，最终答案截断 100 KB
- 流式卡片最多 26k 字符；超出部分按 3k 分片、250ms 间隔补发，总计最多 101k
- Codex stderr 只保留尾部 64 KB
- 单 scope 串行 + 全局并发 2
- 服务以 `--max-old-space-size=256` 启动：异常增长会先 OOM 重启，不会顶满宿主内存
- 不设置 cgroup `MemoryMax`：Codex 子进程在同一个 cgroup，硬上限会误杀长任务

观察内存：

```bash
systemctl --user show agent-courier.service -p MemoryCurrent -p MemoryPeak
smem -P node -c "pid user command rss pss uss"
```

## 测试

```bash
npm test                  # 单元 + 集成 + 内存（112 个用例，约 45–50s）
npm run test:unit
npm run test:integration
npm run test:memory
RUN_REAL_CODEX=1 npm test # 额外跑真实 Codex
```

测试使用假 Feishu Channel 和假 Codex 可执行文件，不需要飞书网络；真实飞书消息仍需人工发一条。

- `RUN_REAL_CODEX=1` 时可用 `CODEX_BIN` 指定 Codex 路径，默认使用 PATH 中的 `codex`。
- 隔离测试需要 `bubblewrap`，可用 `BWRAP_BIN` 指定路径。

完整测试矩阵与内存数据见 [`docs/TESTING.md`](docs/TESTING.md)；从 `lark-channel-bridge` 借鉴/拒绝的做法见 [`docs/BRIDGE-LESSONS.md`](docs/BRIDGE-LESSONS.md)。

## 迁移与回滚

如果机器上还运行着旧的 `lark-channel-bridge` 或另一个连接同一飞书应用的 bot：

```bash
# 先停旧服务，避免两个 WebSocket 客户端抢事件
systemctl --user disable --now <old-service>
```

确认新服务正常后，再按需删除旧服务。回滚只需停掉 `agent-courier.service` 并重新启动旧服务；旧 bridge 的状态目录不会被本项目修改。

## 故障排查

**启动时报 `LARK_APP_ID is missing`**
：`.env` 不在项目根目录，或权限/内容不对。

**`bot.connect_failed`**
：检查飞书开发者后台「事件订阅」是否选择长连接，应用是否启用机器人能力；确认没有第二个进程连着同一个 app。

**能连上但收不到消息**
：检查事件订阅是否包含 `im.message.receive_v1`；检查 `config.json` 的 `allowedDmUsers` / `allowedChats`；群里是否 @bot。

**回复不是流式卡片**
：应用可能缺少 CardKit 权限，SDK 会自动回退为普通 markdown；日志里会有 `stream.failed`。

**`codex exited with code ...`**
：先用同一个 cwd 手工跑一次：

```bash
codex exec --json --sandbox workspace-write -C <cwd> -
```

**想完全关闭流式**
：把 `config.json` 的 `replyMode` 改成 `final`，重启服务。
