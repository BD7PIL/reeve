# GATE —— reeve 的代理层（已交付）

> 状态（2026-10-22）：**全部交付** —— 核心落地、Bifrost 退役、面板（链/策略/台账）、9router 两端常驻、
> `@bd7pil/reeve@0.1.5` 已发布、两端真机验收 ①–⑨ 全过（发布记录见 `docs/GATE-ROLLBACK.md`）。
> 0.1.6（版本号漂移 + GATE 生命周期：工作区驱逐不再带走代理）**已发布**，两台机器都已升级并重跑验收 ①–⑨ 全过
> （发布被 2026-10-22T02:33Z 起的 npm registry 故障挡了约 70 分钟，恢复后重跑同一 job 成功）。
> 需求来源：v1 时代那套 fallback（per-agent 候选链 + 错误分类触发 + 冷却/粘性）在 v2 没有等价物 → 由 GATE 复现。

## 1. 交付物（本次）

| 文件 | 是什么 |
| --- | --- |
| `plugin/src/gate/config.js` | 配置加载/归一化/热更（只 stat；坏文件保留上一份好配置；缺文件回落打包默认） |
| `plugin/src/gate/classify.js` | 错误分类：永不换（abort/上下文超限）/必换（额度·模型不存在·缺键）/状态码白名单/显式 isRetryable（带安全阀）/文本兜底（中英、retry-after） |
| `plugin/src/gate/state.js` | 会话状态机：单向推进、冷却（按 session）、粘性、可选恢复、TTL 有界、去重推进（假时钟可测） |
| `plugin/src/gate/lanes.js` | 路由（链名 ＞ agent 链/显式直投 ＞ chain_for_model ＞ 兜底链 ＞ 404）、尝试计划（跳 no-op/无 provider/无键、上限、冷却顺延）、请求构造（透传逐字 vs 原生最小集）、多键轮转的取键钩子 |
| `plugin/src/gate/gate.js` | HTTP 服务：`/v1/chat/completions`（候选顺位 + 首字节前才换 + 流式 + `x-reeve-fallback` 头）、`/v1/models`（声明 ∪ 运行时池 ∪ 链名，TTL）、`/gate/session`（session→agent 桥）、`/gate/session/:id/next`（插件侧取下一候选，去重）、`/gate/version`；台账 JSONL（不带密钥、超限轮转） |
| `plugin/default-fallback.json` | 打包兜底配置（付费候选；免费车道属于每台机器自己的选择） |
| `plugin/test/gate.mjs` | 25 项离线验收（单元 + 集成：stub 上游、假时钟、金丝雀密钥、零出网保证、握手式流式断言、`detach` 卸载语义） |
| `~/.config/opencode/reeve/fallback.jsonc` | 机器上的用户配置（三端共享：开发机上 `~/.config/opencode/reeve/` 是 **junction** → 仓内 `.config/opencode/reeve/`；对端由 ocrc sync 这个目录） |

## 2. 语义（实现即规格）

- 触发分类顺序：硬拒绝 → 语义必换 → 状态码白名单（`policy.retry_on_errors`，当前迁移自使用者的 `[401,402,403,429,500,503,529]`）→ 显式 `isRetryable`（安全阀：白名单 ∪ 5xx ∪ 408/425/429）→ 文本兜底。
- 候选遍历：单向推进；失败候选进冷却（默认 60s，按 session）；跳 no-op/不可达/冷却中；`max_fallback_attempts=3`；**全在冷却也保留第一个尝试**（请求总得有人接）。
- **只在首字节前换**；流已开始的错误原样透给调用方（交给插件侧的重放，后续步骤）。
- 路由：`provider/model` 写了前缀却没人认识 → **404**（绝不拿兜底链顶替用户显式选的模型）；裸模型名才走 `default_chain`；agent 链与"用户显式换模型"的优先级见 `lanes.js` 注释。
- 车道：`passthrough`（头逐字转发，含 UA 与四个 `x-opencode-session*`：客户端身份是它的全部意义）｜`native`（最小头集，不把会话头漏给第三方上游）。
- 密钥：`key: 'none'`（本地无鉴权，如 9router）/ `env.X` / 公开字面量 / `auth` 列表（auth.json 里的 id，按序取第一个有键的，支持两端 id 不同）；多键轮转游标在服务侧。**台账/目录/响应体里只有键名，没有键值**（金丝雀测试钉住）。

## 3. 验收（已跑）

- 离线：`node plugin/test/gate.mjs` → 25 项全过（快乐路径、429/500/额度文案/503+retry-after/连不上、流已开始不换、不可重试透传、上限与 502 体、冷却与粘性（两种 restore）、流式不缓冲（握手）、客户端断开传播、provider 重试、多键轮转、目录 TTL 与降级、会话桥与 next、热更（好/坏文件）、dispose 幂等、端口冲突、`detach` 卸载语义、边界 400/413/404/502、零出网）。
- 门槛：lint 干净（新文件 0 警告）；全量 plugin 测试绿；覆盖率 global 91/79/91 + `src/gate/` 96/80/96（分支 80 未到计划写的 85，差距如实记在 `scripts/coverage-baseline.json` 的 `_history`）。

## 4. 与邻居的关系（本轮之后）

- **Bifrost**：**已退役**（自持/pin/链派生/工件全部删除，`plugin/test/guard.mjs` 静态守门禁止回流）。引擎只认 `providers.reeve`（18080）→ GATE。
- **9router**：作为免费车道 provider（`127.0.0.1:20128`，`key: 'none'`）；候选写 `9router/oc/<model>` 单模型目标（不用它的 combo）。
- **omo**：只做行为规格来源；不引入其代码或 prompt 字面。
- **ocrc**：只负责把 `~/.config/opencode/reeve/` 同步到对端（`INSTANCE_SYNC_ENTRIES` 已含 `reeve`；暂存 `cpSync` 带 `dereference`，junction 不会把链接本身带过去）。

## 5. 端口与配置路径（别踩）

- 用户配置：`~/.config/opencode/reeve/fallback.jsonc`（目录是共享面；开发机是 junction，对端是实体目录）。
- 台账：`~/.reeve/gate.jsonl`（超 5MB 轮转到 `.1`）。
- 开发机上 `ln -s` 与 `mklink` 都需要提权 → 用 `cmd //c mklink //J`（junction 不需要权限、可跨盘）。
- **生命周期**：GATE 是**引擎级**服务 —— 引擎按工作区加载插件，第一个实例绑定 18080，其余实例 `probeGate` 复用。
  插件实例卸载（工作区被引擎闲置驱逐，`location services evicted`）**不关端口**：`detach()` 只清空闲连接，
  监听口与配置热更留着 —— 否则"起服务的工作区"一被驱逐，其它活跃工作区就永久拿不到代理（0.1.6 修，两台机器都实测到）。
  监听 handle 是 `unref` 的，一次性进程（`opencode run`）卸载后照样立刻退出（`test/wiring.mjs` 用子进程钉住）；
  真正关端口只发生在进程退出或显式 `dispose()`（测试/升级用）。
- 排查现况：`~/.reeve/ledger.json` 是插件快照（含 `gate` 段与版本号），停止更新即说明插件实例已卸载；`~/.reeve/gate.jsonl` 才是台账。

## 6. 交付步骤（全部完成）

1. ~~**验**~~：已完成 —— `scripts/accept-gate.sh` 开发机全过（引擎经 GATE 拿免费链、停 9router 顺位切付费、粘性、冷却、热更 ≤5s、付费直连不回归）。
2. ~~**拆**~~：已完成 —— 删 Bifrost 自持/pin/链派生 + provision 工件 + `stats.js` 改读 GATE 台账 + `test/guard.mjs` 静态守门。
3. ~~**面板**~~：已完成 —— 链编辑器（每 agent 一条）+ 策略 + 台账/统计；manifest/`check.mjs` 调整；18 项交互审计截图逐张看过（`extensions/reeve/preview/audit/`）。
4. ~~**9router**~~：已完成 —— 两端常驻（pin 0.5.104、`requireApiKey=false`、Windows 启动文件夹隐藏 VBS / EL7 `@reboot` cron、`scripts/setup-9router.mjs` 幂等管理）。
5. ~~**发布**~~：已完成 —— reeve 0.1.5 → npm + 扩展 `reeve-0.1.2`/`reeve-latest` → ocrc pin/sync → 对端升级 + 两端验收 + 回滚文档。
   0.1.6（版本号漂移 + 生命周期修正）已补发，两端已升级并重跑 ①–⑨。