---
name: declarative-workflows
description: "reeve 引擎 workflow 创作契约（脚本路径为主，声明为简单路径）。触发条件：请求是多步编排、动态工作流（dynamic workflow/工作流编排——本 skill 即 reeve 版 dynamic workflows）、长程 job、需要确定性门禁（F.run 机器裁决）或人裁决挂起（hole/escalate）时主动使用；也用于写、调试、重跑、补段（hole patch）reeve workflow 脚本，或评审、修改、排障既有脚本与声明文件。单次委派或几个独立查询不适用（直接委派即可）。"
when_to_use: "多步编排 / 长程任务 / 需要门禁的请求 → 主动使用。复杂编排（动态控制流：循环到门禁绿、分支、逐项流水线、阶段间传值）走脚本路径（§1–§10）；脚本失败后的机械化修订走补段章（§12）；简单流程（拓扑一次画得完的 DAG、可能要改常数重跑）走声明章（§11）。"
license: Apache-2.0
---

# reeve workflow 创作契约（脚本为主）

> 本 skill 是 reeve 引擎两代 workflow 前端的**创作契约**：脚本路径（M2.1–M2.4 落地面，本文件主体）
> 与声明路径（冻结面，降级为简单路径章 §11）。
> 判断层改编自 ZCode 随包 skill **dynamic-workflows**（Apache-2.0，翻译改编，非原样副本）：
> 拓扑纪律、新鲜眼睛、world.run 门禁纪律、报告形状、反模式表照搬翻译到 reeve 脚本表面；
> 与原表面的全部差异逐条列在附录 A（六 + 二条），威胁模型边界见 §1。
> 归属与改写对应关系见本目录 [THIRD-PARTY.md](THIRD-PARTY.md)，许可原文见 [LICENSE](LICENSE)。
> 命名维持 `declarative-workflows`（避让 ZCode 自带 dynamic-workflows skill）。
> 分发载体（双发行单元，内容同源、改一必改二）：① reeve 插件包随 npm 分发（`plugin/skills/declarative-workflows/`，opencode 宿主）；② OpenCodeConfig 仓库（`.zcode/skills/`）经 `.zcode/sync-skills.cmd` 同步到用户域 skill 目录（`%USERPROFILE%\.zcode\skills`，ZCode 宿主）。
> 落地面出处：reeve `plugin/src/engine/`（script-runner / resume-script / script-patch / pgate / driver-session / salvage-report），可视化已落地（D0-D3：面板步卡/DAG/审批卡 + mermaid 报告）。

## 0. 分流：声明还是脚本，还是都不用

| 请求形状 | 用什么 |
| --- | --- |
| 一件事委派一个代理，或几个互不相干的独立查询 | 直接委派——不进引擎 |
| 简单流程：拓扑一次画得完（无分支、无循环、无逐项流水线），可能要改常数重跑 | **声明**（§11）——纯数据 DAG，amend 按步便宜重跑，steps+deps 直渲 DAG |
| 复杂编排：循环到门禁绿、按结果分支、逐项流水线、阶段间要传值、长程 job 需要门禁与人裁决 | **脚本**（§1–§10）——函数体 + facade，控制流就是普通 JavaScript |
| 两个都写得出来时 | 按"改常数重跑的频率"选：经常调参 → 声明（matchAmend 逐字导入）；一次性编排 → 脚本 |

脚本路径的心智模型一句话：**脚本 = 一次完整的编排程序**。你写的不是配置，是一段普通
JavaScript——`Promise.all`、`for` 循环、`if` 分支都是你的；引擎只提供六个 facade 成员（§1）、
一个确定性沙箱（§1）和一条 journal 台账（§10）。所以脚本路径的能力上限就是 JS 的能力上限，
纪律上限也一样——下面各章是把 dynamic-workflows 的判断纪律翻译到这个表面。

## 1. 脚本是什么：函数体 + facade + 沙箱边界

**脚本是裸函数体。** 你提交一段 ESM JavaScript（或 TS）函数体源码，引擎原样包装为
`async function main(F){…}` 在 Node vm 沙箱里执行：顶层 `await` 天然可用，最后的 `return`
值就是 run 的结果。**TS 脚本（文件名 .ts）= TS 语法 only**：插件自带 esbuild 把类型剥掉后按
同一包装喂 vm——**没有类型检查器把关**（类型注解错了也不报，esbuild 只剥不查）；结果形状的
把关仍在运行时 schema 校验（§4）。两条 TS 纪律：① **坐标系唯一 = .ts 源文本**——ask 作用点
证据、补段边界都落在 .ts 源码上（引擎经 sourcemap 把 vm 栈坐标映回源码），改尾部/改头部的
resume 语义与 JS 逐位一致（§9）；② esbuild 平台二进制缺失时 **.ts 显式报错、禁静默回退
JS**——装好依赖再跑。JSDoc `@schema` 注释不合成 schema（schema 仍走 `F.ask` opts 显式给，
§4）。没有 `import`——函数体包装天然禁止（动态 `import()` 同样炸），**F 就是全部依赖**。

**facade 六成员（脚本可见的全部）**：

| 成员 | 签名 | 语义 | journal 事件 |
| --- | --- | --- | --- |
| `F.ask(instructions, opts?)` | opts=`{schema?, agent?, model?}` | 一次完整子代理会话：派发 + 等终态 + 解析末条回复；给了 schema 则产出必须是合法 JSON 且过校验（返回校验后的对象），没给则返回回复文本。校验不过自动重派（3 修 1 催，§4）；耗尽 → 抛错（§10 打捞） | `ask` / `ask-failed` |
| `F.run(cmd, args?, opts?)` | opts 只收 `timeoutMs` | 进程内 spawn 一条真实命令，`{exitCode, stdout, stderr}`（非零退出码是**值**不是异常；超时/启动失败另有 `timedOut` / `spawnError` 字段，启动失败时 exitCode 为 null）。命令字面量静态扫描进评审（§5） | `run` |
| `F.phase(name)` | 非空字符串 | 阶段标记：journal 记一笔，可视化按它画时间线（M2.5 落地前只有台账）。给每段工作开头标一个（§2） | `phase` |
| `F.hole(name, prompt)` | 两个非空字符串 | 挂起问人：journal 记账 + 通知回调 + 等答复字符串；答复作为返回值回到脚本手里（§7） | `hole` / `hole-answered` |
| `F.escalate(question)` | 非空字符串 | `F.hole` 的语义别名（不带 name，只带问句） | `escalate` / `escalate-answered` |
| `F.log(message)` | 非空字符串 | 叙事行：进 journal，也走报告流出口——给看 run 的人读（§10） | `log` |

**确定性沙箱（fail-closed）**：沙箱 globals 是白名单——`console`（路由到报告流）、`Promise`、
`JSON`、`Math`（**已删 `Math.random`**）、引擎注入的时钟 `now()`。`fetch` / `fs` / `process` /
`Date` / `setTimeout` 一概**不存在**：碰 `Date.now()` 或 `fetch` 是 `ReferenceError`，碰
`Math.random()` 是 `TypeError`——违例即脚本失败，没有静默降级。这不是 stylistic 约束：
resume 按"前缀有效逐 ask 返还首跑值"工作（§9），任何非确定源都会让重跑分叉。

**威胁模型（边界，先读这个再写脚本）**：Node vm **不是安全边界**（Node 官方文档明示）。
globals 白名单**防误用不防恶意**——它保证你写错的脚本碰不到 `fs`/网络/定时器（fail-closed），
但不保证一段**故意**绕白的脚本草木皆兵也算安全。v1 威胁模型 = **自家脚本防误用**：脚本由
本会话（或本机信任的编排方）撰写，经 review_gate 登记（§9，命令字面量进评审）后才跑；
防恶意 = 进程隔离（v2 后备，v1 没有）。结论两条：① 不要把不可信的第三方脚本喂给这个引擎；
② 登记评审（§9）是运行前唯一的闸门，别绕。

## 2. 拓扑纪律（翻译自原 §2 / §7）

**每次 `F.ask` 是一个全新会话**（自己的上下文、自己的工具，跑完即散）。原表面"共享上下文的
标定评审员"（一个 `agent()` 跨多次 ask 记上下文）在本表面**没有对应物**——新鲜眼睛是缺省且
唯一的模式。要"标定"（后一个裁决与前一个一致），把此前的裁决序列化进下一条指令：

```js
// 标定的唯一写法：状态在指令里，不在会话里
const verdicts = [];
for (const item of items) {
  const v = await F.ask(`继续评分。此前裁决：${JSON.stringify(verdicts)}。评这一项：${item}`);
  verdicts.push(v);
}
```

**扇出 = `Promise.all`，串行 = 循环里 await，只有有意时才写后者**：

```js
// 并发：join 之前谁也不等
const all = await Promise.all(paths.map((p) => F.ask(`评审 ${p}：…`, { schema: Review })));

// 串行：每个 await 挡住下一个。只有裁决依赖前一项时才这么写
for (const p of paths) results.push(await F.ask(`评审 ${p}：…`, { schema: Review }));
```

宽度是墙钟不是正确性：引擎侧的 ask 并发帽（编排方 `cap` 选项，facade 内排队）超了就排队，
不失败。想并行的独立工作放开写宽；provider 限流是引擎的事，别用把脚本写串行来"预防"。

**序号即身份。** 原 surface 里子代理名字是 resume 的匹配键；本表面没有名字——**ask 的执行
序（callSeq）+ 调用点位置是身份**：每次 `F.ask` 在同步入口第一行领一个序号，同时抓下调用点
（脚本体 line:col）与 prompt 哈希落在 journal 事件里（§9 的 resume 导入证据），journal 事件与
driver 锚点（`script-ask-<序号>`）都用序号。三条不变量引擎已保证（重派与缓存命中不耗序号；
沙箱无非确定源；命中值恒等首跑值），对作者的推论只有一条：
**别让 ask 的发起数量与顺序依赖沙箱外的任何东西**——那本来也写不进去。

**逐项链 vs 全量 join**（翻译自原 §7 的表）：

| 下一步怎么吃 | 写法 |
| --- | --- |
| 一次吃一项（评审完一个文件就送确认） | 扇出回调里把两段链起来，最后 join 一次 |
| 一次要全部（去重、统一排序、汇总、最终报告） | `Promise.all` 全量 join，旁边注释为什么需要全部 |

```js
// 逐项链：一个文件的评审一落地，它的发现立刻送去确认；
// 两个全量 Promise.all（先全部评审、再全部确认）才是 barrier
const confirmed = (
  await Promise.all(
    paths.map(async (p) => {
      const review = await F.ask(`评审 ${p}：…`, { schema: Review });
      const verdicts = await Promise.all(
        review.findings.map((f) => F.ask(`独立复核：${JSON.stringify(f)}`, { schema: Verdict })),
      );
      return review.findings.map((f, i) => ({ ...f, status: verdicts[i].holds ? 'verified' : 'unconfirmed' }));
    }),
  )
).flat(); // 唯一的 join：最终汇总要全部项
```

一个 ask 抛错（§10：耗尽即抛）会拒掉整个 `Promise.all`，连同兄弟结果。一个坏项只该赔一项时，
在回调里 catch，或用 `Promise.allSettled` 逐项读结果。

**循环有界 + 反馈前带**：门禁驱动的修复循环写法见 §5；循环上限写死在脚本里（reeve 不设
轮数帽——永不收敛的脚本烧的是真钱，比原表面"死在帽上"更贵）。跨轮复用 = 把上一轮反馈拼进
下一条指令；每次 ask 本来就是新会话，**别指望第四轮记得第三轮**。

原表面的 `channel` / `future` 原语在本表面不存在（附录 A 未单列——它们属于 facade 形状差异
的教学注记）：流水线用上面的逐项链写法表达，反馈环用一个有界 `for` 循环 + 计数表达。

## 3. 新鲜眼睛（翻译自原 §3）

计划或草稿的作者看不见它的洞——写的时候已经把洞填上了。独立上下文的读者没有这份填充，
洞才显形。本表面每次 `F.ask` 天然独立上下文，所以这条纪律只剩"用对"：

- **要失败，不要批准。**"这好不好"得到"好"。评审 ask 问：会坏在哪？缺什么？用自己的话把
  方案复述一遍——复述不出的地方就是洞。把批准写成需要证据的动作（`{approved, findings[]}`
  里 approved=true 必须跟着证据）。
- **给评审同样的证据。**只凭文本只能评连贯性：评审 ask 里指名去读方案动过的文件——以及
  "不修改任何文件"。
- **成文产出配一次独立审读。**交付物是文本本身（指南、分析）时，在 return 之前交给一个
  只凭文本挑毛病的 ask：哪里不清楚、哪里文本支撑不了、读者下一句会问什么；然后改掉。
  说清它只判文本——核对事实是确认者（§6）的事。
- **一份产出，一个复核机制。**计划配评审 ask；发现类产出配独立确认 ask（另一会话只凭证据
  复现，评审者不确认自己，§6）；成文产出配一次审读。两个是上限，且要能说出理由。

三条告诫照搬：同模型的同提示评审员盲区也相同——给每双眼睛不同的镜头；别把这套纪律错用成
提交前的门（自己把脚本对照请求读一遍）；每一层 `Promise.all` 问一句"下一步真需要全部项吗"，
不需要就逐项链（§2）。

## 4. 显式 schema 对象（翻译自原 §4；偏差 A.2 / A.8 的教学面）

`F.ask` 的 `opts.schema` 传一个**显式 JSON Schema 对象**——它是该次产出的**验收契约**：
子代理的末条回复必须是合法 JSON 且过校验，不过则自动重派并把上次的校验错误附进重派指令
（`maxAttempts` 缺省 3 = 初派 1 + 重派 2，最后一次重派附一句催促；耗尽 → 该 ask 抛错）。

**校验引擎认的關键字是子集**：`type` / `required` / `properties` / `additionalProperties:false`
/ `items` / `minLength` / `maxLength` / `minimum`。**`enum` 目前只是文档不是强制**——枚举收窄
写进指令文本（"severity 只能取 low|medium|high"），schema 里照样写（给评审者读）；硬闸是
required、类型、长度。

**指令与 schema 是同一契约的两次表述，缺一不可**：子代理**第一次派发读不到 schema**（重派
时才从校验错误里学到形状）——首派指令必须自己写清产出形状（"只回一个 JSON 对象，形如
{…}"）。schema 的 `description` 是给作者、评审者与未来工具读的，校验错误不带它——description
仍然每条都写：它是最便宜的质量杠杆，也是 §5 评审面对产出的核对依据。

**结果要窄。**产出会进 journal 事件、失败时附进重派指令——宽 schema 两头花 token。
**传路径，不传内容**：子代理有自己的文件工具，把整份文件序列化进产出是为它能自己读的东西
付双倍价钱。

## 5. F.run 门禁纪律（翻译自原 §5 world.run）

**确定性门禁。**检查是固定的、机器可判的（构建过、测试绿、proof 过），就用 `F.run` 跑成
命令、按退出码分支，而不是派给一个 ask 然后相信它的转述：

```js
F.phase('跑测试门禁');
const gate = await F.run('npm', ['test'], { timeoutMs: 1_800_000 });
if (gate.exitCode !== 0) feedback = gate.stderr; // 非零是值不是异常；不带 catch
```

非零退出码是**值**：读 `exitCode`，把 `stderr` 带进下一轮反馈。Promise 的拒绝留给"世界没
应答"（启动失败 `spawnError`、超时 `timedOut`）。大输出注意：stdout/stderr 各有 10 MiB 收集
帽（超帽置截断标记，全文不保），journal 只留 512 字符预览——**门禁尽量只读 exitCode**，
要看失败细节就把 stderr `slice` 后用。

**命令写字面量。**命令名必须是字符串字面量：`F.run('npm', ['test'])`。静态扫描只捕
`F.run("…")` / `F.run('…')` 字面量形式进评审（§9）；模板串或变量拼出来的命令**评审看不到**
——不是编译错（这就是普通 JS），是评审盲区，纪律上禁止。运行期的值（路径、轮次号）进
**args 数组**，不进命令名。固定 argv，无 shell：没有管道、重定向、展开。

**先选门，再写门。**动笔前勘察这个仓库有什么检查——package.json scripts、Makefile、CI
配置、README 的"跑这个验证"——按裁决力排序：单元套件裁得比端到端少，端到端裁得比 README
点名的验收命令少。然后两档：**快档**驱动循环轮次；**最强档**是请求真正指向的检查，return
之前真跑至少一次——快档说绿了也算数。慢档给足 `timeoutMs`：跑得更快的替代品是另一个检查，
不是同一个。

```js
F.phase('修复直到单元测试绿');
for (let round = 1; round <= 5; round++) {
  const unit = await F.run('npm', ['test']);
  if (unit.exitCode === 0) break;
  await F.ask(`单元测试失败：\n${unit.stderr.slice(0, 4000)}\n修复它们。不修改测试本身。`);
}

F.phase('交接前跑一次端到端');
const e2e = await F.run('npm', ['run', 'e2e'], { timeoutMs: 1_800_000 });
const verified = e2e.exitCode === 0;
```

仓库里存在而没跑的检查，不是"未覆盖"——是未验证的工作（§10）。

## 6. 验证、报告、交付（翻译自原 §10）

`F.log(...)` 是给看 run 的人的叙事：扇出排开后记一行规模，每轮循环开头记一行。

**按错误代价的比例验证。**验证存在的意义是压低"用户按假信息行动"的代价，所以它去代价
真实的地方：用户会修的 bug、安全论断、要被引用的数字、决策依赖的事实。这类发现**逐条独立
确认**后才到用户面前：第二个 ask 只凭证据复现（读代码、能机器裁的跑命令，永不修改）——
发现它的评审 ask 不确认自己；`F.run` 能裁的用退出码，那是确认本身。确认失败的发现
**保留并标注** `unconfirmed`，绝不静默丢弃。三件像验证其实是浪费的事：机器已裁的发现再派
确认者（退出码就是确认）；没人会当事实行动的产出（诗、头脑风暴清单）派确认者（一次独立
审读到顶，§3）；同一套件被发现者、确认者、门禁各跑一遍（门禁跑一次，ask 里写明
"脚本会在你之后跑全套件，你自己不用跑"）。

**报告形状（return 值纪律）。**脚本最后的 `return` 是交给主会话转述的交接物。返回这个
形状（普通 JS 对象字面量——本表面无 interface 可声明），不是裸数组：

```js
return {
  conclusion: '两三句话，回答用户要的东西。',
  findings: [
    {
      path: 'src/a.ts:42',            // 仓库相对路径，适用时带行号
      problem: '一句话：什么错了，或发现了什么。',
      evidence: '什么证明了它：读过的行，或命令与输出。',
      status: 'verified',             // 'verified' | 'unconfirmed'
      severity: 'high',               // 'low' | 'medium' | 'high'；high 只留给数据丢失、崩溃或错误结果
    },
  ],
  verified: ['这次 run 真跑过的命令与覆盖的文件'],
  notCovered: ['没看或没法查的，以及为什么'],
};
```

四个字段各有读者：`conclusion` 是用户所问的答案；`findings` 带证据与状态，让人分得清
"看到了"与"怀疑有"；`verified` 说这次真的查了什么、怎么查的；`notCovered` 说没查什么、
为什么——"我们没发现什么"与"我们哪儿都没看"的区别就在这。四项全部用会话语言写。这四
字段是下游稳定消费的**契约**——不按此形状，基线经验是各脚本发明自家形状（skill 审计
实测），集成面会碎。

**打捞是结构性的。**脚本 throw = run failed，但 **journal 保留**：已完成的 ask 结果在盘上
`ask` 事件里，run 结果的 `asks` 镜像也带着它们——第十二步死掉的 run 保得住前十一步的成果。
所以纪律是：边走边 `F.log`，报告值最后组装进 `return`；别把"全部发现攒一个大数组"当成唯一
的成果载体——那正是失败时丢掉的东西。机器读盘上 journal 还有一条单命令：
`node plugin/src/engine/salvage-report.js --status <journalPath>` 以状态码退出——0 completed /
1 failed / 2 blocked-escalation / 3 interrupted / 4 journal-torn / 5 unknown（挂起问句未答复
优先于 failed 判出）。

**交付物。**本表面没有 `artifact.*` 发布面（偏差 A.4）：用户要的文件由 ask 指令让子代理写
进工作区、报告里 return 路径（"写到 `out/…` 并返回路径"写进 ask）；用户要的答案就是 return
的报告。可视化的承接在编排方：journal 的 phase / run / ask 事件由面板与 mermaid 报告渲染
（M2.5 规划中——声明路径将直渲 steps+deps 的 DAG，脚本路径按 phase 事件画时间线；落地前
的呈现 = journal 台账与 run 返回值）。

## 7. hole 与 escalate：挂起问人（原 §14/§15 的降级翻译；偏差 A.5）

`F.hole(name, prompt)` / `F.escalate(question)` 把一个**脚本裁不了的阻塞问题**挂起问人：
journal 先落账、通知回调发出、然后脚本在 await 点停住等人。答复是一个**字符串**，作为返回值
回到脚本手里——怎么用是脚本的事（通常拼进后续 ask 的指令）。没有接答复源时挂起会被拒
（引擎不发明答案）；答复源连续抛错会按脚本失败收敛（防热循环）。

**挂起停的是整个脚本的前进，不是已发出的并发**：挂起发生在 await 点——同一时刻在飞的
`Promise.all` 兄弟 ask 会跑完，但脚本在挂起点不再发起新动作，join 会等最慢项。所以别把
hole 放进扇出回调：一个人裁决卡住整批。要"分支停、兄弟继续"，用脚本并发结构表达（挂起放
顶层、兄弟工作已先行扇出）。

**什么时候挂起，而不是写 if 或派 ask**（原 §15 判别表的 v1 版）：

| 缺的是什么 | 用 |
| --- | --- |
| 一个数据（答案、裁决、缺的事实）——脚本知道拿到后干什么 | 派一个 ask；属判断的配新鲜眼睛（§3） |
| 可以枚举的分支 | 写进脚本：typed 结果 + `if` / 循环 |
| 只有 run 的所有者知道的阻塞裁决（门过不去、两条指令矛盾、缺一个数） | `F.hole` / `F.escalate` |
| "接下来的拓扑还没法写" | **没有**编译期 hole——形状要变 = 改脚本 = 从改动点起重跑（§9）。把不确定的形状留给下一次提交，本次只写已知部分 |

hole 是**答案**通道，不是**代码**通道——原表面"按发现生长"（尾部 hole 逐层补代码）在本表面
没有**运行中**的表达面。诚实的替代：已知部分写死，发现类的不确定性用挂起问句拿裁决，拓扑级
的生长走"新脚本 + 重跑"（§9 的前缀导入把代价限在改动点之后）。脚本**失败后**的机械化修订
自 C2（2026-11-23）起有了专门面——**补段 hole patch**（applyPatch → 重评审 → 前缀导入重跑，§12）；
它修订的仍是已写死的脚本，不是编译期类型化缺口。

**把诚实话写进指令。**一句指令只说"让检查变绿"，造假的服从性解读就来了。补上：
"检查不可能过、或你的指令互相矛盾时，不要硬凑——如实产出问句形状让脚本挂起问人。"
（声明路径走 `{question,…}` 产出挂起；脚本路径子代理造不了挂起——**作者侧**的对应纪律是
别写不可能过的门 + 用 §7 的挂起承接"过不去"。）

## 8. 反模式表（翻译自原 §12，改写为脚本形状）

| 你写的脚本 | 代价 |
| --- | --- |
| 把整份文件塞进 ask 指令 | 子代理本可自己读；传路径（§4） |
| 结果 schema 无 description，或干脆不给 schema | 字段靠猜；校验错误不带语义，重派烧的是整次会话（§4） |
| schema 里只靠 `enum` 挡值 | enum 不在强制关键字子集；枚举收窄写进指令，硬闸是 required/类型/长度（§4） |
| 首派指令不写产出形状（"给 schema 就行"） | 子代理首读不到 schema；非法 JSON 直接烧掉一次尝试（§4） |
| 宽结果 schema（全文回传、字段大而全） | 进 journal、附进重派指令，两头花 token（§4） |
| 该 `F.run` 裁的检查派给 ask | 会话价钱买一个能当值读的退出码，且转述可造假（§5） |
| `F.run` 命令用模板串/变量拼 | 静态扫描捕不到——评审面看不到这条命令；运行期的值进 args（§5） |
| 门禁按习惯写，或只跑单元档 | 仓库点名了更强的检查；勘察后让最强档 return 前真跑一次（§5） |
| 无界循环（while true 修复、无限重试） | reeve 不设轮数帽：永不收敛的脚本烧真钱；上限写死在脚本里（§2/§5） |
| 发现攒数组、最后才 return | 失败时 return 不存在——打捞靠 journal/asks 镜像；边走边 log，报告最后组装（§6） |
| 评审 ask 问"好不好" | 得到"好"；问会坏在哪、缺什么、复述一遍（§3） |
| 同一检查跑三遍（发现者、确认者、门禁各一遍） | 一次裁决性检查就够；退出码即确认（§6） |
| 确认失败的发现悄悄丢掉 | 真问题失去人眼；保留并标 `unconfirmed`（§6） |
| 在扇出回调里挂起 hole | 一个人裁决卡住整批 join；挂起放顶层（§7） |
| 问句问 if 能裁的事 | hole 挂的是整个脚本；可枚举分支写脚本里（§7） |
| 指令只说"让检查变绿" | 造假是服从性解读；补"过不去就如实说"（§7） |
| 问句问得不可裁决（"怎么办？"） | 人看到的就是问句字符串；把要什么决定、有哪些选项写全（§7） |
| 改 ask 之前的字节指望零成本 | 前缀导入按位置截断——调用点之前一变，该点起全重跑；把可调常数放执行流尾部或做成挂起答复（§9） |
| 指令里写死墙钟时间（"现在几点就怎样"） | 沙箱无 `Date`；时间只有引擎 `now()`——把它拼进指令只会让重跑语义变含糊（§1） |
| 依赖 `F.run` 全文 stdout 做门禁 | 收集帽 10 MiB 截断、journal 只留预览；门禁读 exitCode，细节用 `slice`（§5） |
| phase 滥用（每个 if 分支一个、名字写机器词汇） | 时间线是给人看的故事；一段工作一个标记，名字用人话（§2） |

## 9. 登记与重跑（review_gate 脚本接入；偏差 A.3 / A.6）

**登记。**脚本是盘上的裸函数体文件，经 `review_gate.register(planPath, kind:"workflow-script")`
登记：语法门用与执行**同一个包装**判定（登记过 = 执行一定能编译，零分叉）；`F.run` 字面量
命令集静态扫描进评审；**哈希绑定文件全字节**。评审窗口里人看到的就是：脚本源码 + 命令清单
+ 哈希——这是 §1 威胁模型里运行前的唯一闸门。**.ts 脚本同一登记面**：语法门对剥类型后的
文本做同一 vm 编译（零分叉不变），命令字面量扫 .ts 源文本，哈希仍绑 .ts 文件全字节——
登记纪律与 JS 完全同轨。

**重跑 = resume 缓存，前缀有效逐 ask 按序号返还。**重跑时引擎从 journal 按 callSeq 逐 ask
复核导入三条件，通过的返还首跑值：零 driver 调用、零 journal 写、缓存命中的 ask 在结果里标
`cached`。分支决策相同 → 后续 ask 发起序与首跑逐位一致——这是 §1 确定性沙箱存在的理由。

**改脚本 = 前缀导入（v2 作用点位置匹配；推翻 v1「改一字 = 全量重跑」）。**每次 `F.ask` 落账时
记录三样证据：调用点位置（脚本体 line:col）、prompt 哈希、调用点前脚本前缀哈希。**.ts 脚本
的证据坐标同样落在 .ts 源文本**（引擎经 sourcemap 把 vm 栈坐标映回源码——剥类型不改变
"改尾部 → 前缀导入、改头部 → 全重跑"的语义）。重跑逐 ask 复核三条件，**任一不过 → 该点起
（含）全部弃用真跑，之前的照常导入**：

1. **调用点在首个变更字节之前**——调用点前缀哈希与重跑脚本实算相等（调用点之前的字节零变更；
   在调用点之后加行、改尾部不受影响，改头部则全体位移 → 全重跑）；
2. **该前缀内 hole-answered/escalate-answered 事件集为空**——挂起答复是人输入的非确定源，
   前缀里有已答复的挂起，其后的 ask 一律不可信（该点起弃用；挂起本身没有缓存面，重跑会重新
   挂起等**新**答复——不会拿旧答复假完成）；
3. **prompt 哈希与重跑实算相等**——原位改 prompt 字节（行结构不变）时条件 1 拦不住，这里拦
   （agent/model/schema 原位变更同门拦下）。

失败的 ask 不进缓存（重写真跑）；journal 撕裂/归属不符/旧账本无证据字段 → 空缓存全量重跑——
宁可多跑，不可假完成。

**「零重跑」口径：ask 零重跑 ≠ 副作用零重执行。**`F.run` 的结果**不进任何缓存**——副作用命令
在任何 resume 里都重执行并如实记账（journal 的 run 事件一次执行一笔）。前缀 ask 零重跑只省
子代理会话的钱；命令该重跑就重跑。幂等命令的结果缓存是可选增强，当前不做——别在脚本里假设
`F.run` 会命中缓存。

**结论两条**：① 想要"改个常数、其余沿用旧进度"的便宜修订——脚本路径 v2 起有**前缀导入**
（改在执行流尾部 → 前缀全保留；改在 ask 之前 → 该点起重跑）；改动频繁的调参仍优先**声明
路径**（§11：`stepId + sha256(prompt)` 逐字匹配按步导入）；② 脚本侧把可调的东西做成**挂起
答复**或走声明路径，别把常调常数焊死进 ask 之前的字节。

## 10. 完整范例

3 步：评审（扇出逐项链）→ 确认（新鲜眼睛）→ 门禁（F.run）→ 报告形状 return。
schema 对象显式给出（偏差 A.2 的正确写法）；指令自含产出形状（§4）；挂起承接门禁失败（§7）。

```js
// reeve workflow 脚本示例 —— 裸函数体：引擎包装为 async function main(F){…} 在沙箱执行。
// 无 import；无 Date / Math.random / setTimeout / fetch / fs / process（§1 沙箱边界）。
// 登记评审面（scanRunCommands）对本文件提取的字面量命令名清单 = ['git', 'npm']
// （去重首见序；注释里的示例调用同样计入，args 不在扫描面——§5）。

// ---- 结果 schema：显式 JSON Schema 对象（验收契约；强制关键字子集见 §4）----
const Finding = {
  type: 'object',
  properties: {
    path: { type: 'string', minLength: 1, description: '仓库相对路径，适用时带行号：src/a.ts:42' },
    problem: { type: 'string', minLength: 1, description: '一句话：什么错了，不是怎么修' },
    evidence: { type: 'string', minLength: 1, description: '什么证明了它：读过的行，或命令与输出' },
    severity: { type: 'string', description: '影响量级，只能取 low | medium | high；high 只留给数据丢失、崩溃或错误结果' },
  },
  required: ['path', 'problem', 'evidence', 'severity'],
};

const Verdict = {
  type: 'object',
  properties: {
    holds: { type: 'boolean', description: '只凭证据独立复现成功才为 true；复现不出 = false' },
    note: { type: 'string', minLength: 1, description: '复现时看到的东西；反驳时给出反证' },
  },
  required: ['holds', 'note'],
};

// ---- 阶段一 + 二：逐文件评审 → 独立确认（逐项链，唯一的 join 在最后：汇总要全部项）----
F.phase('逐个评审改动的文件并独立确认');
const files = ['src/a.ts', 'src/b.ts']; // 示例从简；真实脚本可先 F.run('git', ['diff', '--name-only']) 解析清单
const confirmed = (
  await Promise.all(
    files.map(async (p) => {
      // 指令自含产出形状（子代理首读不到 schema）；schema 负责验收与重派
      const review = await F.ask(
        `评审 ${p}。只回一个 JSON 对象（不要多余文本），形如 ` +
        `{"path":"${p}","problem":"…","evidence":"…","severity":"low|medium|high"}。` +
        `读该文件找真问题；不修改任何文件。`,
        { schema: Finding },
      );
      // 新鲜眼睛：确认者是另一次全新会话，只凭证据复现；发现者不确认自己（§3/§6）
      const verdict = await F.ask(
        `独立复核这个发现：${JSON.stringify(review)}。读相关文件复现它（不修改任何文件）。` +
        `只回 JSON：{"holds":true|false,"note":"…"}.`,
        { schema: Verdict },
      );
      return { ...review, status: verdict.holds ? 'verified' : 'unconfirmed' };
    }),
  )
).flat(); // 唯一的 join

// ---- 阶段三：确定性门禁——机器能裁的让命令裁；非零退出码是值不是异常（§5）----
F.phase('交接前跑测试与端到端');
const gate = await F.run('npm', ['test'], { timeoutMs: 1_800_000 });
let gateNote = `npm test 退出码 ${gate.exitCode}`;
if (gate.exitCode !== 0) {
  // 挂起问人：答复字符串回到脚本手里（引擎须已接答复源 answerFor，否则挂起被拒）
  const answer = await F.hole('测试没过怎么办', `npm test 退出码 ${gate.exitCode}：\n${gate.stderr.slice(0, 2000)}\n修复 / 放弃 / 带条件放行？`);
  F.log(`人裁决：${answer.slice(0, 200)}`);
  gateNote += `（人裁决：${answer.slice(0, 200)}）`;
}
const e2e = await F.run('npm', ['run', 'e2e'], { timeoutMs: 1_800_000 });

// ---- 阶段四：报告形状 return（四字段各有读者，§6；语言跟会话走）----
return {
  conclusion: `${confirmed.length} 个发现，其中 ${confirmed.filter((f) => f.status === 'verified').length} 个经独立确认；测试门禁${gate.exitCode === 0 ? '绿' : '未过（已问人）'}，端到端退出码 ${e2e.exitCode}。`,
  findings: confirmed,
  verified: [gateNote, `npm run e2e 退出码 ${e2e.exitCode}`, ...confirmed.filter((f) => f.status === 'verified').map((f) => `独立复核 ${f.path}`)],
  notCovered: ['性能与内存未测——本脚本只跑了功能测试与端到端'],
};
```

## 11. 简单路径：声明（降级章）

脚本管复杂编排；**简单流程用声明**——纯数据 DAG，换来的好处是 amend 按步便宜重跑与直渲
可视化。声明是**纯数据**：一个 `runId` 加一个 `steps` 数组，没有脚本字段。每步必填三样
`stepId`、`prompt`、`deps`，可选四样 `schema?`、`agent?`、`model?`、`outputs?`（产出落盘
契约，见下），外加两个预算 `maxAttempts?`（默认 3，含初派的总尝试上限）/
`timeoutMs?`（默认 900000ms）。核心纪律（详情见 git 历史里上一代 SKILL.md 全文与本目录
`examples/visual-gate-repair-loop/` 的完整声明示例）：

- **deps 是唯一控制流；步间数据流两条正道**：无环、无自指、无未知引用；调度按拓扑序就绪集。
  没有 if / 循环——deps 只管**调度**（谁先谁后）。步间数据流 = **数据面引用**（小数据，
  ≤32KiB）或**盘上文件总线**（大数据 / 无 schema 步）。数据面引用写 `{{outputs.<stepId>}}`
  （整对象）或 `{{outputs.<stepId>.<key>}}`（恰一层 key）：被引用步必须声明 `schema`（无
  schema 步无结构化产出可引用）且在本步 deps 的传递闭包内；词法无空白容差（`{{ outputs.x }}`
  不匹配）、stepId 禁 `.`/`}`/空白、深 key 与数组下标不支持（深数据请整对象引用或走文件总线）、
  一切形如 `{{…}}` 而不匹配语法者一律编译错——**prompt 需要字面花括号时改写文风或走文件总线**。
  注入上限：单步全部占位符解析值合计 ≤32KiB，超限步 failed 不重试；渲染后 prompt 豁免 8000
  字符上限（8000 管的是模板本体）。文件总线 = 上游步把产出写进约定路径的文件（配 `outputs`
  字段），下游步 prompt 指名去读。每步 prompt 必须自含（目标、路径、禁做、验收），
  非空且 ≤ 8000 字符，首行写人话。
- **schema 同 §4**（同一套校验子集与"指令自含形状"纪律——每步 prompt 写清产出形状）。
  声明路径的校验时机在步 done 迁移前：调度器拿回复文本过 `schema`（校验通过对象即该步
  **结构化产出**，随 done 迁移落 journal，写入上限 32KiB）、再查 `outputs` 盘上存在（校验器
  与脚本路径同一套）；schema/outputs 不过 → 可重试失败（重派口径见下条），产出超 32KiB →
  `output-over-limit` 终态（确定性失败不重试——大数据走文件总线）。
- **outputs 是产出落盘契约**（可选，1-8 项文件路径数组）：每项必须是绝对路径（Windows
  盘符 `C:\…`、UNC `//…`、POSIX 根 `/…`）或 `~/` 前缀（引擎按 `os.homedir()` 展开，其余
  字面处理）；相对路径与其余形式在声明校验即拒。步 done 判定前引擎逐项检查盘上存在且为
  **文件**——声明了 outputs 的步，「说完成」不算完成，文件在盘上才算完成。
- **重派口径与脚本不同**（「同脚本：maxAttempts 3 修 1 催」在声明路径不成立）：仅 schema
  校验失败与 outputs 缺位两类进**窄域重试**——固定 cooldown（默认 30s，`retry.cooldownMs`
  可配）到期后原 prompt 带错误附言重派（末次重派附催促），`maxAttempts` 是含初派的总尝试
  上限；重试挂起期间 run 不收口（报告显示 `retry-pending`）。**driver 级失败（超时、启动
  失败等）即终态**，不进重试环。耗尽 → 步 failed，不冒泡假结果；收口后再要跑，走 resume
  （failed 步真跑）或 amend。
- **done 语义**：步的完成 = 引擎判定的终态，不是子代理叙事说了"完成"——中段叙事（"正在
  跑"、"快好了"）不构成终态证据；产出文本 = 收敛后末条 assistant 文本（与脚本路径
  `F.ask`「等终态 + 解析末条回复」同口径）。`timeoutMs` 预算必须覆盖真实收敛窗——掐在
  收敛前的预算把还在收敛的步判成假 failed；判据修真后 done 变晚是正常代价（试点实测教训）。
- **resume**：已完成步从 journal 返还，零 driver 调用是结构性的；撕裂 journal 宁可整段重跑。
- **amend（脚本没有的能力，§9）**：`stepId + sha256(prompt)` 字节相等的步逐字导入旧结果。
  级联口径有条件句：**非引用步**改一个常数只废那一步（下游 prompt 未变不级联——时效自担）；
  **引用步**（prompt 含 `{{outputs.…}}`）改被引用上游 ⇒ 引用闭包下游级联重跑——上游产出必变，
  下游按旧上游导入即假完成（旧 journal 无 output 的迁移现场同按「变」处理）。这是"常调常数"
  该走声明路径的理由。
- **hole（声明版）**：运行中交接一份新声明（五类差量：pinned / kept / changed / dropped /
  added；在飞与已完成的步不动）——"按发现生长"在声明路径的表达面。数据面注意：交接里
  changed/pinned 的步若被某个**已 done 的引用下游**（含闭包级联）引用，整次交接被拒
  （TypeError）——上游内容将变而下游已按旧上游落账；先 drop 下游（交接里不点名，已开始步
  反正按旧身携带）或改完再交。
- **escalation（声明版）**：步产出 `{question,…}` 形状挂起问人，依赖分支停、兄弟继续
  （脚本路径是顺序 await 全停，§7——两版语义不同，别混）。
- **登记**：声明文件顶层带 `"kind": "engine-run"`，走同一 `review_gate.register`（文件自带
  kind，无需参数）；可视化 steps+deps 直渲 DAG（M2.5 规划中）。
- **模型**：只在用户点名时写 `model`，按宿主原样 id 编码 `{providerID, id, variant?}`。

## 12. 补段（hole patch）：脚本失败后的机械化修订（C2，2026-11-23）

脚本跑挂了，修的是**脚本文件本身**：补段 = 编辑后的完整脚本文本的一部分，重跑是**新一次
runScript 调用**（引擎无续栈——run failed/blocked 即调用终结，不存在"从失败点继续"）。
声明路径没有补段面（声明走 §11 的 amend/hole 交接）；本章只属于脚本路径。

### 12.1 边界：补段后的局部——可见 ≠ 恒等

1. **可见 ≠ 恒等**：补段与 base 同函数作用域，看得见其前声明的局部——但局部值是前缀重算的
   产物。vm 白名单无不确定源 → 重算确定；ask 派生的局部在 C1 导入三条件内（§9：作用点位置 +
   hole/escalate 空判据 + prompt 哈希全过）值恒等首跑；**F.run 派生的局部无恒等保证**——副作用
   命令任何重跑都重执行，stdout 可能不同，依赖它的分支可能走另一条路。
2. **不存在续栈**：首跑失败点处的局部快照、调用栈、挂起中的 hole 全都不存在；补段面对的是
   一次全新调用。
3. **补段作者不得依赖未走到的控制流分支上的局部**：首跑没执行到的分支里声明的局部在重算时
   可能根本未赋值——补段只可依赖"确定重算"（纯计算、恒等 ask 值）与自身新引入的绑定。

补段调用点必在首个变更字节之后 → C1 三条件天然弃用该点之前的 ask 缓存前缀——宁重跑，不假
完成；"ask 零重跑 ≠ 副作用零重执行"照旧（§9）：补段内 F.run 在每次重跑都真实执行并记账。
补段内失败 → run failed 且 reason=`'patch-failed'`，补段内已完成 ask/run 事件全数保留（打捞
报告含"补段边界"节：base→patched 指纹、anchor、应用时 callSeq）。

### 12.2 风险：review_gate allow 可无人在环

- **allow = 评审会话 pass 判决绑当前文件字节**，round 1 即开门、全程可无人在环——评审者本身
  是模型会话，**模型评审质量即安全边界**。
- 静态扫描只见 `F.run("…")` 的**命令字面量**（模板字符串与变量命令不可见，§5）；vm 白名单
  **防误用不防恶意**（§1 威胁模型）；allow 后补段即在宿主进程内执行 F.run 副作用——close 才
  结论、无回滚无补偿，journal run 事件就是副作用已发生的唯一盘上真相。
- 但门是 fail-closed 的：**每补段必经一轮评审才有 allow**——换文件字节 → 旧 verdict 哈希失配
  → 门禁保持关闭直到重评。补段发生在自动路径已失败之后（带压力产出），这一轮评审不可省。

### 12.3 操作：补段五步

0. **buildPatchContext**（P3，`plugin/src/engine/script-patch.js` 导出）：补段前先从盘上读出
   失败现场——`buildPatchContext({ storage, runId, scriptPath })` 返回写死的形状：
   `{ runId, failedPoint: {reason, site?, bodyOffset?}, completedAsks: [{callSeq, site,
   promptHash, value}], appliedAfterCallSeq, baseScriptPath, baseFingerprint }`（**不含
   changedFrom**——那是 applyPatch 的产出）。用途：① 告诉补段作者哪些 ask 已完成（值可直接
   复用，别再问一遍）、失败点在哪、补段须锚定在哪个执行序之后；② 归因规则写死——journal
   末笔是带 callSeq 的 `ask-failed` 才可归因；`script-threw`/`answer-source-error` 不落盘上
   事件、ask-failed 也可能被 try/catch 吞掉续跑，推导不出就返回
   `failure-not-attributable`（**不发明归类**）——此时宿主手里的 runScript result.reason 才
   是权威，凭它补段即可。评审 prompt 注入：`renderPatchReviewContext(context)` 把现场渲染成
   确定性文本块。
1. **applyPatch**（同文件导出，async）：给 base 脚本路径 + 补段后的完整脚本
   文本 + `{anchor: 'hole-site'|'tail', holeRef?, reason, source}`。base 文件字节不动；补段落
   新文件 `<stem>.patch-<seq><ext>`；journal 记 `patch` 事件（base→patched 指纹 + anchor +
   appliedAfterCallSeq）；返回 changedFrom（首个变更字节偏移，.ts 脚本 = .ts 源文本坐标）。
   语法预门与执行/register 同一管线（.ts 走 TS 前端，§1）——语法坏补段拒绝且零记录。
2. **review_gate register**（kind: `'workflow-script'`）：登记**新补段文件**的盘上路径——语法
   门与命令字面量扫描照走（静态扫描会看到补段新增的字面量命令，写清楚它们做什么）。
   **把第 0 步的 context 作 `baseExecution` 传入**：register payload 原样回带它，评审派发的
   prompt 里也带上（`renderPatchReviewContext` 的文本）——评审才知道 base 段已执行到哪、哪些
   ask 值已落账，否则评审只看得见补段字节本身。
3. **等评审 allow**：check 返回 deny/escalate 就等下一轮评审判决；偷改字节会让旧判决失配、
   门禁重新关闭（fail-closed）。
4. **resumeScript 重跑**：`resumeScript(patchedScript, storage, runId).cached` 作 `askCache`，
   applyPatch 的 changedFrom 作 `patchFrom`，跑同一 runScript 路径。变更点前 ask 按 C1 规则
   导入零重跑；失败点在 changedFrom 之后 → reason=`'patch-failed'`（§12.1）。

## 附录 A. 偏差清单（相对 ZCode dynamic-workflows —— 六 + 二）

写给读过原 skill 的人：每条是原表面的一个能力/机制与本表面的差异，以及教学上要换掉的直觉。

1. **TS 顶层 await 脚本 → 函数体包装（TS 语法 only）。**原表面提交 TS 源码、编译器把关；
   本表面是裸函数体，引擎包装 `async function main(F){…}`；P4 起收 .ts 脚本（文件名定语言），
   但**只有语法**——插件自带 esbuild 剥类型喂 vm（§1），无编译期类型诊断。换掉的直觉：类型
   写错不报错——形状把关在运行时 schema 校验（§4），写对形状的责任移到指令与 schema 两次
   表述上。
2. **JSDoc→schema 合成 → 显式 schema 对象。**原表面在脚本里写 `interface` + JSDoc，类型参数
   `ask<T>()` 自动合成 schema 且子代理看得到字段说明；本表面传显式 JSON Schema 对象，且
   **子代理首读不到它**（§4）——指令必须自含产出形状。校验关键字是子集（`enum` 不强制）。
3. **CreateWorkflow / AmendWorkflow / FillWorkflowHole / SaveWorkflow / EvalWorkflowSnippet
   工具面 → review_gate(kind:"workflow-script")。**原表面五个 authoring 工具 + 后台 run +
   通知；本表面 = 脚本文件经 `review_gate.register(planPath, kind:"workflow-script")` 登记
   （语法门 + 命令字面量扫描 + 哈希绑定），运行与事件流由编排方接线（driver-session 生产
   driver；面板/报告为 M2.5 规划中）。换掉的直觉：没有"后台跑、完事通知"——重跑与打捞
   都按 §9/§10 的 journal 语义来。
4. **zcode 原生可视化（phase 节点图 + artifact 卡片/图表）→ mermaid 报告 + reeve 面板。**
   本表面无 `report(item, id)`、无 `artifact.*`（脚本不发布任何卡片）；可视化的承接在编排
   方：journal 事件 → mermaid（声明直渲 DAG，脚本按 phase 时间线）+ 面板步卡（M2.5 规划中，
   落地前呈现 = journal 台账与 return 值）。换掉的直觉：交付物只有 return 报告 + 工作区
   文件（§6），没有脚本内的发布动作。
5. **编译期 hole（类型化缺口，`FillWorkflowHole` 补代码、尾部 hole 逐层生长）→ hole =
   escalation ask。**本表面 `F.hole(name, prompt)` 等一个**字符串答复**，不接受函数体、不补
   代码、没有类型参数；"按发现生长拓扑"没有**运行中**的表达面——形状要变 = 改脚本 = 从改动点
   起重跑（§7/§9）。2026-11-23（C2）起，脚本**失败后**的修订有了机械化面——补段 hole patch
   （§12：applyPatch 记账 → 重评审 → 前缀导入重跑）；它仍是"改已写死的脚本"，不是编译期
   类型化缺口。
6. **脚本 amend（`AmendWorkflow` 增量导入）→ v2 前缀导入（作用点位置匹配）。**重跑逐 ask 按
   callSeq + 调用点位置/prompt 哈希/前缀哈希三条件复核：条件全过 → 返还首跑值（零 driver 调用）；
   任一不过 → 该 ask 起弃用真跑。改尾部零重跑、改头部全重跑；F.run 副作用任何 resume 都重执行。
   补段重跑同规则（§12：`patchFrom` 标注补段起点，失败点在其后 → reason=`'patch-failed'`）。
   声明路径的 matchAmend（`stepId + sha256(prompt)` 逐字导入）保留——频繁调参仍以声明路径为宜
   （§9/§11）。
7. **脚本无 import。**函数体包装天然禁止（静态 `import` 与动态 `import()` 都炸）；facade
   即全部依赖。换掉的直觉：不能引库——文本处理用 JS 内建（`JSON`/正则），文件与网络的事
   派给 ask 或 `F.run`。
8. **无 `Date.now` / `Math.random` / `setTimeout`（等定时器）。**沙箱白名单删净：`Date` 缺席、
   `Math.random` 删除、`setTimeout`/定时器不存在，`fetch`/`fs`/`process` 同缺；违例 =
   `ReferenceError` / `TypeError` = 脚本失败（fail-closed，§1）。时间只有引擎注入的 `now()`；
   等待用 `F.run` 的 `timeoutMs` 与引擎内建轮询，脚本自己不计时、不睡眠。

## 来源与归属

判断层改编自 ZCode 随包 skill **dynamic-workflows**（Apache-2.0，翻译改编，非原样副本）；
照搬翻译的章节：§2 拓扑纪律（原 §2/§7）、§3 新鲜眼睛（原 §3）、§5 门禁纪律（原 §5
world.run）、§6 验证报告交付（原 §10）、§8 反模式表（原 §12）；差异全部收敛在附录 A。
归属、源文件定位与逐章对应关系见本目录 [THIRD-PARTY.md](THIRD-PARTY.md)；许可原文见 [LICENSE](LICENSE)。
