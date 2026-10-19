# REEVE 进度台账

> **规矩**：每完成 PLAN.md 里的一个步，把该步的验收结果写在这里。
> **格式**：`步 N / 检查项 / 结果 / 日期`。
> **没有记录的"完成"不算完成。**

---

## ⛔ 阻塞项 #1 — 仓库过不了自己的许可门禁（待使用者裁决）

**发现日期**：2026-10-19。**状态**：未解决，**因此第 0 步的 commit 未打**。

`NOTICE.md` 末行规定的提交门禁是：
> **检查方式**：提交前 grep 仓库，确认没有出现 `Sisyphus` / `Momus` / `Atlas` / `Prometheus`
> 等 omo 的品牌名与其 prompt 原文片段。

而 `HANDOFF.md` §15.5 把"引入 omo 的任何代码或 prompt 字面"列为**硬禁止（跨过就是事故）**。
PLAN 步 1 的验收标准里也有"全仓 grep 无 omo 字面"。

**当前实测：过不了。**（命令：`grep -nE "Sisyphus|Momus|Atlas|Prometheus|Metis" ...`）

| 类别 | 位置 | 性质 |
|---|---|---|
| 品牌名 | `HANDOFF.md` 12 处（§5.3 会话分布表、§5.4、§5.5、§9、§14） | 事实引用（迁移叙事需要） |
| 品牌名 | `docs/research/orchestration-stack-verdict.md` 8 处 | 同上（归档证据） |
| 品牌名 | `PLAN.md` 1 处、`NOTICE.md` 1 处 | **规则本身**，不是违规 |
| **prompt 逐字引用** | `HANDOFF.md` **503–506 行**（评审 prompt 原文 4 行）、**512–513 行**（委派段原文） | **§15.5 硬禁止** |
| **prompt 逐字引用** | `verdict` 归档 **270–275、295–298 行** | 同上（归档） |
| 转述（当时保留了原文的英文小标题） | `PLAN.md` | ✅ **已解决**（2026-10-19，已改成纯中文转述） |

**为什么不擅自改**：这些逐字引用是 HANDOFF §5.5 / verdict §3.4 论证链的一部分
（"omo 的评审被设计成别挡路，所以从它那里拿不到我们要的纪律"）。
删掉字面会动到论证，且这两个文档不是我写的——**属于使用者的决定**。

**三个可选处置**（需使用者选一）：
1. **转述化**（推荐）：`HANDOFF.md` §5.5 与 `PLAN.md` §3.4 改成中文转述，
   保留论证、去掉英文原文；归档 `verdict` 不动（它已标"不要按它施工"）
2. **收窄规则**：把 `NOTICE.md` 的门禁改为"不得引入可运行/可复用的代码或 prompt 形态，
   允许为批判目的的短引用"，并同步改 PLAN 步 1 的验收措辞
3. **移出仓库**：把 `verdict` 归档与 HANDOFF 的相关段落挪到仓库之外

**在这条解决前**：不要打第一个 commit（仓库自己的规矩是"提交前 grep"）。

---

## 步 0 — 计划落成文档 ✅

| 检查项 | 结果 | 日期 |
|---|---|---|
| `docs/PLAN.md` 重写（补齐审查层 / 代理操作模型 / 控制台 / 记账插件 / 编排层 / 部署路径 / 命名与仓库布局） | 完成 | 2026-10-19 |
| `docs/research/opencode-v2-plugin-api.md` 新建（v2.0.32 实测插件 API 施工图） | 完成 | 2026-10-19 |
| `docs/HANDOFF.md` 勘误（§3.3 / §4.6 / §6.1 / §6.2⑤ / §6.4 / §11.2 / §12 / §15.1 / §15.3） | 完成 | 2026-10-19 |
| `docs/research/orchestration-stack-verdict.md` 加"已被取代"横幅（保留归档完整性，不改正文） | 完成 | 2026-10-19 |
| `README.md` 索引与状态更新 | 完成 | 2026-10-19 |
| Phase 0（修 v1+omo 配置）**删除** | 完成 | 2026-10-19 |
| **commit** | **阻塞**（见上方阻塞项 #1） | — |

**本步核出的、写进文档的事实**（来源见施工图 §13 的复现方式）：

- v2 插件入口确认为 `{ id, setup }`（v1 是 `{ id, server }`）
- 钩子真名是 `ctx.tool.hook("execute.before"|"execute.after", cb)`；**v1 的 `tool.execute.before` 在 v2 不存在**
- 工具注册走 `ctx.tool.transform(e => e.add({...}))`；**不带 `options.namespace` 的工具不出现在模型工具表里**
- `session.idle` 在 v2 **仍然存在但已标 `// deprecated`**（旧文档"不再发"是错的）
- `SessionDomain` 的 `Pick` **含 `remove` 与 `compact`**；`list`/`children`/`status`/`todo` 确实没有
- `subagent` 工具输出是**结构化**的 `{ sessionID, status, output }`
- 自定义 provider 的 **`models` key 会成为发给端点的 `model` 值**（`stub-log.jsonl` 8 条记录佐证）
  → ⚠️ **此条后来被修正**：那只在**遗留单数 `provider` 形态**下成立；
  用**原生复数 `providers` 形态**时，`modelID` 可显式覆盖线上名（见步 1a）。
  **我一度由此得出"不需要原生 Aliases"的结论——那是错的**（HANDOFF §4.8 从一开始就是对的）。
- Bifrost 下载 URL 形态、app-dir 默认位置、静态构建的真实 flag、`served_model` 落库位置、响应头全名

---

## 步 1 — 编排层（文本）🚧 进行中

**前置**：~~§2 配置目录隔离~~ → **已确认不阻塞开发**（开发机隔离栈自带独立 `HOME`，`opencode v2.0.32` 已跑通）。

### 1.0 子任务：确定 agent 定义的文件落点与配置杠杆 ✅（2026-10-19）

| 检查项 | 结果 | 日期 |
|---|---|---|
| v2 是否支持 markdown agent 定义 | ✅ 支持，且 **`agent/`（单数）与 `agents/`（复数）两个目录都被扫描** | 2026-10-19 |
| v2 是否支持配置 `agents` 键 | ✅ 支持（`$HOME/.config/opencode/opencode.json`） | 2026-10-19 |
| 配置目录的杠杆是什么 | **`HOME`**。`OPENCODE_CONFIG_DIR` ❌、`XDG_CONFIG_HOME` ❌（Windows / v2.0.32 实测） | 2026-10-19 |
| 后台 service 是否钉住环境 | ⚠️ **是**。改环境后必须 `opencode service stop`，否则看到的是旧环境（曾因此得出两个错误结论） | 2026-10-19 |
| v2 内置 agent 清单 | `build` / `compaction` / `explore` / `general` / `plan` / `summary` / `title` | 2026-10-19 |
| 默认权限规则集 | `*:* allow` + `read *.env ask` + `read *.env.* ask` + `read *.env.example allow` + **`browser:* deny`** | 2026-10-19 |

**产出**：写进 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §14；
并据此更正 [PLAN.md](PLAN.md) §2（隔离杠杆从 `OPENCODE_CONFIG_DIR` 改为 **待 EL7 验证**）。
**隔离栈已复原**（探针文件全部清除）。

### 1.1 子任务：8 个 agent 定义 ✅（2026-10-19）

| 检查项 | 结果 | 日期 |
|---|---|---|
| `agents/*.md` 8 个（foreman/planner/critic/advisor/scout/librarian/executor/reviewer） | ✅ 已落盘 | 2026-10-19 |
| 在隔离栈里 `debug agents` 能列出 8 个且无 schema 报错 | ✅ **通过**（8 个自定义 + 7 个内置 = 15） | 2026-10-19 |
| `mode` / `model` / `permissions` 归一化符合预期 | ✅ 通过（`critic`/`advisor`/`planner`/`reviewer` 的 edit+shell 均 deny；`executor` 是唯一有写权的 subagent） | 2026-10-19 |
| `prompts/orchestrator.md` + `prompts/critic.md` | ⛔ **取消**——实测 markdown 正文即 `system`，再维护一份会造成两处真相（已更正 PLAN §3.5 / §9） | 2026-10-19 |

**验证方式**（隔离栈，`HOME` 指向测试目录 + 一个 provider `reeve`）：
```bash
opencode service stop && sleep 3
opencode debug agents >/dev/null    # 预热（stop 后首次调用会返回空，见施工图 §14.4）
opencode debug agents
```

**产出**：[agents/](D:\develop\reeve\agents) 下 8 个文件；实测结果写进
[research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §14.6。

### 1.1b 子任务：档位命名空间改名 `router/` → `reeve/` ✅（2026-10-19）

**背景**：使用者裁定——代理在**集成上不独立**（进程归 ocrc、配置源真相在 reeve 仓库、
控制台是唯一运行时写者、插件只读），别名命名空间应带自己的品牌；且这样 agent 定义对实现中立
（以后换掉 Bifrost，`reeve/flash` 不用改）。

| 检查项 | 结果 | 日期 |
|---|---|---|
| `agents/*.md` 改名 | ✅ 8 个：`reeve/pro`（4 个）/ `reeve/flash`（4 个） | 2026-10-19 |
| 前瞻规格文档改名 | ✅ PLAN §3.1/§5.1/§5.4/§10、PROGRESS、施工图、HANDOFF §0.4/§4.6/§4.8 | 2026-10-19 |
| **历史实验记录保持原样** | ✅ HANDOFF §4.4 与 verdict §2.6/§8.3 **未改**——那里 `router/flash` 是当时真实用的模型 id | 2026-10-19 |
| **线上名验证（桩服务）** | ✅ **通过**：桩收到 `requestModel: "reeve/flash"` | 2026-10-19 |
| 8 个 agent 的 ref | ✅ 全部解析为 `reeve/pro` / `reeve/flash` | 2026-10-19 |

**本子任务核出的两条新事实**（写进施工图 §10.1）：

1. **`modelID` 字段真实存在**（`packages/schema/src/config/provider.ts` 的 `Model.modelID`；
   `model-resolver.ts:234` 的 `modelID ?? id`；`model-resolver.test.ts:263` 断言其语义），
   但**官方文档没写**（`models.mdx` 无 Aliases 一节）→ 属"可用但未文档化"。
   **HANDOFF §4.8 从一开始就是对的；我先前"不需要原生 Aliases"的判断是错的。**
2. **⚠️ `modelID` 只在原生复数 `providers` + `package`/`settings` 形态下生效**；
   用**遗留单数 `provider` + `npm`/`options`** 时它**被静默忽略**，线上名退化成 models 的 key
   ——**不报错，只是匹配不上**。REEVE 因此**必须用原生复数形态**。

**验证方式**：
```bash
# 隔离栈测试 home：config 用原生 providers + modelID，baseURL 指向桩
STUB_LOG=<test>/stub-log.jsonl node stub.mjs &
opencode run --standalone --auto --session <id> "say hi"
cat <test>/stub-log.jsonl     # requestModel 必须是 reeve/flash
```
**隔离栈已复原**（测试 home 全部清除）。

### 1.2 子任务：行为验收（**真实模型**）🚧 5/6 通过（2026-10-19）

**测试环境**：隔离栈 + 使用者授权的真实 provider（`xxyapi-deepseek` 的 key，
经 `{env:VAR}` 注入）。agent 的档位 ref 都指向真实模型。

| # | 检查项 | 结果 | 证据 |
|---|---|---|---|
| ① | **grill 先于动手** | ✅ **通过** | 给模糊需求（"canary.txt 不太行，你处理一下"）→ 它**明确引用了意图门**（"本消息没有明确的实现落点"）、列出缺的目标/边界/验收、**一个文件都没动**、并说明"此刻派 executor 就是这道题要抓的失败模式" |
| ② | **文档是接口** | ⚠️ **部分通过** | 见下 |
| ③ | **权限闸门** | ✅ **通过（硬证据）** | 逐 agent 抓模型可见工具面：`critic`/`advisor`/`planner`/`reviewer` = **10 个工具，edit/write/shell 根本不提供**；`foreman`/`executor` = 13 个（全权）；`scout` = 11（无 edit，有 shell，符合 spec）。**不是调用时拒绝，是工具面直接削减** |
| ④ | **验收独立性** | ✅ **通过** | 派 executor 造文件后，foreman **自己**跑 `od -c` + `wc -c`，并标注"**不是子任务的自我报告，是我自己跑的命令**"；逐字节核对（无 BOM、13 字符+\n=14B，与 od 的 `000016` 吻合） |
| ⑤ | **多轮评审** | ✅ **通过** | 造一个跨维度有缺陷的计划。第 1 轮（完整性/可执行性）**列 9 条**（**无"最多 3 条"上限**）、每条给可执行修改项、**主动把维度分开**（"安全问题留给安全维度那一轮，本轮不重复"）、结论"不通过"。第 2 轮（安全性）**7 条全新发现、不重复第 1 轮**、再次"不通过" |
| ⑥ | **无 omo 字面** | ✅ **通过** | 全仓 grep 0 命中（见门禁检查） |

**② 为什么只算"部分通过"**：
- **门生效了**：加上"派发门"之后，它明确写出"3 个文件命中 `≥3 文件` 阈值，
  按规矩我会先出**自包含实施文档**、过 `critic` 评审，再派 `executor`"——**判断完全正确**。
- **但完整循环没观测到**：两次尝试都因为 foreman 先做大量侦察（ls/cat/attrib/od…）
  而**在我设的超时窗口内没跑完** plan→critic→executor。
- **过程中的真发现（已修）**：我原先的 foreman prompt **描述了四阶段却没写什么时候必须走完**。
  已补：① 小任务豁免的**明确判据**（单点/无设计选择/验收一眼可判）；
  ② **派发门**——派 `executor` 前必须在回复里写出"跨过阈值了吗 / 命中哪一条 / 文档在哪"，
  把"跳过流程"变成**必须显式说出口的动作**。

**两个过程细节（值得记）**：
- 面对"改只读文件"的任务，foreman 的验收方式是**真的尝试往三个只读文件各追加一行**，
  三次全被拒后才确认"只读真的生效"——这是很硬的验证手法。
- 它两次都主动指出：**"不要问我"不是授权**、以及"非交互运行下我无法提问，所以我把假设写出来"。

---

## 步 2 — 记账插件 `@bd7pil/reeve`（代码）🚧 前置已清

**前置**：步 1。

### 2.0 子任务：插件端到端探针 ✅（2026-10-19）

用一个最小插件（`export default { id, setup }`）走通整条链路，把施工图 §12 的未决项清掉。

| 检查项 | 结果 | 日期 |
|---|---|---|
| 本地目录插件能否加载 | ✅ `plugins: ["<目录绝对路径>"]` 可用（**Windows 上必须正斜杠**） | 2026-10-19 |
| `setup()` / `tool.transform` / `tool.hook` / `session.hook` / `event.subscribe` 是否真工作 | ✅ 全部可用，事件流正常 | 2026-10-19 |
| **工具进模型工具表的开关** | ✅ **是 `options.codemode: false`，不是 `namespace`**。四个变体注册后 `tool.list()` 全在，模型只收到带 `codemode:false` 的两个 | 2026-10-19 |
| 入参 schema 字段名 | ✅ `input` 与 `args` **都能用** | 2026-10-19 |
| 惰性对账挂哪个钩子 | ✅ **挂 `prompt`**（回合开始即触发，早于 `session.execution.started`）；`context` 在构造模型调用时才触发 | 2026-10-19 |
| 实测到的回合内触发顺序 | `session.hook("prompt")` → `session.execution.started` → `session.hook("context")` → `session.step.started` → … → `session.execution.succeeded` | 2026-10-19 |

**⚠️ 一条重要更正**：施工图早先说"不带 `options.namespace` 工具就不进模型工具表"——
**不准确**。`namespace` 只管命名；**真正的开关是 `codemode: false`**。
（ocrc 的代码里其实两个都传了，所以它在 2.0.27 上是对的，只是归因错了。）
**REEVE 一律写 `options: { namespace: "reeve", codemode: false }`。**

**顺带踩到的坑**（写进施工图 §15）：配置 JSON 里把 Windows 路径写成反斜杠是**非法转义**
→ **整份配置被静默丢弃**（`debug config` 只剩 `directory` 源），请求会打到 OpenCode 自带免费档。
**判据**：`debug config` 里必须有 `{"type":"document"}` 这一项。

**产出**：写进 [research/opencode-v2-plugin-api.md](research/opencode-v2-plugin-api.md) §0 / §3.1 / §12 / §14.7 / §15。
**隔离栈已复原**（探针插件与测试 home 全部清除）。

### 2.1 子任务：实现插件 🚧 骨架完成，行为验收待模型

**产出**：`plugin/`（6 个模块 + 根入口 + README + 单元测试）

```
plugin/
  package.json          main 指向根 index.js（子目录入口不会被加载）
  index.js              根入口，只做转发
  README.md             安装 / 配置 / 验证 / 许可
  src/
    constants.js        状态机、宽限常量、原因枚举、记录形状
    ledger.js           台账：终态单调性 / 墓碑 / 落盘 / 重启恢复
    terminal-gate.js    终态判定门 + 静默宽限
    concurrency.js      准入闸门：档位解析 / 排队 / 嵌套豁免 / 进程级共享
    supervisor.js       墙钟：一次性定时器 / 生成守卫 / 恰好一次中断
    reconcile.js        跨重启对账（惰性，从父转录重建）
    index.js            接线：钩子 / 事件 / 工具 / 对账
  test/unit.mjs         35 项断言
```

| 检查项 | 结果 | 日期 |
|---|---|---|
| 插件能被 v2 加载（`setup()` 执行） | ✅ **通过**（stderr 出现 `[reeve] 已启动`） | 2026-10-19 |
| `reeve_task_status` 进入模型工具表 | ✅ **通过**（13 个工具 = 12 内置 + 1） | 2026-10-19 |
| 单元验证（不依赖模型） | ✅ **35 通过 / 0 失败** | 2026-10-19 |
| 终态单调性（迟到的完成不覆盖超时） | ✅ 单元覆盖 | 2026-10-19 |
| 墓碑不复活 + 子会话索引拆除 | ✅ 单元覆盖 | 2026-10-19 |
| 落盘 + 重启恢复（如实标未知，不谎报） | ✅ 单元覆盖 | 2026-10-19 |
| 静默宽限（正常完成不被误报成死亡） | ✅ 单元覆盖（含"刚开始跑"与"刚好在宽限内"两个反例） | 2026-10-19 |
| 并发：档位解析 / 排队不失败 / **嵌套不自死锁** | ✅ 单元覆盖 | 2026-10-19 |
| 墙钟：到期中断 / **只发一次** / 宽限后标不确定 / 不续期 | ✅ 单元覆盖 | 2026-10-19 |

**本子任务核出的新事实**（写进施工图 §0）：
**插件入口必须在目录根**——`package.json` 的 `main` 指向子目录时**插件根本不会被加载，
而且不报错**。（根上加一行 `export { default } from './src/index.js'` 即解决。）

### 2.2 子任务：端到端行为验收（**真实模型**）✅ 部分通过（2026-10-19）

**测试环境**：隔离栈 + **使用者授权的真实 provider**（`xxyapi-deepseek` 的 key，
经 `{env:VAR}` 注入；测试目录收尾已删）。agent 的档位 ref 都指向真实模型。

| 检查项 | 结果 | 日期 |
|---|---|---|
| 插件在真实会话里加载并记账 | ✅ **通过**——`[reeve] 派发 scout（父 ses_bhv002）；在飞 1，排队 0` | 2026-10-19 |
| **在飞可查**（`reeve_task_status` 端到端） | ✅ **通过**——工具被真实调用，返回 4 条记录 | 2026-10-19 |
| **无假警报**（正常完成不误报为死亡） | ✅ **通过**——成功的是 `completed`，**没有任何一条被误标成 stopped** | 2026-10-19 |
| **终态单调性**（生产路径） | ✅ **通过**——日志：`拒绝覆盖已发布的终态：… 已是 completed，忽略迟到的 completed` | 2026-10-19 |
| 子会话 id 解析 | ✅ **通过**——`child` 字段填的是真实 `ses_...` id | 2026-10-19 |
| **失败原因如实记录** | ✅ **通过**——失败的两条带真实原因（`Model unavailable: reeve/flash` / 免费档拒绝） | 2026-10-19 |
| **跨重启持久化** | ✅ **通过**——第二次运行日志：`从盘上恢复 3 条台账记录` | 2026-10-19 |
| 并发闸门在真实路径上生效 | ✅ **通过**——每次派发都有闸门日志与在飞计数 | 2026-10-19 |
### 2.3 子任务：三项端到端行为验收 ✅ 全通过（2026-10-19）

**全部用真实模型 + 真实引擎跑，不是模拟。**

| 检查项 | 结果 | 证据 |
|---|---|---|
| **超限时真的排队**（不是失败） | ✅ **通过** | `limits.default=1` + 同时派 2 个后台任务。日志逐条对上：`派发 scout；在飞 1，**排队 1**` → `落账 → running` → 第一个释放后 `在飞 1，**排队 0**`（队列放行） |
| **墙钟真的掐掉卡死的任务** | ✅ **通过**（修了一个 bug，见下） | `wallClockMs=12000` + 长跑后台任务。台账最终：`state:error` / `reason:"wall_clock_timeout"` / **`timedOut:true`** / `uncertain:true`，`startedAt→endedAt` = **12.02 s**（正好等于上限） |
| **跨重启对账** | ✅ **通过** | 派长跑后台任务 → **8 秒后杀引擎**（模拟崩溃）→ 重启 → 用**同一父会话 id** 触发 `prompt` 钩子。台账最终：`state:"stopped"` / **`reason:"unreconciled"`** / `uncertain:true` / `timedOut:false` —— 正是 PLAN 判定表里"存在但无输出 → 停止候选 → `stopped, unreconciled`"那条路径 |
| 零冲突（面板保存 agent 不静默压掉预设） | ✅ **通过**（2026-10-19） | 机制层：插件无 `agents`/`model` 写路径 + 引擎配置 mtime/hash 在 6+ 轮会话后不变。**面板层**：在 EL7 的 openchamber 真保存一次，逐文件比对 —— 只新增一个 user 作用域 agent md，`opencode.jsonc`（三端共享 symlink）/ `opencode.managed.json`（plugins 数组）/ staging `opencode.json` / 8 个 agent **逐字节未变**；缺项目上下文时是 **400 + 界面报错**（不是静默）。证据见 §5.5 |

#### ⚠️ 这一轮抓到的真 bug（已修 + 已加回归测试）

**症状**：墙钟确实在 12.02 s 触发了、中断也发出去了，但台账记成
`state:"stopped"` / `reason:"host_interrupted:unknown"` / **`timedOut:false`**。

**根因**：**我们自己发的中断，被记成了别人的中断。**
我们发 `ctx.session.interrupt()` → 宿主回 `session.execution.interrupted` →
事件处理器**先**落成"宿主中断"；而 `commitTerminal` 是**单调的**，
监督器随后要写的"墙钟超时"**被拒**（这正是它该做的）。

**修法**：**发中断之前先打标** —— `interruptReason: "wall_clock"`；
事件处理器读到这个标时，把 `interrupted` 归因成 `error + wall_clock_timeout + timedOut:true`，
而不是 `stopped + host_interrupted`。

**这类 bug 单元测试抓不到**（需要"我们发中断 → 宿主回事件"这条真实链路）。
已加 2 条回归断言（`interruptReason` 与 `interruptSent` 必须在发中断前置位）。

#### 一个操作细节（值得记）

**`--standalone` 模式下墙钟测不出来**：进程在回合结束就退了，计时器随之消失。
墙钟必须用**后台 service** 模式测（引擎常驻，计时器才活得过上限）。
而且 service 模式下**插件的 stderr 进的是 service 日志**
（`$HOME/.local/share/opencode/log/opencode.log`），不是 CLI 的 stderr。

**许可**：`licenses/oh-my-opencode-slim.LICENSE` 已复制（MIT，`Copyright (c) 2025`）。

**MIT 参照源码已拉取并核对**（2026-10-19，放在仓库外 `D:\develop\omo-slim-ref\`，
共 14 个文件：`LICENSE` + `docs/background-orchestration.md` + 12 个 `.ts`）：

| 核实项 | 结果 |
|---|---|
| 架构主干（Board / TerminalGate / Supervisor / TaskConcurrency） | ✅ 对得上 |
| `STOP_CONFIRMATION_GRACE_MS = 5_000` | ✅ 确认 |
| 台账不落盘、跨重启不存活 | ✅ 确认（文档原文 *"do not survive process restarts"*） |
| `acquireAdmissionRuntime(directory, config)` 按目录进程级共享 | ✅ 确认 |
| `src/**` 无 per-file 版权头（NOTICE.md 的声称） | ✅ 确认 |
| **它用的钩子名** | ❌ **是 v1 的**（`'tool.execute.before'` / `'experimental.chat.messages.transform'`） |

> ⚠️ **关键结论**：omo-slim 是 **v1 插件**。**算法可抄（终态判定门、墙钟监督器、
> 准入队列、静默宽限），但入口/钩子名/工具注册必须按 v2 重写。**
> 照抄 v1 钩子名 = 插件能加载但**一个钩子都不会触发**。

**本步的验收表见上面的 2.1（单元 + 加载）与 2.2（真实模型端到端）**——
此处原先留了一张空的验收表，已删除以免与那两节重复、造成"未通过"的误读。

---

## 步 3 — 审查层（文本）🚧 素材就位，行为验收待模型

**前置**：步 1。

### 3.0 子任务：吸收 OCR 的规则与契约 ✅（2026-10-19）

**决定不变：不装 OCR 工具，把能力吸收进 `reviewer` subagent。**
（它要 `git >= 2.41` 而 EL7 自带 1.8.3；npm 包装器联网自更新；规则有 Java 企业栈倾向；
它只审 diff 不审计划；"多轮多角度"是 prompt 的事。）

| 检查项 | 结果 | 日期 |
|---|---|---|
| 上游与版本确认 | ✅ `alibaba/open-code-review`，Apache-2.0，47,613★，最新 tag **v1.13.1**（2026-10-17） | 2026-10-19 |
| 规则文档结构确认 | ✅ `internal/config/rules/rule_docs/` 共 **54** 份；`default.md` 正是那五维 | 2026-10-19 |
| 抄入相关 rubric（7 份） | ✅ `default` / `ts_js_tsx_jsx` / `python` / `go` / `yaml` / `json` / `package_json` | 2026-10-19 |
| 输出契约的枚举核实 | ✅ 取自上游 `internal/model/review.go`：`Category` 8 值、`Severity` 4 值——**与文档一致** | 2026-10-19 |
| 自写使用说明 | ✅ `skills/review/SKILL.md`（五维 / 选表 / 契约 / 多轮撤计划 / 误报过滤 / 门禁策略）——**文件名必须是 `SKILL.md`**，见 3.1 | 2026-10-19 |
| 许可证 | ✅ `licenses/open-code-review.LICENSE`（Apache-2.0，11356 bytes） | 2026-10-19 |
| `NOTICE.md` 登记引入清单 | ✅ 已列出 7 份 rubric 的逐文件对应关系 | 2026-10-19 |

**产出**：`skills/review/`（7 份上游 rubric 原样副本 + 1 份自写 README）；
`agents/reviewer.md` 已指向它。

**注意**：上游的 TS/JS rubric 实际文件名是 **`ts_js_tsx_jsx.md`**（不是文档里写的 `typescript.md`）。

### 3.1 子任务：端到端行为验收（**真实模型**）✅ 通过（2026-10-19）

**做法**：造一个带 4 个已知缺陷的 `buggy.js`（SQL 注入、不校验输入、除零、无测试），
让 `reviewer` 按 `skills/review/SKILL.md` 的契约审它。

| 检查项 | 结果 | 日期 |
|---|---|---|
| 抓到缺陷 | ✅ **通过**（注入 / 输入校验 / 除零 / 无测试都抓到了） | 2026-10-19 |
| **带行号 + 锚点片段** | ✅ **通过**——每条给了 `path` / 行号 / `existing_code` / `suggestion_code` | 2026-10-19 |
| 遵守输出契约 | ✅ **通过**——`severity` 与 `category` 都填了 | 2026-10-19 |
| **行号对不上时诚实标"未锚定"** | ✅ **通过**——"无测试"那条它明确写 **"我如实标为未锚定，不硬凑行号"** | 2026-10-19 |
| **最后一轮误报过滤** | ✅ **通过**——它单列了"本轮过滤记录"，写明删掉哪两条、为什么 | 2026-10-19 |
| 抓到夹具注释里**没列**的缺陷 | ✅ **通过**——它发现 `require` 在 ESM 里不可用（我没写进夹具注释） | 2026-10-19 |
| 越界指认（范围内外分得清） | ✅ **通过**——它把"测试配置里有明文 API key"标为**范围外提示**，没混进审查结论 | 2026-10-19 |
| 承认不确定 | ✅ **通过**——"目录内没有 package.json，我无法确认最终是 ESM 还是 bundler 处理" | 2026-10-19 |

> **它那条"明文 API key"的指认是对的**——我当时确实把 key 内联在测试配置里。
> 已改为 `{env:VAR}`（顺带验出 opencode 侧的正确语法，见下）。

**本步核出的两条新事实**（写进施工图 §16）：

1. **skill 目录必须含 `SKILL.md`**（或 `<目录名>.md`）。规则是
   `scan("{*.md,**/SKILL.md}")`。原先叫 `README.md` → **根本不是 skill**，
   agent 只能靠 `read` 硬读路径。**已改名为 `SKILL.md` 并复验：reviewer 现在报得出
   "有个叫 `review` 的 skill"及其 description。**
2. **opencode 的 `settings.apiKey` 不支持 `env.VAR`，要写 `{env:VAR}`。**
   写成 `env.VAR` **不报配置错**——它把字面串当密钥发出去，服务端回 `Invalid token`。
   （Bifrost 侧相反，用 `env.VAR`。）**三处文档示例已改正。**

---

## 步 4 — 代理层（Bifrost）🚧 配置与脚本就位，缺 endpoint

**前置**：§2 配置目录隔离（归 ocrc）。
**阻塞**：4 个原生 provider 的 OpenAI 兼容 endpoint（只有使用者能给）。

### 4.0 子任务：配置与脚本 ✅（2026-10-19）

| 检查项 | 结果 | 日期 |
|---|---|---|
| `proxy/config.json` 合法 JSON | ✅ 通过 | 2026-10-19 |
| 6 个 provider 全部写成 OpenAI 兼容自定义 provider | ✅ 2 个已知 + **4 个显式占位** `REPLACE_WITH_…` | 2026-10-19 |
| 三条 routing rule | ✅ `reeve/flash` / `reeve/pro` / `reeve/multimodal` | 2026-10-19 |
| **CEL 与档位名对齐**（自检脚本） | ✅ 三条全对齐 `model == "<档位名>"` | 2026-10-19 |
| **weight 合计为 1**（自检脚本） | ✅ 三条都是 1 | 2026-10-19 |
| API key 不进仓库（`env.<VAR>`） | ✅ 6 个 key 全部走 `env.REEVE_*` | 2026-10-19 |
| `scripts/served-model.sh` | ✅ 语法通过、已置可执行位；支持 `--days` / `--errors` / `--model` | 2026-10-19 |
| `proxy/README.md` | ✅ 拓扑 / 进程归属 / 配置归属 / 安装 / 接入 / 三条边界 / 归因 / 缺的输入 | 2026-10-19 |

**自检命令**（可重跑）：
```bash
node -e "const c=require('./proxy/config.json'); for(const r of c.governance.routing_rules){
  const w=r.targets.reduce((s,t)=>s+t.weight,0);
  console.log(r.name, r.cel_expression===\`model == \"\${r.name}\"\`, w)}"
bash -n scripts/served-model.sh
```

| 检查项 | 结果 | 日期 |
|---|---|---|
| 回退可靠（链头用坏 key → 第二个模型接上，请求成功） | — | 待 Bifrost 起得来 |
| 别名稳定（同一会话多轮，Bifrost 侧始终收到 `reeve/<档位>`） | — | 待 Bifrost 起得来 |
| 视觉别名（只有视觉调用走 `reeve/multimodal`） | — | 待 Bifrost 起得来 |
| **半截流**（opencode 不把截断流当成功） | — | 待 Bifrost 起得来 |
| 归因可查（能回答"这 196 次 quota 错误分别是哪个 provider 撞的"） | — | 待有日志数据 |

### 4.1 子任务：补齐 endpoint 与模型 id ✅（2026-10-19）

**原先以为"只有使用者能给"的 4 个 endpoint，其实本机就有。**

来源：**models.dev 目录缓存** `~/.cache/opencode/models.json`（226 个 provider，
2026-10-05 的快照）。它们**全部标着 `npm=@ai-sdk/openai-compatible`**。

| provider | baseURL |
|---|---|
| `opencode` | `https://opencode.ai/zen/v1` |
| `zhipuai-coding-plan` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| `deepseek` | `https://api.deepseek.com/v1`（目录写的是 `https://api.deepseek.com`） |
| `xiaomi` | `https://api.xiaomimimo.com/v1` |
| `alibaba-cn` | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `lmuai` / `xxyapi-deepseek` | 自定义，来自 `D:\develop\OpenCodeConfig` |

| 检查项 | 结果 | 日期 |
|---|---|---|
| `config.json` 里 0 个 `REPLACE_WITH_` 占位 | ✅ 通过 | 2026-10-19 |
| 7 个 provider，baseURL 全部是 http(s) | ✅ 通过 | 2026-10-19 |
| 链上用到的 model id 在目录里核对存在 | ✅ 6/6 通过 | 2026-10-19 |
| key 全部走 `env.<VAR>` | ✅ 通过 | 2026-10-19 |
| 三条规则 CEL 对齐 + weight 合计为 1 | ✅ 通过（链长 5 / 3 / 5） | 2026-10-19 |

**复现命令**（已写进 `proxy/README.md`）：
```bash
node -e 'const c=JSON.parse(require("fs").readFileSync(process.env.HOME+"/.cache/opencode/models.json","utf8"));
for(const id of ["opencode","zhipuai-coding-plan","deepseek","xiaomi","alibaba-cn"]) console.log(id,"->",c[id]?.api)'
```

> ⚠️ 目录是**缓存快照**（2026-10-05）。上机前重跑一次核对；model id 会随上游变动。

### 4.2 子任务：EL7 上机验证 ✅（2026-10-19，已获使用者授权直连）

**环境勘察**（只读）：

| 项 | 实测 | 与文档的差异 |
|---|---|---|
| 系统 | RHEL 7.9，glibc **2.17** | 一致 |
| **git** | **2.43.0**（EPEL `git-core-2.43.0-1.ep7.x86_64`） | ⚠️ **文档说 1.8.3——错的**。见下 |
| Node 24 glibc-217 | `~/.ocrc/remote/runtime/node-v24.22.0` 在位、**能跑** | 一致 |
| opencode v2 引擎 | `~/.ocrc/remote/engine/opencode` = **v2.0.27**，**能跑** | 一致 |
| 生产 v1 引擎 | `opencode web --hostname=0.0.0.0`（pid 11133，**:4096**） | **全程未触碰** |
| ocrc 推的实例 | openchamber 2.3.3 在 :2610 → 引擎 `serve --port 40333` | 新发现 |
| 磁盘 | /home 剩 60 GB | 够 |
| `~/.reeve` | 不存在（干净） | — |

**Bifrost smoke test（PLAN 步 0.5 / 步 4 的关键前置）**：

| 检查项 | 结果 | 日期 |
|---|---|---|
| 从 `downloads.getmaxim.ai` 取到二进制 | ✅ **v2.3.0**，134,264,480 B | 2026-10-19 |
| **是静态链接** | ✅ `ELF 64-bit LSB executable, x86-64, statically linked, for GNU/Linux 3.2.0, stripped` → **不依赖宿主 glibc，EL7 可跑** | 2026-10-19 |
| 在 EL7 上起得来（18080，**不碰 4096**） | ✅ `/v1/models` 返回 **HTTP 200** | 2026-10-19 |
| 路由插件在 OSS 构建里激活 | ✅ 日志：`plugin status: routing - active` / `governance - active` | 2026-10-19 |
| 收工后无残留进程、端口已释放 | ✅ 通过 | 2026-10-19 |

**配置目录隔离的杠杆（PLAN §2 的最后一个未决项）**：

| 平台 | 引擎 | `HOME` | `OPENCODE_CONFIG_DIR` | `XDG_CONFIG_HOME` |
|---|---|---|---|---|
| Windows | v2.0.32 | ✅ 生效 | ❌ | ❌ |
| **EL7** | **v2.0.27** | ✅ 生效 | ❌ | ❌ |

→ **两端一致：杠杆是 `HOME`。** PLAN §2 已据此更正（ocrc 要改 `HOME`，不是加 `OPENCODE_CONFIG_DIR`）。

**`ttft_timeout_ms` 的层级（PLAN §11 #2）**：✅ **已确定 = target 级**。
决定性证据：运行时实际执行的迁移叫 **`add_ttft_timeout_ms_column_to_routing_targets`** —— 列在 **targets** 表上。
（rule 级不报错只是因为未知字段被宽容忽略，**不代表生效**。）

**顺带发现**：`/api/routing/rules` 需要 **setup token**，否则回 **403**
（`dashboard auth is not configured and no setup token is set`）。热改路由前必须先解决。

**留下的东西**：EL7 上 `~/.reeve-smoke/bifrost-http`（134 MB，后面部署直接用）。
**没有**写任何生产路径、没有改任何配置、没有碰 :4096。

---

### 4.3 子任务：资源与性能审计 ✅（2026-10-19）

**场景**：88 并发子任务（使用者实测峰值）。跑 `plugin/test/bench.mjs` 复现。

**结论：插件本身很轻** —— 建 88 个任务 2.1 ms、落终态 0.7 ms、写 264 次共 108 KB、堆 +1 MB、
`forChildSession` 是 O(1)。详见 `plugin/README.md` 的"资源与性能"一节。

**审计出三处，一处已修**：

| # | 问题 | 处置 |
|---|---|---|
| 1 | **`hydrate()` 会静默截断台账**（存储不返回游标时只恢复前 500 条且不报）——正是本项目最怕的"静默不一致" | ✅ **已修**：返回 `{loaded, truncated, pages}`，截断时打告警 |
| 2 | 台账只增不减（跑一年几万条） | ✅ **已加** `retentionDays`（默认 30 天）：只清已落终态的，**在飞的不动**（有测试） |
| 3 | 订阅整个 SSE 事件流（每 token 的 delta 都过一遍） | ⚠️ 观察项；单次极便宜，服务端过滤未验 |

**两个仍存在的设计风险（如实记录，未改）**：槽位泄漏（`execute.after` 不触发则闸门卡死，无兜底超时）；
排队无上限（若上一条发生就是永久挂起）。**建议上生产前给 `limits.default` 设值。**

**Bifrost 侧**：`logs.db` 只增不减 → 保留期**用 `client` 块**（见 4.4：`client_config` 是错的键）；
`served-model.sh` 的全表聚合未建索引。

**新增测试**：39 + 30 = **69 项全过**（新增 4 项覆盖修剪语义与截断检测）。

---

### 4.4 子任务：EL7 staging 全链部署 ✅（2026-10-19）

**做法**：`~/.reeve-staging/` 作为独立 `HOME`（隔离杠杆已实测确认），
Bifrost 起在 **:18080**，v2 引擎（`~/.ocrc/remote/engine/opencode`，v2.0.27）跑在同一个 staging HOME 下。
**生产 v1 引擎（:4096，pid 11133）全程未动** —— 收工时 `ps -o etime` 显示它已连续运行 17:45:32，从未重启。

**脚本**：`scripts/el7-deploy-staging.sh`（幂等：env → 派生 config → 起 Bifrost → 建 VK）、
`scripts/el7-restart-bifrost.sh`、`scripts/served-model.{sh,mjs}`。

#### 4.4.1 实测结论（这一批是**上机才发现**的，配置已按此修正）

| # | 事实 | 证据 | 对配置的改动 |
|---|---|---|---|
| 1 | **Bifrost 默认 `enforce_auth_on_inference=true`**：推理请求必须带 `x-bf-vk`，否则 `401 virtual_key_required` | 无 VK 的 `/v1/chat/completions` 回 401 | 引擎侧 apiKey = Bifrost **virtual key**（provider 真 key 只留在 Bifrost 的 env 里） |
| 2 | **新建的 VK 默认一个 provider 都不允许** | `403 Provider 'zhipuai-coding-plan' is not allowed for virtual key 'reeve-engine'` | 建完要 `PUT /api/governance/virtual-keys/<id>` `{"allow_all_providers":true}` |
| 3 | **setup token 的读法**：配置写在 `governance.setup_token`，**值写 `env.BIFROST_SETUP_TOKEN`**；请求头是 **`X-Bifrost-Setup-Token`**（不是 `Authorization`、不是 `x-bf-setup-token`） | 设之前 `/api/governance/*` 回 401 `dashboard auth is not configured`；设之后 200 | `governance.setup_token` 进入 config.json |
| 4 | **保留期的键是 `client`，不是 `client_config`** | 写 `client_config.log_retention_days=30` → 重启后 DB 里仍是默认 **365**；换 `client` → DB 立刻变 **30**（`node:sqlite` 直读 `config_client` 表核对） | config.json 改用 `client` |
| 5 | **`base_url` 不能带 `/v1`**：Bifrost 会在 base_url 之后追加路径 | 探针（base_url 指回自己）：`/PA/v1` → `/PA/v1/v1/chat/completions` | 所有 provider 的 base_url 只写到主机（+必要前缀），路径交给 override |
| 6 | ⚠️ **流式走的是另一个 override 键 `chat_completion_stream`** | 只设 `chat_completion` 时：curl（非流式）200，**引擎一跑就 405**；补上 `chat_completion_stream` 后引擎正常 | **每个 provider 两个键都写**（opencode 永远走流式，这是最容易静默踩到的坑） |
| 7 | **provider id 撞 Bifrost 内置名会失效**：叫 `deepseek` → `failed to get config for provider deepseek: not found`；同名配置复制成 `deepseek-api` → 正常到达上游 | 同一份配置换个名字就好 | 改名 `deepseek-api` |
| 8 | **`served_model` 列在本构建里恒为 NULL** | 全部行 `served_model=null` | 归因改用 `provider` / `model` / `selected_key_name` / `fallback_index` / `routing_rule_name`（见 4.4.3） |
| 9 | **EL7 自带的 sqlite3 3.7.17 打不开 Bifrost 的库**（部分是索引需要 >= 3.8） | `sqlite3 logs.db "select 1"` → `malformed database schema (idx_mcp_logs_session_id)` | `served-model.sh` 改为优先找支持 `node:sqlite` 的 node（ocrc 运行时自带 Node 24），退路 `/api/logs`（要 setup token） |
| 10 | **Bifrost 会把「key 连续失败」的 provider 从链头挪走** | 坏 key 期间先出现 `hop=0 xiaomi error / hop=1 zhipuai success`，随后同一档位直接 `hop=0 zhipuai success` | 读归因时**不能假设 hop 0 = 配置里的链头**，要看 `provider` 列 |
| 11 | **插件的存储命名空间是 `plugin:<hex(id)>:`，不是文档写的 `plugin.<id>.`** | kv 表里的键：`plugin:00720065006500760065:ledger/call_...`（hex 解码 = `reeve`） | 写进研究文档（步 5 控制台要用） |
| 12 | **`run --agent <subagent>` 的顶层会话用的是 config 的默认 model**，不是该 agent 的档位；**agent 的档位只在被委派时生效** | `--agent scout` 跑出来是 `> scout · pro`（打到 reeve/pro）；而 foreman 真委派 scout 时那 8 次全在 `reeve/flash` | 记档：验档位要验**委派**，不能用 `--agent` 顶层跑 |

#### 4.4.2 EL7 上各 provider 的实际可用性（**与配置里的链序无关，是账号/线路状态**）

| provider | 流式 | 结论 |
|---|---|---|
| `zhipuai-coding-plan` | ✅（补了 stream override 之后） | 可用；面对面 `glm-5.3` / `glm-5.3-flash` 都通 |
| `lmuai` | ✅ | 可用（`glm-5.3` / `glm-5.3-flash`） |
| `xiaomi` | ✅ | 可用（`mimo-v2.6-flash`） |
| `xxyapi-deepseek` | — | ❌ `503 Service temporarily unavailable`（上游） |
| `deepseek`（→`deepseek-api`） | — | ❌ `402 Insufficient Balance`（**该账号余额为 0**） |
| `alibaba-cn` | — | ❌ `Incorrect API key` / `404 resource not found`（key 无效） |
| `opencode`（zen） | — | EL7 的 `auth.json` 里**没有**这个 provider（staging 按规则摘掉） |

→ **EL7 staging 上真正能扛事的只有 `zhipuai-coding-plan` / `lmuai` / `xiaomi`**，
而这三个恰好覆盖了三个档位，所以全链验证可以做完。

#### 4.4.3 验收结果

| 检查项 | 标准 | 实测 |
|---|---|---|
| 引擎能起来、配置被读 | `debug config` 里有 `document` 源 | ✅ 且 `apiKey` 显示为 `***`（说明 `{env:REEVE_VK}` 已解析） |
| 8 个 agent 加载 | 8 自定义 + 7 内置 | ✅ 15 个；`foreman/planner=reeve/pro`、`scout/executor=reeve/flash`；`critic/advisor/planner/reviewer` 的 `deny` 含 `edit+shell` |
| 插件加载 | 工具可见、hook 挂上 | ✅ 模型能调 `reeve_task_status` 并拿到台账 |
| **Bifrost 收到 `reeve/<档位>`** | 引擎请求的 model 名 = `reeve/<档位>` | ✅ `routing_rule_name` = `reeve/pro`／`reeve/flash`／`reeve/multimodal` |
| **档位分流** | 主 agent pro、子 agent flash | ✅ foreman 9 次 `reeve/pro`；**同一场对话里**委派给 scout 的 8 次全在 `reeve/flash` |
| 台账落账 | 子任务被记录 | ✅ `{agent:"scout", state:"completed", childSessionID, parentSessionID}` 落进引擎存储 |
| **回退可靠** | 坏 key 链头 → 第二个接上且请求成功 | ✅ `hop=0 xiaomi error(Invalid API Key)` → `hop=1 zhipuai-coding-plan/glm-5.3-flash success`（显式点名 + 真委派两种都验了） |
| **视觉档** | 只有视觉调用走 `reeve/multimodal` | ✅ 带图那次 `reeve/multimodal → zhipuai-coding-plan/glm-5.3-flash`，hop 0 success（模型回答了 8×8 图的像素数） |
| **归因可查** | 答得出"谁真的服务了" | ✅ `served-model.sh --days 1` 输出档位→provider/model/key/状态计数 + 每跳归属 |
| 无 omo 字面 | 0 命中 | ✅ |
| **生产未动** | :4096 与 `~/.config/opencode` 一行不动 | ✅ pid 11133 连续运行 17:45:32；staging 收工后 18080 已释放、无残留进程 |

**「零冲突」机制层（EL7 侧）**：
- 插件代码里**没有任何写 `agents`/`model` 的路径** —— 全部写操作只有 `this.storage.set(<自己的命名空间>)` 与内存 Map；
- `~/.reeve-staging/.config/opencode/opencode.json` 的 **mtime 停在 18:19:17**（我写入那一刻），
  hash `9b7c8768…`；此后跑了 6+ 轮引擎会话（含委派、含台账写入）——**文件一个字节都没变**。

#### 4.4.4 未做/未验（如实记录）

- ~~**面板层「零冲突」**~~ → **2026-10-19 当晚补做完成**，见 §5.5。
- EL7 上 `xxyapi-deepseek` / `deepseek-api` / `alibaba-cn` 的失败**是账号侧问题**，不是本仓库的配置问题；
  链序在别的机器上按同样规则重新核对即可（`scripts/served-model.sh` 就是干这个的）。
- `pro` 档在 EL7 只有 1 跳可用（`zhipuai`）；`lmuai/glm-5.3` 已加进 fallback 列表，
  实测它在 `pro` 的 hop=2 上成功接过一次（见归因表）。

---

## 步 5 — 控制台（openchamber 扩展）✅（2026-10-19）

**结论先说**：扩展**真的装进了 EL7 上的 openchamber 2.3.3，面板真的渲染出来了**，
而且**台账数据走通了整条链路**（引擎 → 插件 → 快照文件 → 宿主的文件桥 → 面板）。
下面每条都有实测证据。

### 5.1 做了什么

| 产出 | 说明 |
|---|---|
| `extensions/reeve/package.json` | manifest：`apiVersion:1`、`contributes.panel`（id `reeve`）、`filesystem` 两条模式、`actions` 一条 |
| `extensions/reeve/panel/index.html` + `panel/main.js` | 面板（classic IIFE，51 KB）。**只读**：只调 `listProjects/listSessions/readFile/openSession` |
| `extensions/reeve/src/panel/main.js` | 源码（ESM，import `@openchamber/sdk` + `/ui` 的绘制套件） |
| `extensions/reeve/build.mjs` | esbuild（**走 JS API**：Windows 上 Node 不能直接 execFile 一个 `.cmd`，实测 EINVAL） |
| `extensions/reeve/check.mjs` | **用宿主自己的解析器**校验 manifest + 打包完整性（宿主 install 会拒的那几项） |
| `extensions/reeve/cdp-panel{,2}.mjs` | 用 EL7 上那个 headless Chrome（:9222）真的点开面板并读它的 DOM |
| `plugin/src/snapshot.js` + `plugin/test/snapshot.mjs` | 台账**快照导出**（opt-in、原子写、白名单投影）+ 7 项测试 |

**两个数据源**（都是读）：
- **会话树**：宿主的 `listProjects → listSessions` + `onSessions`（用 `parentId` 成树）
- **台账**：读插件导出的快照 JSON。**为什么走文件**：面板跑在沙箱 iframe 里（CSP、无网络、
  拿不到引擎的 SQLite），宿主只给了它 `readFile`；快照是**投影**，权威仍是插件的 `ctx.storage`。

### 5.2 实测证据

| 检查项 | 证据 |
|---|---|
| manifest 被宿主的解析器接受 | `check.mjs`：`parseManifestJson` 通过；请求能力恰为 `sessions,filesystem`（**没多要 `conversation`** —— 不需要读消息就别要） |
| 宿主 install 通过 | `POST /api/guests {path}` → **HTTP 201**；`GET /api/guests` 里出现 `id=reeve`、`name=REEVE 编排`、`icon=git-branch`、`enabled=true`、`source=path` |
| 能力批准 | `PUT /api/guests/reeve/capabilities {granted:[sessions,filesystem]}` → 200；复读为 `granted:["sessions","filesystem"]` |
| 面板文档由宿主服务 | `GET /api/guests/reeve/panel/index.html` → **200，17,390 B**（宿主把主题样式注入了我们 987 B 的 HTML）；`panel/main.js` → 200，52,676 B = 打包产物大小 |
| **在真 UI 里被识别** | CDP 打开 `:2610` → 侧栏出现标题为 **`REEVE 编排`** 的按钮（Branch 图标）；点击后宿主建了 iframe：`/api/guests/reeve/panel/index.html?oc_ui=issue-page&oc_url_token=oc_url_…` |
| **面板真的渲染** | 在该 iframe 的执行上下文里读 DOM：标题 + 徽章 **`0 在飞 / 4 总`**（primary）+ `刷新` + 两个分区；**console 无报错** |
| **台账数据真的读到了** | 面板文本：`4 条记录 · 0 在飞 · 生成于 18:51:41（~/.reeve-staging/.local/share/opencode/reeve/ledger.json）`，四条记录带 agent（`scout`）、子会话 id、耗时；DOM 里是宿主套件的 `oc-sdk-list` / `role=option` / toned badge |
| 快照由**真插件**产出 | EL7 staging 跑真委派（`foreman → scout`）→ 文件生成，`counts={total:4,completed:4}`，无 `.tmp` 残留；其中最早那条是**从 `ctx.storage` hydrate 回来的**（跨进程重启仍在） |
| 面板模样的截图 | 见会话可视化目录里的 `reeve-panel-in-openchamber.png` |

**截图里能看到**：右侧抽屉标题「REEVE 编排」，徽章 `0 在飞 / 4 总`，四行任务
（`统计 src 下 js 文件数` / `scout · ses_eac365be…` / `已完成` / `1ms`），以及会话树分区的
**诚实空态**：`先在 openchamber 里打开一个项目（宿主当前注册的项目数：0）`。

### 5.3 过程中的两个真结论（不是猜的）

1. **面板第一次加载是空白/读不到台账**，加了**逐路径的失败原因**（把 `NOT_FOUND` / `NOT_GRANTED` /
   `BAD_PATH` 原样显示出来）之后一次就通了。
   → **面板宁可说清"为什么读不到"，也不要假装台账是空的**（空台账与读不到是两件事）。
   现在这条诊断留在实现里（见 `readLedger()` 的 `tried`）。
2. **会话树那个空态是对的，不是 bug**：这台 openchamber 当前**注册项目数就是 0**
   （界面本身显示 "Choose project"）。所以面板显示"先打开一个项目"，而不是编一棵空树。

### 5.4 仍未做/未验（如实记录）

- ~~**面板层「零冲突」**~~ → **已补做，见 5.5**（2026-10-19 深夜）
- 扩展在 EL7 上**仍装着**（`source=path` → 包在 `/home/demo/.reeve-ext-src`，能力已批准）。
  要撤：设置 → 扩展 → 移除，或 `rm -rf ~/.config/openchamber/extensions/reeve` 并清 store。
  **这是留给使用者看的**，不是回归测试留下的垃圾。
- 会话树那半边的数据源（宿主会话）在本机没有可展示样本（项目数为 0），
  将来在**真实项目**里打开面板才能看到树 —— 面板代码走的是同一条 `listSessions` 通路。

---

### 5.5 面板层「零冲突」验收 ✅（2026-10-19）

**问**：在 openchamber 的 **Agents 页保存一次**，引擎的配置文件会不会被**静默覆盖**？

#### 前置：这台实例没有项目，保存被**明确拒绝**

面板保存打的是 `POST /api/config/agents/<name>`，服务端要求**项目上下文**。实测（CDP 抓响应）：

```
POST /api/config/agents/zc-zeroconf-probe   → HTTP 400
  body: {"mode":"subagent","description":"...","system":"...","scope":"user"}
  响应: {"error":"Directory parameter or active project is required"}
  UI 提示: "Failed to create agent"          ← **报错，不是静默**
```

→ 没有项目时**一个字节都没写**，而且是**吵的失败**（400 + 可见提示）。
为了测"保存成功时会发生什么"，我在面板的 **Projects 页**（`+` → 输路径 → Add project）
把 `/home/demo/.reeve-staging/work`（我自己的 staging 空目录）注册成了项目。这次保存带上了目录：

```
POST /api/config/agents/zc-zeroconf-probe?directory=%2Fhome%2Fdemo%2F.reeve-staging%2Fwork   → 200
  [dir=/home/demo/.reeve-staging/work]
```

#### 测量：保存前后逐文件比对（hash + mtime）

**新增了且只有一个文件**：

```
.config/opencode/agents/zc-zeroconf-probe.md    88 B   19:17:34   （新建了 agents/ 目录）
  ---
  description: zeroconf probe
  mode: subagent
  ---

  throwaway probe: reply with "probe".
```

**逐字节未变（hash 与 mtime 都是原来的）**：

| 文件 | 为什么盯着它 | 结果 |
|---|---|---|
| `~/.config/opencode/opencode.jsonc` | **符号链接**到 `/mnt/hgfs/OpenCodeConfig/...`（三端共享配置） | `517f8ef4…` / 08-07 17:20 未变 ✅ |
| `~/.config/openchamber/opencode.managed.json` | 被管引擎的配置，里面是 openchamber 的 `plugins` 数组 | `28ba2a8d…` / 10-18 23:33 未变 ✅ |
| `.reeve-staging/.config/opencode/opencode.json` | REEVE 的插件 + 8 agent + limits | `47dae0dd…` / 18:49 未变 ✅ |
| 8 个 `agent/*.md` + 7 份 rubric + SKILL.md | REEVE 的编排内容 | 全部未变 ✅ |
| `~/.config/opencode/` 其余 17 个文件 | 生产 v1 的配置目录整体 | 文件集与 hash **逐字一致** ✅ |

**结论**：

1. **没有任何静默覆盖**：面板保存**只**新建一个 user 作用域的 agent markdown，
   **不重写任何 JSON、不动 `plugins` 数组、不碰那份三端共享的 symlink 配置**。
   它写的是"新增一个 agent 文件"——这正是 openchamber#3881 里的**那条机制**
   （config 目录里的 agent 文件对预设是**覆盖**关系），所以**REEVE 的插件绝不写这里**（机制层已验）。
2. **失败模式是吵的**：缺项目上下文时 400 + 界面提示，什么都没写。
3. 保存前 `agents/` 目录**不存在**（新目录由面板创建）；删除后该目录已清空并移除。

#### 清理与留下的痕迹（如实列）

| 项 | 处置 |
|---|---|
| 探针 agent 文件 | ✅ **已删**（走面板自己的 `DELETE /api/config/agents/:name`，返回 `{"success":true}`；复查 `md.exists=false`；空的 `agents/` 目录已 rmdir） |
| `~/.config/opencode/` | ✅ **回到原状**（文件集与 hash 与保存前一致） |
| **注册的那个项目** | ⚠️ **仍在**：openchamber `settings.json` 的 `projects` + 被管引擎 `project` 表里多了一行 `worktree=/home/demo/.reeve-staging/work`（引擎共 9 行）。**该实例当前的活动项目也是它**。删不掉的原因：面板没有"移除项目"入口；我试过 `PUT /api/config/settings` 去掉 `projects`/`activeProjectId`/`lastDirectory`，**服务端立刻按引擎的项目表同步回来了**；剩下唯一的办法是写被管引擎的 SQLite —— 那是**在跑着的引擎**上做 DB 手术，我没做 |
| `settings.json` 的 6 个键 | ⚠️ 我那次 PUT 把服务端归一化出的默认键写实了（`collapsibleThinkingBlocks`/`inputHistoryLimit`/`inputHistoryScope`/`pinnedDirectories`/`pwaOrientation`/`showReasoningTraces`）——都是默认值，**没有用户数据被覆盖** |
| openchamber 自己的文件 | 本来就会变（`logs/`、`preferences.json`、`skills-github-meta.json`） |

**给使用者的清理办法**：设置 → Projects 里若有移除入口就用它；
否则在 openchamber 里把活动项目切回你常用的那个（本项目条目在引擎的项目表里，
下次引擎重建库或你删除 staging 目录后它会变成一个悬空条目，**无副作用**）。

---

## 步 5 legacy 检查表（保留原始验收项对照）

**前置**：步 2。

| 检查项 | 结果 | 日期 |
|---|---|---|
| 面板能看到子任务状态与台账 | ✅ **已验**（CDP 读 iframe DOM + 截图） | 2026-10-19 |
| 保存配置后插件正确读到 | ⚠️ **未验**（只读面板不做保存；见 5.4） | — |
| 无任何双写冲突 | ✅ 机制层已验（插件无写路径 + 配置 mtime/hash 不变） | 2026-10-19 |
