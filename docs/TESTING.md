# 测试与内存验证

本目录的测试分为四层：单元、黑盒集成、真实 Codex、内存/浸泡。默认套件不访问飞书网络，使用假 Channel SDK 和假 Codex 可执行文件；真实飞书消息需要人工发一条。当前共 112 个用例：110 pass，2 skipped（两个真实 Codex 用例，需 `RUN_REAL_CODEX=1`；其中隔离用例还需要 `bubblewrap`）。

## 运行

```bash
cd ~/.local/share/agent-courier

npm test                 # 单元 + 集成 + 内存（约 45–50s）
npm run test:unit        # 纯函数、队列、配置、日志、缓存、锁、Codex runner
npm run test:integration # 假飞书通道 + 假 Codex 的进程级测试
npm run test:memory      # 空闲稳定性 + 60 次大输出浸泡

RUN_REAL_CODEX=1 npm test # 额外跑真实 Codex（会产生少量 token）
```

真实 Codex 测试默认使用 PATH 中的 `codex`，可用 `CODEX_BIN` 指定；隔离测试可用 `BWRAP_BIN` 指定 bubblewrap。

单个用例：

```bash
node --test --test-concurrency=1 test/unit/codex.test.mjs
node --test --test-concurrency=1 --test-name-pattern="grandchild" test/unit/codex.test.mjs
```

## 测试替身

- `test/helpers/fake-channel.mjs`：实现 `@larksuite/channel` 的最小接口（`on/connect/stream/reply/send/addReaction/removeReaction/getBotIdentity/disconnect`），把调用写成 JSONL，可按场景定时注入消息、模拟流失败、内容更新失败、BE 延迟、回复失败。
- `test/helpers/mock-codex.mjs`：可执行的假 `codex exec`，读取 stdin prompt，输出 JSONL；支持大输出、慢任务、卡死、无终止事件、turn.failed、缺失 thread、`turn.completed` 后赖着不退、孙进程继承 stdout、忽略 SIGTERM 等模式。
- `test/helpers/harness.mjs`：为每个用例生成临时项目（复制 `src`、假 channel、假 codex、`.env`、`config.json`），启动真实 `src/bot.mjs` 子进程，轮询 JSONL 日志，采样 `/proc/<pid>/status`、`smaps_rollup`，并通过 `SIGUSR1` 强制 GC、`SIGUSR2` 生成 Node diagnostic report。

这样测试的是**真实的 bot 进程和真实的模块边界**，不是把 `bot.mjs` 里的逻辑复制到测试里。

## 覆盖矩阵

| 领域 | 用例 |
|---|---|
| 访问控制 | owner DM、群 @、未 @、非白名单群、非白名单用户、bot 发送者、`requireMention:false` |
| 命令 | `/help`、`/status`、`/new`、`/reset`、`/stop`（空闲/运行中）、`/cd`（合法/越界/symlink 逃逸）、未知命令、空消息 |
| 队列 | 单 scope 串行、全局并发上限 2、队列满 20、排队提示、任务 TTL 过期、权限二次校验 |
| 生命周期 | `/stop` 中断、`/new` 中断并清 thread、SIGTERM 关停、子进程 SIGTERM/SIGKILL、单实例锁 |
| Codex JSONL | thread.started、agent_message 累积/快照去重、工具开始/完成、大输出截断、未知事件、终止后事件锁存、无 terminal 失败、resume、缺失 rollout、turn.failed、非零退出、stderr 尾部、abort、timeout、spawn 失败 |
| 流式回复 | 流创建失败回退、`setContent` 失败回退、26k 卡片上限、剩余内容分片发送、reaction 延迟不阻塞、reaction 失败 |
| 持久化 | seed、原子写、600 权限、损坏 JSON、thread 清空、cwd 更新、maxEntries/TTL 剪枝 |
| 日志 | key 级和值级脱敏（Bearer/app_secret/token）、4096 截断、轮转、600 权限 |
| 安全 | 子进程不继承 `LARK_APP_SECRET`、cwd realpath、symlink 拒绝、单实例锁、bwrap 隐藏目录/文件 |
| 隔离 | `codexIsolation` 隐藏目录后 `readdir` 为空、隐藏普通文件后不可读；bot 集成层确认 `codex.spawn.isolated=true` |
| 真实 Codex | `RUN_REAL_CODEX=1`：消息 → bot → 真实 `codex exec` → 假通道流式回复；隔离用例让真实 Codex 探测隐藏文件，只能得到 `HIDDEN` |

## 内存测量

已安装：`smem`、`heaptrack`、`valgrind`、`sysstat`（`pidstat`）、`strace`、`lsof`、`jq`、`python3-psutil`。

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

`heaptrack` 统计的是 native 分配；V8 的 JS 堆以 diagnostic report 为准。两者结合可以区分“JS 对象泄漏”和“native/分配器保留”。

## 参考实测结果

| 场景 | 结果 |
|---|---|
| 假通道 bot 空闲 8s | RSS 51.3 → 52.0 MB；PSS 17.8 → 18.4 MB；heap 4.78 → 4.77 MB |
| 60 次大输出（每轮 10×100KB 工具输出 + 20KB 答案） | 批次 A/B/C：RSS 74.2 / 96.1 / 93.1 MB；PSS 36.0 / 57.8 / 54.8 MB；heap 5.58 / 5.61 / 5.68 MB |
| 批次 B→C | RSS −3.0 MB，PSS −3.0 MB，JS heap +67 KB（平台期，RSS 随分配器回收波动） |
| 空闲的 bot | RSS ~106 MB；systemd MemoryCurrent 56–71 MB |
| heaptrack 压力脚本 | 39,690 次分配，peak heap 4.23 MB，泄漏 22.12 KB / 41 次分配 |
| 真实 Codex 端到端 | 4.6–6.2s 通过，流式回复 `E2E_OK` |
| 真实 Codex + bwrap | 读取 bot 的 `.env` 失败，只返回 `HIDDEN`；配置中已存在的路径会被隐藏 |

内存采样会在最后一条 `run.end` 之后再触发最多 3 次强制 GC，取最小的 `heapUsed`，避免把尚未回收的瞬时对象误判为泄漏；RSS/PSS 取最后一次采样。

## 进程隔离验证

`codexIsolation.enabled=true` 时，Codex 通过 bubblewrap 启动：

```text
bwrap --die-with-parent --unshare-pid --dev-bind / / --proc /proc
      --tmpfs <目录> | --ro-bind /dev/null <普通文件>
      -- codex exec ...
```

- 目录用 `--tmpfs` 覆盖；普通文件（例如 `~/.npmrc`）用 `--ro-bind /dev/null` 覆盖。早期实现只支持目录，探测时 `bwrap` 报 `Can't mkdir ~/.npmrc: Not a directory`，已修复并有单测。
- 套件覆盖：单元层同时验证隐藏目录和隐藏文件；bot 集成层验证 `codex.spawn.isolated=true` 且 `readdir` 为空；真实 Codex 层用 `test -f` 探测隐藏文件，只能得到 `HIDDEN`。
- 示例配置可隐藏：bot 目录、`~/.ssh`、`~/.gnupg`、`~/.aws`、`~/.azure`、`~/.kube`、`~/.docker`、`~/.netrc`、`~/.git-credentials`、`~/.npmrc`；不存在的路径自动跳过。
- 残余风险：`~/.codex/auth.json` 必须对 Codex 可读，否则无法调用模型；被提示注入的任务理论上仍可打印它。要彻底隔离需要独立 UID/容器或 `--tmpfs ~/.codex` + 注入临时凭据。

结论：JS 堆在 60 轮后基本不变；RSS 的增长来自 V8/分配器的容量保留，第二、三批已明显收敛。长期运行的服务额外加了 `--max-old-space-size=256`，即使出现异常增长也会先触发 OOM 重启，而不是顶满宿主内存。

## 仍需人工验证的飞书项

自动化测试用假 channel 覆盖了处理逻辑，但以下需要真实飞书应用/账号：

1. 私聊 bot 发「你好」→ 收到流式卡片。
2. 群里 @bot → 回复；不 @ → 不回复。
3. `/status` 显示 thread/cwd；`/new` 后 thread 变化；`/stop` 中断长任务。
4. 长答案（>26k）→ 卡片只保留前 26k，剩余内容以普通消息分片送达。
5. 应用缺少 CardKit 权限时 → 自动回退普通 markdown（日志 `stream.failed`）。
6. 断网/恢复后 → `channel.reconnecting`/`channel.reconnected`，bot 仍能收消息。
7. 发送图片/文件 → 当前明确不转发（文本-only）。

## 已知限制

- 只处理文本；`msg.resources` 不下载、不传给 Codex。
- 卡片流最多显示 26k 字符；超出部分由 `sendLong` 以 3k 分片、250ms 间隔发送，总计最多 101k，超出截断。
- `maxConcurrentRuns=2` 时，同一 `cwd` 的两个不同 scope 可以并行；如需绝对串行，改成 1。
- `/stop` 和 `/new` 会清空该 scope 的排队消息，不逐条回复。
- SDK 流更新失败计数是进程级的；多 scope 并发时可能误判并回退为普通消息。
- 真实飞书 inbound 无法在无人值守下自动触发；需要用户发一条消息。
