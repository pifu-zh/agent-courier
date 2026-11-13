# agent-courier

用飞书**官方** [`@larksuite/channel`](https://www.npmjs.com/package/@larksuite/channel) SDK 把飞书私聊接到本机 Codex 的常驻会话。

```text
飞书私聊
  ⇄ 官方 Channel SDK（WebSocket 长连接）
  ⇄ 一个常驻 codex app-server
  ⇄ 一个长期存在的 Codex thread
```

插件只做消息桥接：**不会为每条消息启动新的 `codex exec` 进程**。

## 工作方式

- bot 启动时拉起一个 `codex app-server --listen stdio://`
- 整个 bot 只有一个 Codex thread
- 第一条消息创建 thread；后续消息通过 `turn/start` 继续
- 当前 turn 还在执行时，新消息用 `turn/steer` 注入同一个 turn
- 没有消息队列、没有按 chat 的并发控制
- 不设总超时；长任务由 Codex 放进后台 tmux，不阻塞会话
- `/stop` 中断当前 turn，`/new` 开新 thread 并回收 app-server，释放旧 thread 的常驻内存
- thread id 持久化到 `sessions.json`，插件重启后通过 `thread/resume` 继续

## 要求

- Linux，Node.js >= 20
- Codex CLI 支持 `codex app-server`（当前验证版本 0.167.x）
- 飞书自建应用已开启**长连接**事件订阅，订阅 `im.message.receive_v1`
- 应用具备机器人能力、发送消息、CardKit（流式卡片）权限

## 安装

```bash
git clone https://github.com/pifu-zh/agent-courier.git ~/.local/share/agent-courier
cd ~/.local/share/agent-courier
npm ci --omit=dev
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

`config.json` 已被 `.gitignore` 忽略。示例：

```json
{
  "allowedDmUsers": ["ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
  "defaultCwd": "workspace",
  "allowedCwdRoots": ["workspace"],
  "sandbox": "danger-full-access",
  "model": null,
  "codexBin": "codex",
  "replyMode": "stream",
  "seedSessions": {}
}
```

### 字段说明

| 字段 | 说明 |
|---|---|
| `allowedDmUsers` | 允许使用机器人的用户 open_id；**只处理私聊** |
| `defaultCwd` | 默认工作目录；相对路径按项目根目录解析 |
| `allowedCwdRoots` | `/cd` 允许切换到的根目录 |
| `sandbox` | `read-only` / `workspace-write` / `danger-full-access` |
| `model` | 传给 Codex 的模型；`null` 表示默认模型 |
| `codexBin` | Codex 可执行文件；绝对路径、相对路径或 PATH 中的命令名 |
| `replyMode` | `stream`（流式卡片）或 `final`（只发最终结果） |
| `developerInstructions` | 可选，覆盖默认的开发者指令（默认要求长任务放 tmux） |
| `seedSessions` | 可选，首次启动时导入的旧 thread/cwd |

> 只支持 owner 私聊。群聊消息会被忽略，不会回复。

## 运行

前台：

```bash
cd ~/.local/share/agent-courier
npm start
```

systemd user service：

```bash
mkdir -p ~/.config/systemd/user
cp deploy/agent-courier.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now agent-courier.service
systemctl --user status agent-courier.service
journalctl --user -u agent-courier.service -f
```

如果安装目录不同，修改 unit 里的 `WorkingDirectory`、`EnvironmentFile` 和 `ExecStart`。`PATH` 需要包含 `codex` 所在目录。

## 飞书命令

| 命令 | 作用 |
|---|---|
| `/help` | 显示帮助 |
| `/new`、`/reset` | 中断当前 turn，回收 app-server，开始新 thread |
| `/stop` | 中断当前 turn |
| `/status` | 显示 thread、cwd、app-server、当前 turn |
| `/cd <路径>` | 切换 cwd 并开始新 thread；支持 `~` |

普通消息直接进入当前对话；turn 运行中会以 `turn/steer` 注入。

## 日志

- `logs/bot-YYYYMMDD.jsonl`：JSONL，5 MB 轮转，保留 3 份
- `journalctl --user -u agent-courier.service`
- 不记录 App Secret、完整 prompt、完整答案；敏感字段会被替换为 `[redacted len=N]`

## 安全边界

- **只接受 `allowedDmUsers` 中用户的私聊**；群聊一律忽略
- 默认示例使用 `danger-full-access`：Codex 可以读写当前用户的整个环境
- 如果不需要完全权限，把 `sandbox` 改成 `workspace-write`
- `.env` 必须 600；不要提交、不要发到聊天里
- 单实例锁会阻止同一个目录启动两个 bot；不要同时运行两个连接同一飞书应用的服务

## 当前限制

- 只处理文本消息；图片/文件附件不会转发给 Codex。
- 整个 bot 只有一个 thread；`/new` 才会换新会话。
- 没有总超时；卡死时用 `/stop` 人工中断。
- 超长答案：卡片最多 26k，剩余内容分片补发，单次总计最多 101k。
- 流式卡片依赖应用具备 CardKit 权限；缺失时 SDK 自动回退普通 markdown。
- `codex app-server` 目前是 experimental；升级 Codex 后需要回归测试协议。

## 内存

- Codex 由一个常驻 app-server 承载，不再每条消息启动进程
- bot 只保留当前 turn 的答案和最近进度
- 单条工具输出截断 4 KB，最终答案截断 100 KB
- app-server 的 thread 和历史由 Codex 自己管理
- `/new`、`/cd` 会回收 app-server，避免多个旧 thread 常驻内存
- 服务以 `--max-old-space-size=256` 启动：bot 进程异常增长会先 OOM 重启
- 不设置 cgroup `MemoryMax`：Codex 子进程在同一 cgroup，硬上限会误杀长任务

观察内存：

```bash
systemctl --user show agent-courier.service -p MemoryCurrent -p MemoryPeak
smem -P node -c "pid user command rss pss uss"
ps -eo pid,ppid,rss,cmd | grep "codex app-server"
```

## 测试

```bash
npm test                  # 单元 + 集成 + 内存
npm run test:unit
npm run test:integration
npm run test:memory
RUN_REAL_CODEX=1 npm test # 额外跑真实 Codex app-server
```

测试使用假 Feishu Channel 和假 app-server，不需要飞书网络；真实飞书消息仍需人工发一条。

- `RUN_REAL_CODEX=1` 时可用 `CODEX_BIN` 指定 Codex 路径，默认使用 PATH 中的 `codex`。

完整测试矩阵与内存数据见 [`docs/TESTING.md`](docs/TESTING.md)；从 `lark-channel-bridge` 借鉴/拒绝的做法见 [`docs/BRIDGE-LESSONS.md`](docs/BRIDGE-LESSONS.md)。

## 迁移与回滚

如果机器上还运行着旧的 `lark-channel-bridge` 或另一个连接同一飞书应用的 bot：

```bash
# 先停旧服务，避免两个 WebSocket 客户端抢事件
systemctl --user disable --now <old-service>
```

回滚只需停掉 `agent-courier.service` 并重新启动旧服务；旧 bridge 的状态目录不会被本项目修改。

## 故障排查

**启动时报 `LARK_APP_ID is missing`**
：`.env` 不在项目根目录，或权限/内容不对。

**启动时报 `appserver.start_failed`**
：确认 `codex app-server --listen stdio://` 能正常启动，且 `codexBin` 可执行。

**`bot.connect_failed`**
：检查飞书开发者后台「事件订阅」是否选择长连接，应用是否启用机器人能力；确认没有第二个进程连着同一个 app。

**能连上但收不到消息**
：检查事件订阅是否包含 `im.message.receive_v1`；检查 `allowedDmUsers`；只支持私聊。

**回复不是流式卡片**
：应用可能缺少 CardKit 权限，SDK 会自动回退为普通 markdown；日志里会有 `stream.failed`。

**`app-server exited`**
：bot 会在下一条消息时自动重启 app-server，并通过 `thread/resume` 恢复；如果连续失败，手工运行：

```bash
codex app-server --listen stdio://
```

**想完全关闭流式**
：把 `config.json` 的 `replyMode` 改成 `final`，重启服务。
