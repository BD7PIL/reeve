# `@bd7pil/reeve` — REEVE 编排层（opencode v2 插件）

> **In English:** this package is the whole REEVE system for opencode v2: eight
> agent definitions, the review skill, the task ledger with concurrency gates,
> wall-clock supervision and cross-restart reconciliation, the self-hosted
> Bifrost proxy with chain hot-reload, and performance stats. It fills the
> gaps v2 leaves open (`task_status`, silent child death, concurrency limits,
> timeouts) without ever writing `agents.*.model` — that key belongs to
> openchamber. Install with `{ "model": "reeve/pro", "plugins":
> ["@bd7pil/reeve"] }` and nothing else needs to live in the config directory.
> The rest of this document is the detailed Chinese reference.

包里就是**整个系统**：8 个 agent + review skill + 记账/闸门/墙钟/对账 + 代理自持（Bifrost 链热更）+ 性能统计。
配置目录里不需要放任何 REEVE 文件——装插件、写两行配置即可（见下「安装」）。

v2 原生缺的那几条，全靠这个插件补齐：

| # | v2 原生缺什么 | 本插件怎么补 |
|---|---|---|
| 1 | 没有 `task_status`（v2 删了）→ 无法查在飞任务 | 注册 `reeve_task_status` 工具（只读） |
| 2 | **没有停止任务恢复** → 子任务静默死掉，父 agent 永远不知道 | 终态判定门 + 静默宽限（`terminal-gate.js`） |
| 3 | 没有周期性 orchestrator 唤醒 | 惰性对账挂 `session.hook("prompt")` |
| 4 | 没有 `task_message` / `task_cancel` / `task_revive` | （未实现，按需再加） |
| 5 | 没有 `todo` 工具 | prompt 约定（在 `agents/` 里） |
| 6 | 没有并发上限 | 准入闸门（`concurrency.js`） |
| 7 | 没有墙钟超时 | 监督器（`supervisor.js`） |
| 8 | 没有 orchestrator prompt 与调度纪律 | 不在本插件（在 `agents/`） |

**铁律：本插件绝不写 `agents.*.model`。** 那是与 openchamber 面板抢配置
（openchamber#3881：面板保存 agent 会静默压掉预设）。插件只注册工具 + 挂 hook。

---

## 六处挂载点

| # | 挂载点 | 文件 |
|---|---|---|
| ① | 拦 `subagent`（**并发闸门，子会话创建之前**）：`ctx.tool.hook("execute.before")` | `src/index.js` |
| ② | 落台账：`ctx.tool.hook("execute.after")` → 解析结构化 `sessionID` | `src/index.js` + `src/ledger.js` |
| ③ | 认终态：`ctx.event.subscribe()` → `session.execution.*` | `src/index.js` |
| ④ | 墙钟：每任务一次性定时器 → 宽限 → **恰好一次** `ctx.session.interrupt({resume:false})` | `src/supervisor.js` |
| ⑤ | 落盘 + 对账：`ctx.storage` + `ctx.session.hook("prompt")` | `src/ledger.js` + `src/reconcile.js` |
| ⑥ | **补名册**：`ctx.session.hook("context")` → 把 subagent 名册接进 `subagent` 工具描述 | `src/roster.js` + `src/index.js` |

**另有可选的「代理自持 + 运行时注册 + 链热更 + 性能统计」**（不是钩子，是 opt-in 的服务管理、注册与取数）：
插件还会注册三个档位模型、把内置 agent 藏起来、设默认 agent —— 所以引擎配置里**不用写** `models` / `agents` / `default_agent`。
`options.proxy.enabled` 打开后，
插件自己完成 取件 → 派生链 → 拉起/复用 → 等就绪 → 收敛 → 守护，**不需要任何外部脚本**（见 `src/proxy.js` 与 PROGRESS §6.6）。
二进制**按平台 pin**（`BIFROST_PINS`：`linux-x64` / `win32-x64`，各带版本化 URL + sha256 + size）；
没 pin 的平台这一层显式报不可用、不装（插件其余部分照常）。给装配器读的 `provision.json`
工件与 linux 那份 pin 由单测绑定防漂移。

其中两件事在这里展开（都由面板里的可视化编辑/统计触发，见 PROGRESS §6.11）：

- **链热更**（`src/chain.js` + `src/proxy.js`）：链的唯一可编辑输入是 `~/.reeve/chain.json`（面板写、插件读）。
  守护里有一个 **5 秒只 stat 一次**的 tick（`chainWatchMs`）——文件变了就重新派生 `governance.routing_rules`、
  写回自持的 config.json、用 `/api/routing/rules` 热更并**复核**（复核过了才更新 `appliedAt`）。
  缺文件回落链基座；**坏文件当作"未变更"**（保留上一份好的，不把线上路由翻回基座）。
- **性能统计**（`src/stats.js`）：`GET /api/logs`（带插件自己写的 setup token）→ 按档位 / provider / 回退 / 延迟聚合；
  编排侧从台账聚合（每 agent 的 p50/p95、超时、对账、在飞、排队）。60 秒一轮，用"总数 + 最新 id"当指纹省掉没必要的抓取；
  模型目录（`/v1/models`）**30 分钟**才探一次（它是真去上游的探测，会被代理记进日志）。
  两条实测口径写在 `stats.js` 头注释里：**`model` 为空的行是模型发现探测、不是调用**；**status 有三态**
  （`success` / `error` / `cancelled`，cancelled 不算失败）。

**⑥ 为什么需要**：REEVE 的 7 个 subagent 都标了 `hidden: true`（人在前台看不到、也不能用 `@` 直接找它们说话），
而 v2 会把 hidden 的 agent **从 `subagent` 工具的"可用 subagent"宣传段里滤掉**（它只列 `!agent.hidden`；
`packages/core/src/tool/plugin/subagent.ts`）。于是由本插件把名册**补回工具描述**：人看不见、模型看得见。
幂等（按标记去重）；注入事实与"引擎内部读到的 agent 表"一起进快照（`agentTable` / `roster`）。

> ⚠️ **验 agent 可见性别用 `opencode debug agents`**：它连的是 CLI 自己的 managed service
> （端口来自 `service.json`，默认 `0xC0DE`），实测会**连到另一个 HOME 的引擎**、报出别人的表。
> 本插件在第一次 `context` 钩子时（所有 `agent.transform` 都已应用）从引擎内部读一次，落进快照。

---

## 三条正确性性质（都写成了测试）

1. **终态单调**：已发布的硬超时**不可被迟到的完成/忙碌覆盖**（`Ledger.commitTerminal`）。
2. **墓碑不复活**：跨重启对账发现子会话不存在 → 墓碑 + 拆除，**不留永远在跑的幽灵**。
3. **嵌套不自死锁**：嵌套的受管任务在并发闸门里**豁免**（它已持槽，再等会自死锁）。

另外：**静默死亡的宽限**（`STOP_CONFIRMATION_GRACE_MS = 5_000`）是防"把正常完成的子任务
误报成死亡"的唯一手段——`session.idle` 只是候选，转录判定 `absent` **且**静默超宽限才落 `stopped`。

---

## 安装

插件目录必须**在目录根有入口文件**（实测：`package.json` 的 `main` 指向子目录时 loader 不认）。

v2 的 `plugins` 条目会过一遍 `npm-package-arg`（`packages/util/src/npm.ts`）——**包名 / 版本 / tag / git spec / 绝对路径都在支持范围**，
包名形态由引擎自己装进它的全局 npm 缓存。两种常用装法：

```jsonc
// ① 从 registry 装（推荐；引擎自动取件，机器上不需要检出）
{ "plugins": ["@bd7pil/reeve"] }

// ② 本地目录（开发用；绝对路径，**Windows 上必须用正斜杠**）
{ "plugins": ["D:/path/to/reeve/plugin"] }
```

一个完整的最小配置：

```jsonc
// $HOME/.config/opencode/opencode.json
{
  "model": "reeve/pro",                     // 别删：裸 run 用的是客户端默认模型，会静默绕过档位（§6.11）
  "plugins": ["@bd7pil/reeve"],
  "providers": {
    "reeve": {
      "package": "@ai-sdk/openai-compatible",   // ⚠️ 必须原生复数 providers 形态，
      "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "{env:BIFROST_KEY}" },
      "models": {
        "flash":      { "modelID": "reeve/flash" },
        "pro":        { "modelID": "reeve/pro" },
        "multimodal": { "modelID": "reeve/multimodal" }
      }
    }
  }
}
```

配置项（插件 options）：

```jsonc
{
  "plugins": [
    { "package": "D:/path/to/reeve/plugin",
      "options": {
        "wallClockMs": 1800000,                       // 墙钟上限；0/缺省 = 不掐
        "abortGraceMs": 10000,                        // 发出中断后等确认的宽限
        "retentionDays": 30,                          // 台账保留期：只清已落终态的旧记录；0 = 不清
        "limits": { "default": 8, "providers": {}, "models": {} },   // 0 = 无限
        "snapshotPath": "~/.local/share/opencode/reeve/ledger.json"  // 可选：给控制台面板读的**只读快照**
      } }
  ]
}
```

> ⚠️ **`limits.default` 缺省是 0 = 无限**。使用者实测峰值是**一个父会话约 88 个并发子任务**——
> 无上限是失控风险。**建议显式设一个值**（例如 `"default": 8`），
> 超限时是**排队**不是失败。

### `snapshotPath`：给控制台看的只读投影（可选）

设了就每 250 ms（变更驱动、合并写入、原子 rename）把台账导出成一份 JSON：

```jsonc
{ "generatedAt": 1792407101643, "plugin": "reeve", "version": "0.0.1",
  "counts": { "total": 4, "running": 0, "completed": 4, "error": 0, "stopped": 0, "reconciled": 0 },
  "tasks": [ { "taskID": "...", "parentSessionID": "...", "childSessionID": "...",
               "agent": "scout", "description": "...", "state": "completed",
               "timedOut": false, "statusUncertain": false, "startedAt": 0, "endedAt": 0 } ] }
```

三条纪律：
1. **是投影，不是第二份真相** —— 权威仍然是 `ctx.storage`；这份文件只给人/面板看。
2. **失败只记日志** —— 记账的正确性**绝不依赖**它（写不进去也不影响落账）。
3. **字段是白名单** —— 内部字段（`generation` / `attempts` / `interruptSent` …）不进快照。

不设 = 不写任何文件（默认关闭）。控制台那边怎么读：[../extensions/reeve/README.md](../extensions/reeve/README.md)。

---

## 资源与性能（2026-10-19 实测审计）

**场景**：1 个父会话、**88 个并发子任务**（使用者实测峰值）。跑 `plugin/test/bench.mjs` 复现。

| 指标 | 实测 | 评价 |
|---|---|---|
| 建 88 个任务（闸门 + 台账 + 墙钟） | **2.1 ms** | 可忽略 |
| 88 个任务落终态 | **0.7 ms** | 可忽略 |
| `ctx.storage.set` 调用 | **264 次**（每任务 3 次） | 可接受 |
| 累计写入 | **108 KB**（每任务 1259 B） | 可接受 |
| 堆内存增量 | **+1 MB**（88 条记录） | 可忽略 |
| `ledger.running()` | 0.002 ms / 次（O(台账总数)） | 可接受 |
| `forChildSession()` | **O(1)** Map 查找（事件流每次命中它） | 好 |

**结论：插件本身很轻。** 峰值场景下的开销在毫秒与百 KB 量级。

### 审计出的三处（一处已修，两处该配）

| # | 问题 | 处置 |
|---|---|---|
| 1 | **`hydrate()` 在存储不返回游标时会静默截断台账** —— 取满一页却拿不到 `next`，就只恢复前 500 条，**且不报**。这正是本项目最怕的"静默不一致" | ✅ **已修**：现在返回 `{loaded, truncated, pages}`，截断时**打告警** |
| 2 | **台账只增不减**：记录永不清理 → 跑一年攒几万条，启动扫描与内存都涨 | ✅ **已加** `retentionDays`（默认 30 天）：只清**已落终态**的旧记录，**在飞的一律不动** |
| 3 | **订阅整个 SSE 事件流**：每个 token 的 `session.text.delta` 都会到插件里过一遍。单次极便宜（一次 `startsWith` 早退），但 JSON 解析由运行时承担 | ⚠️ **观察项**：若发现会话变慢，优先查这里。API 是否支持服务端过滤未验 |

### 两个仍然存在的设计风险（未改，如实记录）

- **槽位泄漏**：若 `execute.after` 因故不触发，`held` 里那一格不会释放 → 闸门最终会卡住所有派发。
  目前靠"运行时保证 after 必然跟随 before"这条假设。**没有兜底超时**。
- **排队无上限**：超限时无限等（这是"排队而非失败"的要求）。**若第 1 条真的发生，就是永久挂起。**

**建议**：上生产前给 `limits.default` 设一个值，并盯一次 `[reeve]` 日志里的在飞/排队计数。

---

## 验证

```bash
# 全部测试（不依赖模型、不依赖 opencode）：68 + 30 + 9 + 11 + 10 + 7 = 135 项
npm test

# 加载 + 工具是否进入模型工具表
opencode service stop && sleep 3
opencode run --standalone --auto --print-logs "hi"
#   看 stderr 里的 [reeve] 行（含"引擎 agent 表"与"名册已注入"两条）
#   看模型收到的工具名里有 reeve_task_status
#   看快照文件（snapshotPath）里的 agentTable / roster 两节
```

**在 EL7 上的实机验证**（2026-10-19，staging，隔离 `HOME`）：真委派 `foreman → scout` 后台账落账
（`agent=scout`、`state=completed`、父/子会话 id 齐全），子会话 17 次调用全在 `reeve/flash`；
快照里 `agentTable.visible=[foreman]`（其余 14 个 hidden）、`roster.count=7`；
模型能调 `reeve_task_status` 把台账读回来。详见 [../docs/PROGRESS.md](../docs/PROGRESS.md) §4.4 / §5.2 / **§6.1**。

**注意**：opencode v2 默认跑一个**后台常驻 service**，它会**钉住环境变量**。
改 `HOME` / 配置后必须 `opencode service stop`，否则看到的是旧环境
（**且 stop 之后第一次调用会返回空，需要一次预热调用**）。

---

## 许可

**本包是 MIT**（[`LICENSE`](LICENSE)）。包内有两处外来内容，许可原文随包分发（清单：[`THIRD-PARTY.md`](THIRD-PARTY.md)）：

- **`oh-my-opencode-slim`（MIT）**——算法参照：终态判定门、静默宽限、墙钟监督器、准入队列、惰性重启对账的思路。
  它是 **v1 插件**（`'tool.execute.before'` / `'experimental.chat.messages.transform'` 这些钩子名）——
  **算法可抄，接线全部按 v2 重写**。原文：[`licenses/oh-my-opencode-slim.LICENSE`](licenses/oh-my-opencode-slim.LICENSE)。
- **`alibaba/open-code-review`（Apache-2.0）**——`skills/review/` 下 7 份规则文档是**原样副本**。
  原文：[`licenses/open-code-review.LICENSE`](licenses/open-code-review.LICENSE)。

**未引入** `oh-my-openagent`(omo) 的任何代码或 prompt 字面（SUL-1.0，永久禁止）。

开发记录（施工图 `docs/research/opencode-v2-plugin-api.md`、PROGRESS、PLAN 等）只在**开发仓库**里，
不随公开树与 npm 包发布——README 里 `§x.y` 这类引用指的都是那份记录。
