# 子代理事件日志放大：定位、竞品对照与修复方案

- 日期：2026-10-27
- 状态：已修复，PR https://github.com/stepfun-ai/Step-Code/pull/314（基于 `main`）
- 关联：benchmark 反馈「95 个文件 127 GiB、单文件 P95 4.28 GiB、最大 11.7 GiB」并伴随 OOM

---

## 1. 现状

### 1.1 现象

用旧配置跑 benchmark 时，`/logs/agent/stepcode.jsonl` 体积相对旧单放大 86 倍，且相邻事件携带**逐字节相同**的子会话 `messages`：

```
type: tool_execution_update
toolName: subagent
event bytes: 2,845,152 -> 2,045,166
partialResult.details.results: 1 个子代理
messages compact UTF-8 bytes: 2,036,197 -> 2,036,197
messages SHA256: 完全相同
```

### 1.2 根因链路

一个前台 `subagent` 调用把子进程的**每一个事件**都变成一条**带完整子会话 transcript** 的持久化事件：

| 步骤 | 位置 | 行为 |
| --- | --- | --- |
| 1 | `features/step-subagent.ts:511-528` `parseJsonEvent` | 每个子进程事件（含每个流式 delta）**无条件**调用 `onUpdate` |
| 2 | `features/subagent/execute.ts:468-484` `emit` | 每次 `onUpdate` 都重建 `details`，`results[].messages = [...record.messages]` |
| 3 | `agent-core/src/agent-loop.ts:797-810` | 每个 `partialResult` 变成一条 `tool_execution_update` |
| 4 | `modes/print-mode.ts:181`、`modes/rpc/rpc-mode.ts:328` | 每条事件序列化成一行 JSONL 写 stdout（宿主重定向即 `stepcode.jsonl`） |

`messages` 只在 `message_end` 时变化（`step-subagent.ts:511-523`），而 `message_update` 只改 `activeText`/`activeTool*`。因此两次 `message_end` 之间成百上千次更新携带的是同一份数组。

一个旁证：`modes/json-event.ts` 早已对 `message_update` 做过「移除累积快照」的处理（注释写明 *Remove cumulative assistant snapshots from streaming wire events*），但 `tool_execution_update` 的累积快照没有做同样处理 —— 同类问题只修了一半。

### 1.3 本地复现（离线，不依赖 harbor、不依赖模型）

复现物在 `docs/research/2026-10-27-subagent-live-update-amplification/`：

- `child.mjs`：一个真实说话的 `--mode rpc` 子进程替身，按真实 LF 分帧输出 `message_start` / N × `message_update` / `message_end` / `tool_execution_start|update|end` / `agent_settled`。
- `repro.mts`：用真实 `AgentSession` + 真实 `step-subagent` 扩展 + 真实 `toJsonEvent`，把事件流按 `--mode json` 的方式写成 JSONL 并统计。

只有两处是替身（仓库测试策略本来就允许）：父模型用 faux provider（不联网），子进程只负责吐 token。**测量路径全程是生产代码**。

运行：

```bash
cd packages/coding-agent
node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
REPRO_TURNS=40 REPRO_DELTAS=150 REPRO_TOOL_BYTES=40000 \
  node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts
```

修复前（`main`）：

| 子会话规模 | 日志体积 | `tool_execution_update` 条数 | `messages` 占字节 | 单条最大 | 父进程 RSS |
| --- | --- | --- | --- | --- | --- |
| 20 轮 × 60 delta，20 KB 工具结果 | **268.05 MiB** | 1367 | 262.36 MiB（99.2%） | 0.42 MiB | 724 MiB |
| 40 轮 × 150 delta，40 KB 工具结果 | **4992.61 MiB** | 6327 | 4969.82 MiB（99.8%） | 1.63 MiB | 1333 MiB |

40 轮配置下：82 份不同的 `messages` 快照被写了 6327 次，6245 次是逐字节重复。**单条最大 1.63 MiB、单文件 GB 级**，与 benchmark 的 2.8 MB / 4.28 GiB 完全同量级。

### 1.4 内存侧的两个附加放大项（本次只降低增速，未消除）

- `agent-loop.ts:789-813` 把每次 update 的 emit promise 攒进数组，直到工具结束才 `await`。
- `modes/print-mode.ts` 的 stdout 写入是无上限 promise 串（`core/output-guard.ts:85-93`），背压只作用于 agent 事件发射，不会让工具停止产生 update。

两者叠加，读者慢时载荷会在内存里排队。修复后单条 update 从 MB 级降到 KB 级、频率从每 delta 降到 10 Hz，增长速度下降三到四个数量级，但**队列本身仍然无界**。严格的背压/内存上限需要单独处理（见 §4.5）。

---

## 2. 竞品实现

六个成熟实现的共同点：**流式增量和工具进度永不进入持久化层；子代理 transcript 永不进入父会话**。

| | 持久化形态 | delta 落盘 | 工具 progress 落盘 | 写入触发 | 单个工具结果上限 | 子代理历史 |
| --- | --- | --- | --- | --- | --- | --- |
| 类型级 ephemeral 的事件库 | SQLite 行级 upsert | 否，`ephemeral` 是互斥类型 | 否，progress 事件为 ephemeral | 文本块结束 / 工具结束 / step 结束 | 50 KiB + 外置文件 | 独立 session，父存 session id + 最终文本 |
| 事件策略过滤的 rollout | 每 thread 一个 JSONL | 否，transient 黑名单 | 否，输出 delta 为 transient | 完整 item 完成时 | 64 KiB 截断 + 1 MiB head/tail 缓冲 | 独立 thread，父存 thread id |
| 每 agent 一个事件日志 | `wire.jsonl` append | 否，`durable` 默认 false | 否，`observable` only | durable event，内容块在 step 结束时发 | 50k 字符 + spill 文件 | 独立 agent 日志，父存结果摘要 |
| 消息级 append 日志 | `messages.jsonl` append | 否，WS 层标为 volatile | 否，工具进度只走调试 trace | **message_end / tool_execution_end** | 64 KiB + artifact | 独立 child session，父存报告 |
| 压缩事件日志 | jsonl.zstd append | 否，流式帧标注 transient | 事件词表里没有 progress 类型 | turn/step 边界 + 200ms 批 | spill 64 MiB + head/tail | 独立 session，父存 childId + label |
| SQLite 行级 upsert | message/part 按主键覆盖 | 否，transient 事件类型集合 | 否，同上 | pending/running/completed 三次 upsert | 30 KB + artifact | 独立 session，父存 childSessionId + outputPath |

共同点（六个实现全部成立）：

1. **流式增量永不进入持久化层**。要么在类型上把「可重放」与「仅实时」做成互斥类型（`ephemeral` 没有 durable envelope，写错编译不过），要么在存储入口用显式 transient 黑名单过滤（工具实现无法「手滑」写入大对象）。
2. **持久化点是粗粒度生命周期**：一个内容块、一条完整消息、一次工具调用，绝不是一个 token。
3. **子代理 transcript 有独立落点**，父会话只保留 id + 摘要 + 输出路径。
4. **所有可能巨大的写入都有硬边界**：inline 上限（30 KB ~ 64 KiB）、超出外置文件、head/tail 缓冲、单文件上限。
5. **调试/诊断日志单独治理**：不跟随主会话日志无限放大（其中一处实现记录过「反复写完整 messages → 三角形重复 → GB 级文件 → V8 字符串分配阶段 native crash」，最终改为单文件 + 相对上一版 delta + 尾部保留 + 硬上限重置）。

**结论：这不是某个实现的小疏忽，而是三层约定同时被违反**——流式增量进了 durable 层、子代理 transcript 进了父会话、写侧没有上限。所以修复必须同时补这三层，只改其中一层都会留下复发路径。

---

## 3. 技术实现

### 3.1 方案选择

| 候选 | 判断 |
| --- | --- |
| A. 只在 `toJsonEvent` 剥掉 `partialResult.details.results[].messages` | 有效但只覆盖 CLI wire；web 分支 SSE 直接 `JSON.stringify(event)`，绕过 `toJsonEvent`；且 `modes/` 不该知道 subagent 的 details 结构 |
| B. 只在 `emit()` 去掉 `messages` | 消除 99% 字节，但仍按 delta 频率发 `activeText`（上限 50k 字符），长会话仍线性增长 |
| C. 在 `agent-loop` 对任意 `partialResult` 做深度截断 | 覆盖所有人，但通用深截断有破坏工具语义的风险（如 bash 的 `details.fullOutputPath`），爆炸半径不可控 |
| **D（选用）：源头有界投影 + 合流节流 + 终态预算，再加一个通用 wire 兜底** | 问题的三层各补一层；主修复在 payload 产生处，因此对所有宿主（CLI/TUI/web）同时生效；兜底只覆盖增量事件、语义安全 |

选择 D 的关键理由：**修复必须发生在 payload 的产生处**，而不是某个序列化出口。web 分支的 SSE 不走 `toJsonEvent`，任何「只在 wire 层修」的方案都会在 web 上复现同样的 OOM。

### 3.2 具体改动

**① 有界 live 投影**（`features/subagent/execute.ts`）

投影是**显式 allowlist**，不是 `{...record}` 打补丁：runner 的未知字段、chain 展开后的巨型 task、身份/路径字段都必须各自有边界。

```ts
function liveRecord(record) {
  return {
    agent: clipMiddle(record.agent, 200),
    task: clipMiddle(record.task, 600),      // chain 会把上一步完整输出插进来
    status: record.status,
    messages: [],                            // transcript 只随终态发布
    stderr: tailChars(record.stderr, 2_000),
    activeText: tailChars(record.activeText, 2_000),
    activeToolArgs: tailChars(record.activeToolArgs, 500),
    activeToolOutput: tailChars(record.activeToolOutput, 1_000),
    // model / sessionId / sessionFile / worktree* / lastEvent 同样有界
    usage: cloneUsage(record.usage),
  };
}
```

整个 roster 还受一个 **48 KiB / 次**的序列化字节预算约束：超出部分不发送，改为 `omittedResults: N`（`MAX_PARALLEL_TASKS` 允许 1000 个任务，完整 roster 是 O(N)）。后台 lane 侧按 index 合并，并按本次 update 自身的总数重算省略数：合并只能找回「曾经收到过」的记录，永远补不回「从未发布过」的尾部，所以不能清零；重算为 0 时也必须显式写回 `undefined`，否则外层展开会把旧计数留下来重复计算。

**② 合流节流**：`LIVE_UPDATE_INTERVAL_MS = 100`（与既有 `BASH_UPDATE_THROTTLE_MS` 一致）。

- **所有**更新（含 queued → running → completed 状态跃迁）都进入同一个 100 ms 窗口，最新记录胜出。
  最初版本让状态跃迁立即发布，评审实测出后果：parallel 下每个任务 2 次跃迁 × 每次重发整个 roster = **O(N²)**，600 个任务在一次调用里写出 530 MiB。这与本次要消灭的放大是同一类。
- 代价是状态在列表里最多晚 100 ms，远低于人眼可辨阈值；调用返回前 `flushEmit` 强制刷出终态。
- `flushEmit` 位于 dispatch 之外：先 flush、再按「dispatch 错误优先」的顺序抛出，因此消费者异常不会覆盖真实失败原因。

**③ 终态投影**：终态 details 同样是展示投影，不是原始数据的拷贝。

- `messages` 只保留最新的、序列化后总量 ≤ 64 KiB 的消息（大小为选值，不与仓库既有的 50 KiB 文本上限混同）；被裁剪时置 `messagesTruncated: true`。
- 全部 record 共享一个 **256 KiB / 次调用**的重字段预算（文本 + transcript），按记录顺序消费；放不下的字段直接省略而不是原样保留。小型元数据（agent/status/usage/id）按记录单独有界，总量是 `256 KiB + O(tasks)`，与子会话输出长度无关。`activeText` 单条 ≤ 50,000 字符（与渲染端一致，不缩小 Ctrl+O 展开视图）、`task` ≤ 2,000 字符、`stderr` / `errorMessage` ≤ 2,000 字符、`cancelledPrompts` ≤ 20 条 × 200 字符。
- `activeText` 缺失时由**完整 transcript** 的最终 assistant 文本回填，因此「单条消息超出预算导致 messages 为空」不会让结果渲染成 `(no output)`。
- 模型可见的 `content` 不受这些限制，仍走既有的 50 KiB / 2,000 行 tool-output retention；完整 transcript 留在子会话（`sessionId` / `sessionFile`）。

**④ 通用 wire 兜底**（`modes/json-event.ts`）：单条 `tool_execution_update` 超过 **256 KiB 序列化字节**时，保留文本尾部 + `[live output truncated]` 标记，丢弃 `details`/`args`（它们已分别存在于 `tool_execution_start` / `tool_execution_end`）。**终态事件永不裁剪**。

- 上限按**序列化后**的字节计：控制字符与孤立 surrogate 会变成 6 字节转义，按字符数计会低估 6 倍。
- 循环每轮严格缩短（`>= 1` 时直接清空），并且对 `toolCallId` / `toolName` 也设上限 —— 否则信封本身超限时循环无法收敛（这是评审抓到的死循环）。
- 契约变更已同步到 `docs/json.md`、`docs/rpc.md`，并注明只影响 stdout 投影、不影响扩展 handler。

**⑤ 文档**：`packages/coding-agent/docs/tool-output-retention.md` 新增 *Live tool updates* 一节，说明「最终结果上限」与「直播上限」是两套独立的边界。

### 3.3 修复后（同一复现脚本）

| 子会话规模 | 修复前 | 修复后 | 降幅 |
| --- | --- | --- | --- |
| 20 轮 × 60 delta，20 KB 工具结果 | 268.05 MiB | **0.32 MiB** | 837× |
| 40 轮 × 150 delta，40 KB 工具结果 | 4992.61 MiB | **0.22 MiB** | 22693× |

`tool_execution_update` 条数 6327 → 3（本次假子进程瞬时吐完；真实流式按 10 Hz 产出）。父进程峰值 RSS 1333 MiB → 271 MiB。

剩余体积构成：终态 tool result（共享 256 KiB 预算）被约 5 类事件各回显一次（`tool_execution_end`、工具结果的 `message_end`、`turn_end`、`agent_end`），因此单次调用约 5 × 100 KiB。**上界由预算决定，与子会话长度无关**（20 轮 0.32 MiB，40 轮 0.22 MiB）。

parallel 批量（200 任务）回归：发布次数 < 60，单条 < 128 KiB，总量 < 2 MiB；修复前同一场景是 O(N²)。

---

## 4. 影响范围

### 4.1 代码面

| 模块 | 影响 |
| --- | --- |
| 前台 `subagent` 调用 | 直播更新变少（≤10 Hz）、载荷有界；终态 details 的 `messages` 可能被裁剪到 ≤64 KiB |
| 后台 lane | 走同一个 `emit`，同样受益；lane 自己的 15 s 进度通知节流不变 |
| TUI 渲染 | summary 只渲染最后 8 行、widget 只渲染状态 + token 数，均仍在投影内；历史展开优先用 `activeText`，仍能显示最终输出 |
| `--mode json` / `--mode rpc` | 增量事件更少更小；单条增量另有 256 KiB 序列化字节兜底（超限时丢弃 `args`/`details` 并保留文本尾部）；终态事件的 details 是限量投影 |
| web（`apps/web`，不在 main 上） | 因修复在 payload 源头，SSE 路径自动受益；不需要额外改动 |
| 其他工具 | bash 已有 100 ms 节流 + 50 KiB 滚动快照，低于 256 KiB 兜底阈值，行为不变 |

### 4.2 行为兼容性

- **不改变** `subagent` 工具对模型可见的 `content` 文本（由未裁剪的内部 records 生成）。
- 状态机的**终态**语义不变：每个任务最终都会到达 completed/failed/aborted，并在调用返回前刷出。
- **变化**：短于 100 ms 的状态跃迁（典型如瞬时完成的测试替身）可能不出现在 wire 上。真实子代理是秒级，不受影响；这是消除 parallel 下 O(N²) 的必要代价。
- 直播期间的 `activeText` 从最多 50k 字符变为 2k 尾部，工具入参/输出也从完整值变为尾部：这是**刻意的可见降级**（progress 是可合并快照，不是完整事件历史）。
- 可观测契约变化：`StepSubagentDetails.results[].messages` 从「全量」变为「终态限量」并新增可选 `messagesTruncated`；直播字段变为有界尾部。消费方（TUI 展开、历史渲染、web 子代理卡片）只用最后一个 assistant 文本或状态字段，已逐一核对。
- 定时器在返回前关闭（`closeEmitter`），调用返回后的迟到回调不再发布；`onUpdate` 抛错不再从定时器逃逸成未捕获异常，而是按「dispatch 错误优先」的顺序在调用路径上抛出。
- `mapWithConcurrency` 改为等待所有 worker 结束（`allSettled`）再返回，避免 fail-fast 提前返回后仍有 lane 对着已关闭的 emitter 继续工作。

### 4.3 测试与验证

新增（21 个用例）：

- `test/subagent-live-update-rpc.test.ts` —— **端到端**：真起 `--mode rpc` 子进程，走真实 rpc-adapter → parseJsonEvent → 编排 → Agent Loop → toJsonEvent。断言整条父日志 < 1 MiB、update 数 < 60、无一条 update 携带 messages、终态 messages ≤ 64 KiB；并用 300 KB 最终答复验证展示投影有界而模型可见 `content` 仍完整。
- `test/subagent-live-update-budget.test.ts`
  - 400 次携带增长 transcript 的 update：live 一律 `messages: []`、单条 < 32 KiB、总量 < 2 MiB；
  - chain 把上一步 500 KB 输出插入下一步 task，所有 update 仍 < 32 KiB、`task` ≤ 600 字符；
  - 200 次 delta 只产生 ≤ 6 次发布；
  - 200 个并行任务的批量调用：发布 < 60 次、单条 < 128 KiB、总量 < 2 MiB、出现 `omittedResults`；
  - 后台 lane 运行 200 任务：每次发布的头部都报告真实总数（`/200 complete`），省略项显示为「not shown」而不是 failed；
  - `rosterFields` 单测：完整 roster 收到一个「1 条 + 省略 2」的裁剪更新后，合并结果仍是 3 条且省略数归零（历史 bug：会报 5）；
  - 终态预算：保留最新消息、序列化数组 ≤ 64 KiB、`messagesTruncated: true`；
  - 单条消息超预算且无 `activeText` 时，仍从完整 transcript 回填可渲染文本；
  - 400 KB 最终答复在展示投影里被压到 ≤ 50,000 字符；
  - 60 个任务各带 300 KB 答复：终态 details ≤ 256 KiB + O(tasks)（覆盖「预算耗尽后 allowance 为 0」这条路径）；
  - 调用返回后的迟到回调不再发布；
  - `onUpdate` 抛错以调用失败的形式浮出，而不是从定时器逃逸。
- `test/json-event-live-update-budget.test.ts`
  - 未超限原样透传；4 MiB update 被裁剪到 ≤ 256 KiB 且带标记；
  - 控制字符 / 引号反斜杠 / 多字节 CJK / 孤立 surrogate 各 300k 次重复，仍 ≤ 256 KiB（按序列化字节而非字符计数）；
  - 略超预算时保留尽量多的尾部；`tool_execution_end` 永不被裁剪。

回归：

- `packages/coding-agent` 全量：5003 passed / 58 skipped。唯一稳定失败是 6 个 `completion-check-cli` 用例，**在未改动的 `main` 上以完全相同的方式失败**（本机 git worktree 前置条件问题，与本改动无关）；`subagent-invocation` 的 CLI 启动用例偶发超时，单跑必过（该文件注释已记录此既有偶发）。
- `pnpm run check` 全绿（biome / 边界检查 / `tsgo --noEmit` / browser smoke）。
- `git diff --check` 干净。

### 4.4 风险与回滚

| 风险 | 控件 |
| --- | --- |
| 直播更新过少导致 UI 卡顿感 | 100 ms 与 bash 既有节流一致，token 计数 10 Hz 足够；终态由返回前的 flush 保证 |
| 终态 `messages` 裁剪影响历史渲染 | 渲染优先 `activeText`；`sessionId`/`sessionFile` 指向子进程完整 transcript |
| 兜底误伤正常流式工具 | 阈值 256 KiB，远高于 bash 的 50 KiB；新增测试锁定「未超限原样透传」 |
| 合流定时器泄漏/迟到投递 | 返回前 `closeEmitter` + `flushEmit`（在 dispatch 之外，dispatch 错误优先）；`unref()` |
| 后续 web 分支合并冲突 | 改动集中在 `emit` 与 dispatch 外层（`try/finally`）；web 分支改的是 `runOne` 内部与 `sessionId` 传递，冲突面小 |

回滚：分支上三个 commit（初版 + 两轮评审修正），逐个 `git revert` 即恢复原行为，无数据迁移、无配置项。

### 4.5 后续（未纳入本 PR）

1. **终态回显放大**：一次调用的终态 details 会被约 5 类事件各带一份（≈5 × 100 KiB）。要压缩需要改消息级事件形状，与本次「最小爆炸半径」目标冲突，建议单独立项。
2. **内存队列仍无界**：`agent-loop` 的 update promise 数组与 `output-guard` 的 stdout promise 串都没有上限。本 PR 只降低了增长速度，慢读者场景需要单独做背压或队列上限。
3. **wire 兜底丢弃非文本 content**：超限的 update 只保留 text part，图片预览会丢；终态不受影响。第三方工具若在小体积 update 里带图需要另行处理。
4. **web SSE 兜底**：web 分支的 SSE 直接转发 session event，未经过 `toJsonEvent`。当前源头已收敛，但建议在该分支 rebase 后补一条同等的回归测试。
5. **类型级约束**：成熟实现的做法是给会话事件加 `durable`/`ephemeral` 分类，让「增量不可落盘」成为编译期约束，而不是靠 review 和上限兜底。这是架构级改动，值得单独立项。

---

## 附：复现/验证命令

```bash
# 复现（修复前后都可跑，用于对比）
cd packages/coding-agent
node --import tsx ../../docs/research/2026-10-27-subagent-live-update-amplification/repro.mts

# 回归测试
npx vitest --run test/subagent-live-update-budget.test.ts test/json-event-live-update-budget.test.ts

# 全量检查
pnpm run check
```
