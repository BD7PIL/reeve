## REEVE 可视化面板：链编辑 + 性能统计（含多模态迭代）

### 目标与边界

**做**：在 openchamber 扩展里加一个**能写 REEVE 自己配置**的面板——三个档位的 fallback 链可视化编辑（↑↓ 排序 + 搜索式模型选择），加两个性能统计 tab（Bifrost 归因 / 编排台账）。

**不做**（明确划出）：provider 增删（要改文件+重启，属部署）；任何 controller 动作（不 `startSession`/`prompt`）；拖拽排序（SDK 套件无 dnd）；会话树一节（与宿主重复，移除）。

凡涉及"写"，只写 `~/.reeve/`：`chain.json`（REEVE 自己的配置）。引擎配置仍然只由插件的"端点自举"那一处写（§6.8）。

### 数据契约

**1) `~/.reeve/chain.json`（面板写、插件读；链的唯一可编辑输入）**

```jsonc
{ "version": 1, "updatedAt": 1730000000000,
  "tiers": {
    "flash":      { "targets": [{ "provider": "xiaomi", "model": "mimo-v2.6-flash" }],
                    "fallbacks": ["zhipuai-coding-plan/glm-5.3-flash", "lmuai/glm-5.3-flash"] },
    "pro":        { "targets": [...], "fallbacks": [...] },
    "multimodal": { "targets": [...], "fallbacks": [...] } } }
```

派生：`tiers` → `governance.routing_rules`（id `reeve-<tier>`、name `reeve/<tier>`、CEL `model == "reeve/<tier>"`、priority 10/20/30、target 带 `ttft_timeout_ms: 30000`、weight 1），**与链基座里的 providers 合并**（providers 仍来自仓库 `proxy/config.json` / 插件自带那份）。缺 `chain.json` 时回落到现状（`reeve.jsonc` → bundled）。

**2) 快照新增三节**（`~/.reeve/ledger.json`）：`chain{source,appliedAt,drift,tiers}`、`models[{providerID,modelID,name,context}]`（来自 `ctx.provider.list()`；openchamber 的 hidden 状态取不到，见风险）、`stats{generatedAt,window,bifrost{byTier,byProvider,chain,source},orchestrate{byAgent,queue,uncertain}}`。

### 插件侧改动

| 文件 | 改什么 |
|---|---|
| `plugin/src/chain.js`（新） | 纯函数：`chain.json` → routing_rules 派生、与运行时规则比对、drift 判定、`readChainFile`（注入 impl 便于测试） |
| `plugin/src/stats.js`（新） | `/api/logs` 拉取 + 聚合（注入 `fetchImpl`）；编排侧从台账聚合（每 agent 时长 p50/p95、超时/停止/对账、在飞、**排队数来自 `admission.waitingCount`**） |
| `plugin/src/proxy.js` | bootstrap 改用 `chain.js` 派生；**守护 tick 增加"链文件 mtime 变了就重新派生 + 收敛"**（现无文件监听，这是唯一的收敛触发点） |
| `plugin/src/index.js` | 折进快照；加一个 unref 的统计定时器（默认 60s，失败只记日志） |
| `plugin/src/snapshot.js` | 三个新槽位（`chain`/`models`/`stats`） |

**统计取数顺序（每步失败就退下一个，全部失败就如实标 `source:"unavailable"`）**：
① `GET /api/logs?limit=N` + `X-Bifrost-Setup-Token`（token 是插件自己写的 600 文件）→ **形状先实测**（仓库里只有消费假设：`d.logs || d.data`）；
② 直读 `~/.reeve/proxy/logs.db`（需先验引擎运行时有没有 `node:sqlite`；`scripts/served-model.mjs` 的外部 node 版已在用同一批列）；
③ 不产出统计，面板显示"拿不到，用 `served-model.sh` 看"。

### 面板侧改动

- **Tab 结构**（`mountTabs`）：`链` / `统计` / `台账`（台账保留既有列表 + "前台可见 agent"一行）。
- **链 tab**：三个档位各一块。行 = `模型名 · provider` + `↑` `↓`（`mountButton` size sm ghost）+ `×`；`＋ 加回退` → `mountSelect`（searchable，候选 = 快照 `models` 里未选的）；改完**显式**「保存并生效」→ `host.writeFile('~/.reeve/chain.json', …)` → 显示"已写入，等待收敛（≤20s）"，轮询快照 `chain.appliedAt` 变化。
- **统计 tab**：上"Bifrost 归因"（档位×provider：请求/成功/失败/回退跳/平均延迟 + 每档位合计），下"编排台账"（每 agent：n/ok/err/stop/p50/p95/超时率 + 在飞/排队/不确定）。数字用 `--oc-mono`，延迟用 CSS 宽度条，状态用 `--oc-success/--oc-error/--oc-warning`。
- **观感规则**（跟宿主一致）：只用宿主 token，不引新色；1px `--oc-border` 分隔；行高与宿主列表一致；空态用 `mountEmpty` 且给可执行的话；所有按钮 `size:'sm' variant:'ghost'`。
- **守门闸门改**（`check.mjs:94-100`）：从"禁止 writeFile"改成"**只允许写 `~/.reeve/chain.json`**"——静态断言源码里每个 `writeFile(` 的实参都是那个常量；`startSession/prompt/compose/attach` 继续禁。

### 多模态迭代（你要的那条，独立成步）

1. 新增 `extensions/reeve/cdp-panel-shot.mjs`：**重开 iframe**（改完 JS 才生效）→ 用 `DOM.getBoxModel` 拿 iframe 矩形 → `Page.captureScreenshot({clip})` **只截面板**（浅色+深色各一张）→ 需要时在 guest 上下文里点按（`Input.dispatchMouseEvent` 按 iframe 偏移换算）。
2. 每轮：截图 → 交给 **`multimodal-looker`** 按 rubric 评审（信息层级 / 密度 / 对齐 / 对比度 / 与宿主一致性 / 文案可读性）→ 我按结论改 → 再截。
   **至少 3 轮**，每轮的结论与改动记进 `docs/PROGRESS.md`（含截图路径）。
   > 说明：`documents:visual-judge` 明确只适用于 pptx/docx/xlsx/pdf/poster/chart，UI 面板不能用它；这里用 `multimodal-looker`（图像分析）。
3. 迭代到"问题清零或只剩已记档的取舍"为止。

### 执行顺序与验收（每步可独立停下）

| # | 做什么 | 验收 |
|---|---|---|
| 1 | 插件：`chain.js` + 派生/收敛接线 + mtime 触发；测试 | 单测全过；EL7：手改 `chain.json` → ≤20s 运行时规则跟上（GET `/api/routing/rules` 佐证） |
| 2 | 插件：`stats.js` + 定时器 + 快照三节 | EL7：Bifrost 侧数字与 `served-model.sh --days 1` 同窗口一致；编排侧与 `counts` 一致 |
| 3 | 面板：三 tab 骨架 + 链编辑（含保存/等待收敛） | 面板里调换顺序并加一个模型 → 保存 → 规则变、跑一次真实调用档位分流未坏 |
| 4 | 面板：两个统计 tab | 截图可读；数字口径与第 2 步一致 |
| 5 | **多模态迭代 ≥3 轮** | 每轮 verdict 与改动记档；截图存 `extensions/reeve/`（不入库大图，只记路径） |
| 6 | 文档 + 提交 | PROGRESS 新节（含 `/api/logs` 实测形状、闸门改动理由、迭代记录）；`config/opencode.sample.jsonc` 与两个 README 同步；117→N 项测试全过；EL7 收工（staging 全停、生产 :4096 不动） |

### 风险与对策（按实测优先）

1. **`/api/logs` 形状未知** → 第 2 步第一件事就是实测它并记档；不行退 `logs.db`（先验 `node:sqlite`）；再不行如实降级。
2. **收敛时延**：守护 tick 20s 是上限；若体感慢，把 tick 对"链文件 mtime"单独提到 5s（只 stat，不碰代理）。
3. **并发写**：面板写用宿主原子写（temp+rename），插件读取包 try/catch，坏 JSON 视为"未变更"并记日志。
4. **openchamber 的 hidden 状态取不到**（它在宿主浏览器端，guest SDK 不暴露）→ 模型候选给"引擎里全部可用"并标注来源；要做"只显示不隐藏的"只能请 openchamber 侧开接口（记进文档，不阻塞）。
5. **能力重新批准**：globs 不变（`~/.reeve/**` 已在），预计不用重新批准；若宿主索要，面板按既有失败文案提示"去 设置→扩展 批准文件系统"。
6. provider 增删仍需"改文件 + 重启 Bifrost"（本轮不做，文档里已写明）。