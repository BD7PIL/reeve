---
name: visual-gate-repair-loop
description: 把交付协议的视觉门修复循环（render → visual-judge → repair → 重判，cap N，fail-closed）落成声明式 workflow 声明的流程契约：循环如何展开成冻结 DAG（拓扑承担循环）、评审结论为什么不编码成校验错误（schema 承担验收）、cap 耗尽怎么 fail-closed（escalation 承担人裁决）、步间数据为什么走工作区文件（冻结声明无结果引用）。附伴生声明 declaration.json 与 mock driver 的 fixture 端到端。
when_to_use: 要把「渲染→视觉评审→修复→重判→放行/拦下」这类交付门循环写成 engine-run 声明，或评审、改造既有视觉门声明时使用。视觉门 = 交付前以渲染图为证据的裁决闸门（deck 渲染评审、UI 面板截图评审、文档版式检查同族）。不适用于：非交付型的自由迭代（没有闸门语义）；轮数要按当轮发现动态增减的场景（那是运行中交接 hole 的事，见父契约 §8.3）。
license: Apache-2.0
---

# 视觉门修复循环（declarative 流程 skill 首例）

> 本 skill 是**流程转换**：把一套已在用的交付协议（ppt-master visual-review 的迭代预算与 fail-closed 纪律、UI 面板截图评审的「截→评→改→再截 ≥N 轮」多模态迭代）转写成声明式 workflow 声明。创作判断以父契约为准（本目录上级 `SKILL.md`），本文只写**这门循环特有**的映射与纪律；运行时语义（resume / escalation / hole / amend）见父契约 §8。
> 伴生声明：本目录 `declaration.json`（cap N=1，5 步）。fixture 端到端（mock driver，全合成）：reeve 仓 `plugin/test/engine-skill-visual-gate.test.mjs`（夹具 `plugin/test/fixtures/engine/skill-visual-gate.json` = 本声明逐字节拷贝，改任一侧须同步另一侧）。
> 分发载体随父契约：OpenCodeConfig 仓库维护，经 `.zcode/sync-skills.cmd` 同步用户域。

## 0. 管什么，不管什么

- **管**：把「渲染→评审→修复→重判→放行」循环写成冻结 DAG 声明的全部判断——循环怎么展开、评审结论怎么编码、cap 怎么选、fail-closed 怎么落地、no-op 步的代价怎么算。
- **不管**：rubric 内容本身（逐条硬/软规则是各交付域自己的资产，声明只引用路径）、渲染器实现（协议里它是纯渲染工具，不读规则）、引擎怎么调度（父契约 §0）。

协议原型（声明出现前的形态）是**主代理自持循环**：自己截、自己评、自己改、自己决定几轮——循环、预算、拦下全在一个上下文里。声明化的动机与代价同样清楚：每一拍获得独立的会话边界（journal 记账、可 resume、可单独重跑、评审员真·新鲜眼睛），代价是**拓扑冻结**——声明式没有分支与循环（父契约 §1.4），循环必须展开成已知形状。

## 1. 协议 → 声明的四条映射（本文核心）

### 1.1 拓扑承担循环：cap N 展开 = N 个判 + N 个修 + 1 个闸门，最后一步必须是判

`render → judge-1 → repair-1 → judge-2 → [repair-2 → judge-3 → …] → gate`

- **判修交替、放行建立在判上**：每轮修复后必须重判，且 gate 的上游必须是 judge 而非 repair——修复者自己的「改好了」不是放行证据，新鲜眼睛是闸门的一半。
- **cap N 是展开参数**：修复预算 N 轮 → N+1 个判 + N 个修 + 1 个闸门 = 2N+2 个工作步（N=1：judge-1 → repair-1 → judge-2 → gate，共 4 步），另有 1 个 render 垫底。N 在写声明时定死——这不是限制，是协议本来的预算纪律（「默认 1 轮，加轮要显式 opt-in，每加一轮渲染与 token 成本近翻倍」）。
- **no-op 步是拓扑税，照付**：上轮已 pass 时，后置的 repair / judge / gate 步**照常跑**（冻结 DAG 无分支），靠 prompt 里的 no-op 契约把代价压到最小：repair 见 pass → 不改任何文件产出 `{"action":"noop"}`；judge 见上轮 pass → 确认性复扫。声明式用「便宜地跑过」替代「不跑」——判断问句：这笔税换独立会话边界，值不值；不值，说明这门循环还不该声明化。
- **prompt 自含每拍的契约**（父契约 §1.1）：render 拍写渲染产物路径与「渲染失败不阻塞」；judge 拍写 rubric 路径、发现文件路径、verdict 两值的语义；repair 拍写 no-op 条件与 don't-touch 清单；gate 拍写 deliver / blocked 两出口与问句要求。步间数据零结果引用（§1.4），全部走**工作区固定路径**：发现文件 `<project>/.review/findings-r<N>.json`、渲染清单 `<project>/.preview/render-manifest.json`——deps 只表达先后，数据在盘上。

### 1.2 schema 承担验收：评审结论是合法产出值，绝不编码成校验错误

这是本循环最容易被写错的一处（父契约 §6 的声明式特有纪律）：

- **`verdict: "fix"` 必须放行**。judge 步的 schema 对 `pass` 与 `fix` 一视同仁（都给全字段就过）。把「有硬伤」写成校验失败，触发的是 **judge 步自己的 maxAttempts 重派**——引擎拿着「你评出问题了」去罚评审员重评，循环方向整个反了：正确的推进是下游 repair 步（拓扑），不是上游重评（重派）。
- **maxAttempts 只扫格式坏档**：产出不是合法 JSON、缺 `findingsPath`、`hardHits` 是字符串——这才烧重派（默认 3 含初派；重派附上次校验错误，末次附 nudge，父契约 §1.4/§2）。它治「评审员没按契约交报告」，不治「交付物有伤」。
- **校验器子集要知道**：引擎 `validateValue` 执行 type / required / properties / additionalProperties:false / items / minLength / maxLength / minimum——**`enum` 不在子集里**（写了不报错也不生效）。所以伴生声明把枚举语义写进 `description`（"\"pass\"=零硬伤；\"fix\"=…"），不依赖 enum 键。收紧用 `required` + `additionalProperties:false` + `minimum`。
- **发现文件窄、结论文件全**：verdict / hardHits / findingsPath 进步结果（进 journal、进重派错误），逐条 evidence 留在盘上 findings 文件——传路径不传内容（父契约 §2）。

### 1.3 escalation 承担 fail-closed：cap 耗尽不是循环，是问句

fail-closed 的原文语义：**cap N 用尽仍不过门 → 不交付，也不发明第 N+1 轮自动续命**。声明式里的落地形状：

- gate 步两个出口都在 schema 里：`deliver`（hardHits=0 才许用）与 `blocked` + 非空字符串 `question`。**给问句留形状**（父契约 §8.2）：gate 的 schema 必须允许 `{verdict:"blocked", …, question}`——诚实升级优于硬凑 deliver。
- 问句判定口径（全引擎唯一事实来源，escalation.js）：done 产出是合法 JSON 对象且带非空字符串 `question` 键。运行方配 `run(decl, { escalation: { onEscalate, answerFor? } })` 才识别；**notify-only（只配 onEscalate）且只剩挂起步 → run 终局 `blocked(reason='escalation-pending')`**——这就是「拦下」的机读形状。
- 问句要可裁决：把选项和后果写全——放行带伤交付（记录取舍）/ 追加修复轮（**那是 hole 的事**：第二份声明按发现改拓扑，运行中 `hole.pull` 交入，父契约 §8.3）/ 放弃。答复经 answerFor 回来，escalationPrompt 以「原 prompt + 问句 + 答复」重派 gate 新会话。
- 两条通道不互相冒充（父契约 §6/§8.2）：**格式坏档走重派（机器循环），交付不过门走 escalation（人裁决）**。gate 步的 maxAttempts 治它不交报告，不治交付有伤。

### 1.4 判与修必须分步：粒度按「重来的单位」切

评审、修复、复判缝进一个 prompt（协议原型的单会话循环）在声明式里是**太粗**（父契约 §1.2）：重派整步重来、重判失去新鲜眼睛、journal 只有一笔糊涂账。判修分步后每拍都是独立会话——judge-2 看不到 judge-1 的过程，只看渲染图、rubric 与盘上发现文件，这是协议「独立复核」的机制化而不是姿态。同族协议里评审按页批分批（K 页一批），声明式的宽变体就是把扇出写宽：`render → {judge-a, judge-b, …} → {repair-a, repair-b, …} → judge-final → gate`——同层并行是墙钟收益，gate 汇聚一处裁决（父契约 §1.3）。

## 2. 伴生声明导读（declaration.json，cap N=1）

| 步 | deps | 出口 schema 要点 | 拍 |
| --- | --- | --- | --- |
| `render` | — | manifestPath / rendered / renderFailed；timeoutMs=600000（渲染慢，显式放宽） | 渲染全部页面，失败页记清单不阻塞 |
| `judge-1` | render | verdict / findingsPath / hardHits，**fix 与 pass 都放行** | 首轮评审，发现落 findings-r1.json |
| `repair-1` | judge-1 | action(fixed\|noop) / editsApplied / findingsPath | pass → no-op；有发现 → 原子修复 + don't-touch |
| `judge-2` | repair-1 | 同 judge-1 的形状（新 findingsPath） | 重判：复核动过的元素 + 确认性复扫 |
| `gate` | judge-2 | verdict(deliver\|blocked) / rounds / hardHits / question（留问句形状） | fail-closed 闸门：deliver 或挂起问句 |

- stepId 族前缀成幕（父契约 §3）：`judge-*` 是评审幕、`repair-*` 是修复幕——读图即读协议。
- 不写 `agent` / `model`：模型选择是用户的决定（父契约 §5）；要机制化「新鲜眼睛」时给 judge 步换一个与写手不同的 agent。
- 改这张表 = 改 prompt 字节面 = amend 不导入该步（父契约 §8.4）——rubric 版本升级这类会变的引用，改路径外置（编排层给路径），让 prompt 字节稳定。

## 3. 运行时行为对照（fixture 各 leg 验证的就是这张表）

| 协议语义 | 引擎落点 | 谁验收 |
| --- | --- | --- |
| 循环推进（判→修→判） | deps 链的拓扑序派发，无分支无循环 | 调度器 `run` |
| 评审结论 fix = 正常推进 | fix 是合法 done 产出，**零重派**（judge create 恰 1 次） | schema（typedAsk）只拒坏格式 |
| 产出格式坏档 | maxAttempts 重派，附上次校验错误，末次 nudge；耗尽步 failed 不冒泡 | 步级核心 `typedAsk` |
| cap 耗尽仍不过门 | gate 产问句 → running→blocked + escalated 审计 + onEscalate 恰一次；notify-only 终局 blocked(escalation-pending) | 调度器 escalation 选项 |
| 拦下不交付 | run 不 completed，无 deliver 产出；步留 blocked 等人 | 同上 |
| 中断后续跑 | resume(decl, journal)：done 拍零 driver 调用返还，pending 拍重跑（父契约 §8.1） | resume + 接线 |

**两层分工（父契约 §8 前言）要照实用**：调度器 `run` 只按 driver 状态收敛（done 即产出），**不逐步做 schema 验收**——验收与重派在步级核心 `typedAsk`，由调用方接线。所以同一条链有两种跑法：要 DAG + 问句挂起（escalation 只有调度器识别）走 `run`；要逐拍验收坏档重派走 `typedAsk` 逐步接线（S6/S8 试点同款 idiom）。fixture 对两层各覆一半（§4）。

## 4. fixture 端到端（mock driver，全合成）

- **位置**：reeve 仓 `plugin/test/engine-skill-visual-gate.test.mjs`；夹具 `plugin/test/fixtures/engine/skill-visual-gate.json` = 本目录 `declaration.json` 逐字节拷贝（纯声明体；喂引擎的文件不带头注，改任一侧同步另一侧）。已入 `plugin/package.json` test 枚举链。
- **跑法**：`cd <reeve>/plugin && node test/engine-skill-visual-gate.test.mjs`（或随仓 `npm test` 全链）。
- **合成纪律**（规格 §6）：mock 场景内联全合成；不引用 `fixtures/engine/replay/` 录制件；clock 经构造参数注入（manualClock），fault 面（failWrite/driverChaos/abortAt）由引擎自有门覆盖，本夹具传 null。
- **四 leg 断言表**：

| leg | 场景脚本 | 断言核心 |
| --- | --- | --- |
| A 已清洁交付 | judge-1=pass → repair-1=noop → judge-2=pass → gate=deliver | run completed；**repair-1 照跑**（create 序含它）但产出 noop——拓扑税的行为证明；无重派 |
| B 一轮修复后交付 | judge-1=fix(2) → repair-1=fixed(2) → judge-2=pass → gate=deliver | run completed；**judge-1 的 fix 未触发重派**（judge-1 create 恰 1 次、prompt 无 retryPrompt 前缀）——「评审结论不编码成校验错误」的行为证明；journal 链合法、engine-owned 会话逐一记账、零 context 调用 |
| C cap 耗尽拦下 | judge-1=fix → repair-1=fixed → judge-2=fix(1) → gate=blocked+question | notify-only escalation：run **blocked**(escalation-pending)、escalation[0].stepId=gate、onEscalate 恰一次、盘上 escalated 审计恰 1 条、gate 留 blocked、**无 deliver** |
| D schema 验收（typedAsk 层） | judge-1 第 1 次产出缺 findingsPath → 第 2 次（retryPrompt 组装）合格 | attempts=2；重派 prompt 与 `retryPrompt` 导出件逐字符相等、无 nudge（非末次）；同一 schema 放行 fix 与 pass、拒缺 findingsPath——声明里的 schema 是可执行的验收契约 |

## 5. 反模式表（本循环特有；通用的见父契约 §5）

| 你写的声明 | 代价 |
| --- | --- |
| 把 `verdict:"fix"` 编码成校验错误（schema enum 白名单只许 pass，或 validate 回调拒 fix） | 触发 judge 自己重派：评审员被罚重评、repair 永远派不出去、循环方向反了（§1.2） |
| 评审+修复+复判缝进一个 prompt | 太粗：重派整步重来、重判失去新鲜眼睛、journal 一笔糊涂账（§1.4、父契约 §1.2） |
| cap 展开写 5+ 轮 | 每轮 = 2 步真钱 + no-op 税；预算纪律是「缺省 1，加轮 opt-in」（§1.1） |
| gate 缺问句形状（schema 不收 question） | blocked 时诚实升级出口被自己的验收契约堵死，逼出硬凑 deliver（§1.3） |
| gate 上游是 repair（无终判） | 修复者自评放行；最后一步必须是判（§1.1） |
| 逐条 evidence 塞进步结果 schema | 进 journal、附进重派错误，两头花 token；传 findingsPath（§1.2、父契约 §2） |
| repair prompt 不写 don't-touch 清单 | 修复步越权改 brand/结构/文案——原子修复边界只活在 prompt 里（§1.1） |
| 在声明里找「上轮 pass 就跳过」 | 冻结 DAG 无分支；写 no-op 契约照付拓扑税，或别声明化（§1.1） |
| deliver 出口不卡 hardHits=0 | fail-closed 漏底：带伤放行有了机读通道；hardHits 语义只在 description/require 里（§1.3） |

## 6. 写前检查单（视觉门特有；通用的过父契约 §7）

- [ ] 判修交替、gate 收尾，上游是 judge 不是 repair
- [ ] 每个 judge 的 schema 放行 pass 与 fix 两种值；坏格式（缺字段/类型错）才拒
- [ ] gate schema 留了 `question` 形状；gate prompt 写明 blocked 出口的可裁决问句要求
- [ ] findings / manifest 都是固定路径，prompt 自含路径；步结果只传路径与计数
- [ ] repair prompt 有 no-op 契约与 don't-touch 清单
- [ ] cap N 按疼痛选（缺省 1），展开式（N+1 判 + N 修 + 1 闸门 = 2N+2 工作步，加 render 共 2N+3）数过
- [ ] 跑法想清楚了：DAG + 挂起走 `run`（配 escalation 选项），逐拍验收走 `typedAsk` 接线（§3）
- [ ] fixture 端到端过 mock driver（本 skill 的门：reeve 链内 `engine-skill-visual-gate.test.mjs` 四 leg 全绿）
