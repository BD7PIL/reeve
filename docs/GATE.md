# GATE —— reeve 的代理层（0.1.7：免费车道 + 9router 退役）

> 状态（2026-10-22）：**0.1.7 交付** —— GATE 原生免费车道（链里写 `@free`，请求时展开）、9router 退役、
> 面板「免费车道」卡 + UI 断言门（39 项审计 + 多模态复审）。0.1.5/0.1.6 已发布并两端验收；0.1.7 见 CHANGELOG。
> 回滚记录：`docs/GATE-ROLLBACK.md`；免费车道语义：`docs/FREE-LANE.md`。

## 1. 交付物（本次）

| 文件 | 是什么 |
| --- | --- |
| `plugin/src/gate/config.js` | 配置加载/归一化/热更（policy/providers/chains/agents/chain_for_model/**free**；坏文件保留上一份；缺文件回落打包默认） |
| `plugin/src/gate/classify.js` | 错误分类：永不换（abort/上下文超限）/必换（额度·模型不存在·缺键）/状态码白名单/显式 isRetryable（带安全阀）/文本兜底（中英、retry-after） |
| `plugin/src/gate/state.js` | 会话状态机：单向推进、冷却（按 session）、粘性、可选恢复、TTL 有界、去重推进（假时钟可测） |
| `plugin/src/gate/lanes.js` | 路由、尝试计划（跳 no-op/无 provider/无键、上限、冷却顺延）、请求构造、多键轮转；`@free` 的解析 |
| `plugin/src/gate/free.js` | **免费车道**：发现（opencode/openrouter 公开列表 + nvidia 白名单）、TTL、失败保留上一份、`@free` 展开（prefer/deny/预算）、按模型的全局冷却 |
| `plugin/src/gate/gate.js` | HTTP 服务：`/v1/chat/completions`、`/v1/models`、`/gate/session`、`/gate/session/:id/next`、`/gate/version`、**`/gate/free`**；台账 JSONL（不带密钥、超限轮转） |
| `plugin/default-fallback.json` | 打包兜底配置（付费候选；免费车道由用户配置决定） |
| `plugin/test/gate.mjs` | 26 项离线验收（单元 + 集成 + 并发 + detach） |
| `plugin/test/free.mjs` | 15 项免费车道验收（发现/TTL/展开/预算/冷却/热更/并发/无键/空目录） |
| `~/.config/opencode/reeve/fallback.jsonc` | 机器上的用户配置（三端共享；开发机是 junction，对端由 ocrc sync） |

## 2. 语义（实现即规格）

- 触发分类顺序：硬拒绝 → 语义必换 → 状态码白名单（`policy.retry_on_errors`）→ 显式 `isRetryable`（安全阀）→ 文本兜底。
- 候选遍历：单向推进；失败候选进冷却（默认 60s，按 session）；跳 no-op/不可达/冷却中；
  `max_fallback_attempts`（默认 4）；**全在冷却也保留第一个尝试**。
- **只在首字节前换**；流已开始的错误原样透给调用方（交给插件侧的重放）。
- 路由：`provider/model` 写了前缀却没人认识 → **404**；裸模型名才走 `default_chain`；agent 链与显式换模型的优先级见 `lanes.js`。
- **免费车道**：链里 `@free` 在请求时展开成当前可发现、未冷却、有键的候选；免费最多占
  `max_fallback_attempts - 1` 跳（默认 3 free + 1 paid）；全部冷却/不可用 → 直接付费；
  失败按模型全局冷却（阈值/时长可配）；动态链不使用按索引的粘性指针。详见 `docs/FREE-LANE.md`。
- 车道：`passthrough`（头逐字转发，含 UA 与 `x-opencode-session*`）｜`native`（最小头集）。
- 密钥：`key:'none'` / `env.X` / 公开字面量 / `auth` 列表（auth.json，按序取第一个有键的）；
  多键轮转游标在服务侧。**台账/目录/响应体/`/gate/free` 里只有键名，没有键值**。

## 3. 验收

- 离线：`plugin/test/gate.mjs` 26 项、`plugin/test/free.mjs` 15 项；插件全量（unit 74 / reconcile 30 /
  snapshot 9 / stats 9 / entry 4 / wiring 6 / runtime 6 / guard 2）。
- 覆盖率门槛：global 95/79/95 + `src/index.js` 97/67/93 + `src/gate/` 97/84/96（只升不降）。
- 真机：`scripts/accept-gate.sh` ①–⑨（①/② 免费车道、④ 关闭免费→付费、④b 死免费候选→付费、
  ⑤ 粘性、⑥ 冷却、⑦ 热更、⑧ 付费直连、⑨ Bifrost=0）；`scripts/accept-lifecycle.mjs`（工作区驱逐后 GATE 仍在）。
- 面板：`extensions/reeve/scripts/audit.mjs --fixture` 39 项（断言 + 截图 + report.json）；
  截图经多模态复审（结论表在 `extensions/reeve/preview/audit/README.md`）。

## 4. 与邻居的关系

- **9router**：**已退役**（配置/provider/自启/脚本/验收里的相关步骤全部移除；免费车道改由 GATE 原生实现）。
- **Bifrost**：已退役（`plugin/test/guard.mjs` 静态守门禁止回流）。
- **omo**：只做行为规格来源；不引入其代码或 prompt 字面。
- **ocrc**：把 `~/.config/opencode/reeve/` 同步到对端（`INSTANCE_SYNC_ENTRIES` 含 `reeve`；junction 用 `dereference`）。
- **OpenCode / OpenRouter**：免费车道的发现源（公开模型列表）+ 免费候选；OpenRouter 的 key 只在 auth.json。

## 5. 端口、路径与生命周期

- 用户配置：`~/.config/opencode/reeve/fallback.jsonc`（三端共享面）；台账 `~/.reeve/gate.jsonl`（超 5MB 轮转）。
- **生命周期**：GATE 是**引擎级**服务 —— 插件实例卸载（工作区被闲置驱逐）**不关端口**；`detach()` 只清空闲连接、
  监听口 unref；一次性进程（`opencode run`）卸载后立刻退出；真正关端口只发生在进程退出或显式 `dispose()`。
- 开发机上 `ln -s` 与 `mklink` 都需要提权 → 用 `cmd //c mklink //J`（junction）。

## 6. 交付步骤（全部完成）

1. ~~**验**~~：`accept-gate.sh` 开发机/对端全过。
2. ~~**拆**~~：Bifrost 退役 + 静态守门。
3. ~~**面板**~~：链/策略/免费车道/统计/台账 + 39 项审计 + 多模态复审。
4. ~~**9router**~~：**退役**（免费车道改由 GATE 原生实现；OpenRouter/NVIDIA 用 key）。
5. ~~**发布**~~：0.1.5/0.1.6 已发布；0.1.7（免费车道 + 9router 退役 + UI 门）见 CHANGELOG/回滚手册。
