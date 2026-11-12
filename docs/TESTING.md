# 测试与内存验证

测试分为四层：单元、黑盒集成、真实 Codex、内存/浸泡。默认套件不访问飞书网络，使用假 Channel SDK 和假 app-server。

## 运行

```bash
cd ~/.local/share/agent-courier

npm test                 # 单元 + 集成 + 内存
npm run test:unit        # 配置、会话、日志、缓存、锁、app-server runner
npm run test:integration # 假飞书通道 + 假 app-server 的进程级测试
npm run test:memory      # 空闲稳定性 + 60 个 turn 的浸泡

RUN_REAL_CODEX=1 npm test # 额外跑真实 Codex app-server（会产生少量 token）
```

单个用例：

```bash
node --test --test-concurrency=1 test/unit/codex.test.mjs
node --test --test-concurrency=1 --test-name-pattern="steer" test/integration/conversation.test.mjs
```

## 测试替身

- `test/helpers/fake-channel.mjs`：实现 `@larksuite/channel` 的最小接口，把调用写成 JSONL，可按场景定时注入消息、模拟流失败/内容更新失败/回复失败。
- `test/helpers/mock-app-server.mjs`：可执行的假 `codex app-server`，说 JSON-RPC over JSONL；支持 `thread/start`、`thread/resume`、`turn/start`、`turn/steer`、`turn/interrupt`，以及大输出、慢任务、失败 turn、缺失 rollout、未知事件等模式。
- `test/helpers/harness.mjs`：为每个用例生成临时项目（复制 `src`、假 channel、假 app-server、`.env`、`config.json`），启动真实 `src/bot.mjs` 子进程，轮询 JSONL 日志，采样 `/proc/<pid>/status`、`smaps_rollup`，并通过 `SIGUSR1` 强制 GC、`SIGUSR2` 生成 diagnostic report。

这样测试的是**真实的 bot 进程、真实的 app-server 协议边界**，不是把逻辑复制到测试里。

## 覆盖矩阵

| 领域 | 用例 |
|---|---|
| 访问控制 | owner 私聊、未知发送者、bot 发送者、群聊忽略、@all 忽略 |
| 会话 | 第一条消息创建 thread、后续 turn 复用同一 thread、插件重启后 resume |
| 忙时 | 当前 turn 活跃时新消息通过 `turn/steer` 注入；不新建 turn |
| 命令 | `/help`、`/status`、`/new`、`/reset`、`/stop`（空闲/运行中）、`/cd`（合法/越界/symlink 逃逸）、未知命令、空消息 |
| 生命周期 | `/stop` 中断、`/new` 中断并清 thread、SIGTERM 关停、单实例锁 |
| app-server | 初始化、thread/start、thread/resume、turn/start、turn/steer、turn/interrupt、turn.failed、缺失 rollout、异常退出、未知事件 |
| 流式回复 | 流创建失败回退、`setContent` 失败回退、26k 卡片上限、剩余内容分片发送 |
| 持久化 | seed、原子写、600 权限、损坏 JSON、thread 清空、cwd 更新、maxEntries/TTL 剪枝 |
| 日志 | key 级和值级脱敏（Bearer/app_secret/token）、4096 截断、轮转、600 权限 |
| 真实 Codex | `RUN_REAL_CODEX=1`：私聊 → bot → 真实 `codex app-server` → 假通道流式回复；第二条消息复用同一 thread |

## 内存测量

### Node 层

- `--expose-gc` + `SIGUSR1`：测试钩子强制 GC（仅 `BOT_TEST_GC=1` 时注册）。
- `--report-on-signal --report-signal=SIGUSR2`：生成 diagnostic report，读取 `javascriptHeap.memoryUsage.heapUsed`。
- `/proc/<pid>/status` 的 `VmRSS`/`VmHWM`，`/proc/<pid>/smaps_rollup` 的 `Pss`。
- 长期运行的服务：`systemctl --user show agent-courier.service -p MemoryCurrent -p MemoryPeak`。

### 系统层

```bash
smem -P node -c "pid user command rss pss uss"
pidstat -r -p <pid> 1 10
heaptrack -o /tmp/heaptrack-bot node --expose-gc test/tools/heap-stress.mjs
heaptrack_print /tmp/heaptrack-bot.gz | tail -40
```

`heaptrack` 统计 native 分配；V8 的 JS 堆以 diagnostic report 为准。

## 参考实测结果

| 场景 | 结果 |
|---|---|
| 假通道 bot 空闲 8s | RSS 51.8 → 52.5 MB；heap 4.91 → 4.90 MB |
| 60 个 turn（每轮 10×100KB 工具输出 + 20KB 答案） | 批次 A/B/C：RSS 70.2 / 78.3 / 78.8 MB；heap 5.37 / 5.36 / 5.36 MB |
| 真实 Codex 单轮 | 约 5s 完成，流式 `E2E_OK` |
| 真实 Codex 两次消息 | 约 12s，第二条复用同一 thread |

结论：JS 堆在 60 个 turn 后基本不变；RSS 增长来自 V8/分配器容量保留，第二、三批已收敛。bot 不再为每条消息创建进程，Codex 的常驻 app-server 单独占用内存。

内存采样会在最后一条 `run.end` 之后再触发最多 3 次强制 GC，取最小的 `heapUsed`；RSS/PSS 取最后一次采样。

## 仍需人工验证的飞书项

自动化测试用假 channel 覆盖了处理逻辑，但以下需要真实飞书应用/账号：

1. 私聊 bot 发「你好」→ 收到流式卡片。
2. 连续发两条消息，第二条在第一条执行中被 steer 到同一 turn。
3. `/status` 显示 thread/cwd/app-server/turn；`/new` 后 thread 变化；`/stop` 中断长任务。
4. 长答案（>26k）→ 卡片只保留前 26k，剩余内容以普通消息分片送达。
5. 应用缺少 CardKit 权限时 → 自动回退普通 markdown（日志 `stream.failed`）。
6. 断网/恢复后 → `channel.reconnecting`/`channel.reconnected`，bot 仍能收消息。
7. 发送图片/文件 → 当前明确不转发（文本-only）。

## 已知限制

- 只处理文本；`msg.resources` 不下载、不传给 Codex。
- 只支持 owner 私聊；群聊消息忽略。
- 只有一个 thread；`/new` 才会换新会话。
- 卡片流最多显示 26k 字符；超出部分由 `sendLong` 以 3k 分片、250ms 间隔发送，总计最多 101k。
- 没有总超时；卡死时用 `/stop` 人工中断。
- `codex app-server` 目前是 experimental，升级 Codex 后需要跑真实集成测试。
