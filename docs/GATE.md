# GATE —— reeve 的代理层（0.2.0：四档位 + 图片路由）

> 状态（2026-10-23）：**0.2.0 交付** —— 四档位 `reeve/flash|standard|pro|multimodal`，
> 链名 `reasoning` / `standard` / `free-first` / `vision`；文本档位收到图片时由 GATE
> 只把这一次请求改走 `vision`（会话模型/composer 不动）；免费池只保留 image-capable 模型。
> **0.2.0 移除了 `reeve/manual` 单目标档位**（composer 可直接选模型；顶层默认 `reeve/standard`）。
> 0.1.x 见 `docs/GATE-ROLLBACK.md`；免费模型池语义：`docs/FREE-LANE.md`。

## 1. 交付物（本次）

| 文件 | 是什么 |
| --- | --- |
| `plugin/src/gate/config.js` | 配置加载/归一化/热更（policy/providers/chains/agents/chain_for_model/**free**；坏文件保留上一份；缺文件回落打包默认） |
| `plugin/src/gate/classify.js` | 错误分类：永不换（abort/上下文超限）/必换（额度·模型不存在·缺键）/状态码白名单/显式 isRetryable（带安全阀）/文本兜底（中英、retry-after） |
| `plugin/src/gate/state.js` | 会话状态机：单向推进、冷却（按 session）、粘性、可选恢复、TTL 有界、去重推进（假时钟可测） |
| `plugin/src/gate/lanes.js` | 路由、尝试计划（跳 no-op/无 provider/无键、上限、冷却顺延）、请求构造、多键轮转；`@free` 的解析 |
| `plugin/src/gate/free.js` | **免费模型池**：发现（opencode/openrouter 公开列表 + nvidia 白名单）、TTL、失败保留上一份、`@free` 展开（prefer/deny/预算）、按模型的全局冷却 |
| `plugin/src/gate/gate.js` | HTTP 服务：`/v1/chat/completions`、`/v1/models`、`/gate/session`、`/gate/session/:id/next`、`/gate/version`、**`/gate/free`**；台账 JSONL（不带密钥、超限轮转） |
| `plugin/default-fallback.json` | 打包兜底配置（付费候选；免费模型池由用户配置决定） |
| `plugin/test/gate.mjs` | 29 项离线验收（单元 + 集成 + 图片路由 + 并发 + detach） |
| `plugin/test/free.mjs` | 18 项免费模型池验收（发现/TTL/展开/预算/冷却/热更/并发/无键/空目录/动态 image 过滤） |
| `~/.config/opencode/reeve/fallback.jsonc` | 机器上的用户配置（三端共享；开发机是 junction，对端由 ocrc sync） |

## 2. 语义（实现即规格）

- 触发分类顺序：硬拒绝 → 语义必换 → 状态码白名单（`policy.retry_on_errors`）→ 显式 `isRetryable`（安全阀）→ 文本兜底。
- 候选遍历：单向推进；失败候选进冷却（默认 60s，按 session）；跳 no-op/不可达/冷却中；
  `max_fallback_attempts`（默认 6）；**全在冷却也保留第一个尝试**。
- **只在首字节前换**；流已开始的错误原样透给调用方（交给插件侧的重放）。
- 路由：`provider/model` 写了前缀却没人认识 → **404**；裸模型名才走 `default_chain`；agent 链与显式换模型的优先级见 `lanes.js`。
- **图片路由**：`hasImage(body)` 检测 OpenAI `image_url` / Anthropic `image` / Gemini `inlineData`；
  `IMAGE_CHAINS = { reasoning: 'vision' }`。文本档位收到图片时只把本次请求改走 `vision`，会话模型不变。
  standard/flash 的普通链目标本身都是 image-capable，不需要改道。GATE 关闭时图片会按原模型能力被剥。
- **免费模型池**：链里 `@free` 在请求时展开成当前可发现、未冷却、有键的候选；免费最多占
  `max_fallback_attempts - 1` 跳；`free.require_image=true` 时按 `free.modality_url`（默认
  `https://models.dev/api.json`）的 `modalities.input` 动态过滤，只保留 image-capable 模型
  （纯文本免费模型不进池；元数据拉不到就用上一份好数据，从未拿到则直接付费）；全部冷却/不可用 → 直接付费；
  失败按模型全局冷却（阈值/时长可配）；动态链不使用按索引的粘性指针。详见 `docs/FREE-LANE.md`。
- 通道：`passthrough`（头逐字转发，含 UA 与 `x-opencode-session*`）｜`native`（最小头集）。
- 密钥：`key:'none'` / `env.X` / 公开字面量 / `auth` 列表（auth.json，按序取第一个有键的）；
  多键轮转游标在服务侧。**台账/目录/响应体/`/gate/free` 里只有键名，没有键值**。

### 2.1 档位、链与 agent 分配

链是"按顺序试哪些候选"的配方，模型是插件注册给引擎的公开档位；`chain_for_model` 负责映射。
默认分配（插件自带 agent 定义）：

| 档位 | 链 | agent | 说明 |
| --- | --- | --- | --- |
| `reeve/pro` | `reasoning` | planner / advisor / critic | 强推理；glm-5.3 打头；图片请求改道 vision |
| `reeve/standard` | `standard` | executor / reviewer | 通用中型；glm-5.3-flash → lmuai → @free → deepseek |
| `reeve/flash` | `free-first` | scout / librarian | `@free`（只 image 模型）→ 中型/中转/官方 |
| `reeve/multimodal` | `vision` | looker | 视觉链；GATE 图片改道与 looker 子代理共用 |

`standard` 是成本优先（2 付费 + 3 免费 + deepseek 兜底）；`reasoning` 是可靠性优先
（3 付费 + 3 免费）。foreman 是可见的主编排 agent，**不钉模型**，跟随会话选择
（顶层默认 `reeve/standard`）。0.2.0 删掉了 `reeve/manual` 单目标档位：要指定模型就在
composer 里直接选（直连模型绕过 GATE，reeve/* 走链）。引擎配置里**不要再覆盖 `agents.model`**；
删掉覆盖后插件会注册上表。GATE 的 `agents` 段（session→agent 桥）目前没有生产调用方，
实际路由按请求的档位模型走 `chain_for_model`；改 `fallback.jsonc` 的 `agents` 段不会影响当前请求。
`looker` 只能读磁盘路径；粘贴的内联图片由 GATE 图片路由直接交给 vision 链，不经过子代理。

## 3. 验收

- 离线：`plugin/test/gate.mjs` 29 项、`plugin/test/free.mjs` 18 项；插件全量（unit 111 / reconcile 30 /
  snapshot 9 / stats 11 / entry 5 / wiring 6 / runtime 6 / guard 2）。
- 覆盖率门槛：global 95/79/95 + `src/index.js` 97/67/93 + `src/gate/` 97/84/96（只升不降）。
- 真机：`scripts/accept-gate.sh` ①–⑨（①/② 免费模型池、④ 关闭免费→付费、④b 死免费候选→付费、
  ⑤ 粘性、⑥ 冷却、⑦ 热更、⑧ 付费直连、⑨ Bifrost=0）；`scripts/accept-lifecycle.mjs`（DELETE 驱逐）+
  `--idle`（真 60 分钟 TTL：日志见到驱逐后再断言 GATE 仍在）。
- 面板：`extensions/reeve/scripts/audit.mjs --fixture` 44 项（断言 + 截图 + report.json）；
  截图经多模态复审（结论表在 `extensions/reeve/preview/audit/README.md`）。

## 4. 与邻居的关系

- **9router**：**已退役**（配置/provider/自启/脚本/验收里的相关步骤全部移除；免费模型池改由 GATE 原生实现）。
- **Bifrost**：已退役（`plugin/test/guard.mjs` 静态守门禁止回流）。
- **omo**：只做行为规格来源；不引入其代码或 prompt 字面。
- **ocrc**：把 `~/.config/opencode/reeve/` 同步到对端（`INSTANCE_SYNC_ENTRIES` 含 `reeve`；junction 用 `dereference`）。
- **OpenCode / OpenRouter**：免费模型池的发现源（公开模型列表）+ 免费候选；OpenRouter 的 key 只在 auth.json。

## 5. 端口、路径与生命周期

- 用户配置：`~/.config/opencode/reeve/fallback.jsonc`（三端共享面）；台账 `~/.reeve/gate.jsonl`（超 5MB 轮转）。
- **生命周期**：GATE 是**引擎级**服务 —— 插件实例卸载（工作区被闲置驱逐）**不关端口**；`detach()` 只清空闲连接、
  监听口 unref；一次性进程（`opencode run`）卸载后立刻退出；真正关端口只发生在进程退出或显式 `dispose()`。
- **引擎的工作区驱逐机制（实测 2.0.32）**：`LocationActivity` 默认 **60 分钟空闲 TTL**（`timeToLive`），
  每 **1 分钟 sweep 一次**；只有 durable session event 会刷新 TTL，**HTTP 读（`GET /api/location`）不续命**。
  所以一个不再有会话事件的工作区会在最后一次活动后约 60–61 分钟被 `location services evicted` 并走
  invalidate → lifecycle shutdown → 插件 cleanup。2.0.32 **没有** TTL/sweep 开关；2.1.2 起有
  `experimental.location_idle_timeout`（可设短值或 `false` 关闭驱逐）。
  验证：`node scripts/accept-lifecycle.mjs`（`DELETE /api/debug/location`，确定性的同一条卸载路径）或
  `node scripts/accept-lifecycle.mjs --idle`（真等 60 分钟 + 1 分钟 sweep，在隔离引擎日志里看到
  `location services evicted` 后再断言 GATE 仍在；`IDLE_MINUTES` 可调等待上限）。
  **实测（2026-10-22，隔离引擎）**：61 分钟后日志出现 `location services evicted`，GATE 仍在服务、
  重新拉起复用同一台、杀引擎后端口释放 —— `--idle` 6 项全过。
- 开发机上 `ln -s` 与 `mklink` 都需要提权 → 用 `cmd //c mklink //J`（junction）。

## 6. 交付步骤（全部完成）

1. ~~**验**~~：`accept-gate.sh` 开发机/对端全过。
2. ~~**拆**~~：Bifrost 退役 + 静态守门。
3. ~~**面板**~~：链/策略/免费模型池/统计/台账 + 39 项审计 + 多模态复审。
4. ~~**9router**~~：**退役**（免费模型池改由 GATE 原生实现；OpenRouter/NVIDIA 用 key）。
5. ~~**发布**~~：0.1.5/0.1.6 已发布；0.1.7（免费模型池 + 9router 退役 + UI 门）见 CHANGELOG/回滚手册。
