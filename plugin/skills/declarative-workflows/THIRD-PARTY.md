# 第三方内容声明（declarative-workflows skill）

本 skill 的判断层改编自 ZCode 随包 skill **dynamic-workflows**（bundled-skills pack）：

- 源文件：`skills/dynamic-workflows/SKILL.md`（本机安装副本定位法：ZCode 安装根下的
  `%LOCALAPPDATA%/Programs/ZCode/resources/glm/packages/bundled-skills/skills/dynamic-workflows/SKILL.md`，
  1630 行，mtime 2026-11-12）
- 许可：**Apache-2.0**（统一开工 run 蓝图 S11.2 裁决认定，翻译改编合法）。本机安装包内**未随附**该
  skill 的独立 LICENSE / NOTICE 文件（已核实：`bundled-skills/` 下只有 `README.md` 与 `skills/`；
  该 skill 目录下只有 `SKILL.md` / `examples.md` / `patterns.md`；ZCode 应用根目录只有
  Electron / Chromium 许可文件），上游版权主体与仓库 URL 待上游定位后补记于此。
- 许可原文：本目录 `LICENSE`（Apache-2.0 标准全文，与 `../ocr-review/LICENSE` 同文本）。
- 引入方式：**翻译改编**，非原样副本。

## 现行代（2026-11-23，M2.3：脚本契约为主）

SKILL.md 主体改写为 reeve 引擎**脚本路径**（M2.1–M2.4 落地面：`plugin/src/engine/` 的
script-runner / resume-script / script-patch / pgate / driver-session）的创作契约；声明降级为简单路径章
（§11）。与原表面的全部差异逐条收敛在 SKILL.md 附录 A（六 + 二条偏差清单）。
同日 C2 增量：补段章 §12（applyPatch → 重评审 → 前缀导入重跑）与 §7/附录 A.5/A.6 的对应改写；
分发载体改为双发行单元（reeve 插件包随 npm + OpenCodeConfig 同步副本，内容同源）。

照搬翻译的章节（原 dynamic-workflows → 现行 SKILL.md）：

| 原文 | 改写后 |
| --- | --- |
| §2 Subagent topology / §7 Pipeline by default | §2 拓扑纪律（每次 ask 全新会话——"标定"改写为把此前裁决序列化进指令；序号即身份；逐项链 vs 全量 join） |
| §3 Fresh eyes | §3 新鲜眼睛（四规则三告诫照搬；机制面改为 ask 级独立上下文） |
| §4 Typed results（JSDoc 合成 schema） | §4 显式 schema 对象（偏差 A.2：显式 JSON Schema；指令自含产出形状；校验关键字子集） |
| §5 world.run 确定性门禁 | §5 F.run 门禁纪律（非零退出码是值；命令字面量进评审；两档门；10 MiB/512 字符帽） |
| §10 Verify, report, deliver（report 形状） | §6 验证、报告、交付（conclusion/findings/verified/notCovered 形状照搬为 JS 对象字面量；打捞改为 journal/asks 结构性打捞） |
| §12 Anti-patterns | §8 反模式表（逐条改写为 reeve 脚本形状） |
| §14 escalation / §15 holes | §7 hole 与 escalate（偏差 A.5：挂起问句拿字符串答复，不补代码；"把诚实话写进指令"照搬） |
| §16.2–16.3 facade dts / 编译器规则 | §1 脚本模型（签名/沙箱边界按 reeve 实现重写——不采用原文 dts） |
| §1 / §6 / §8 / §9 / §11 / §13 / §16.1/4–7 | 未逐节改写：CreateWorkflow 工具面 / EvalWorkflowSnippet / amend / saved workflow / artifact 发布 / channel/future 在 reeve v1 无对应物（差异见附录 A 与 §2 教学注记） |

上一代（2026-11-22，声明面）的改写对应关系（原 §2/§7→拓扑纪律、§4→结果 schema、§8/§9→幕
结构、§3→独立复核、§12→反模式表）沉淀为现行 §11 简单路径章的骨架；该代全文见本仓库 git
历史。示例目录 `examples/visual-gate-repair-loop/` 为上一代声明示例，继续有效。

本文件、SKILL.md 的 reeve 表面改写文本（facade 表、沙箱边界、威胁模型段、§9 登记与重跑、
附录 A 偏差清单、§11 精简声明契约）为原创内容，随宿主仓库分发，归属与宿主仓库一致，不属于
上游内容。威胁模型段（SKILL §1）的表述出自 reeve 蓝图 M2.3（`.zcode/plans/next-phase-plan-m1-m5.md`
风险表）与本仓 `script-runner.js` 头注，非上游内容。

改写日期：2026-11-23（现行代）；2026-11-22（上一代声明面）
