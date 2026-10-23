# REEVE 面板 —— UI 断言审计（40 项 + 多模态复审）

> 由 `node extensions/reeve/scripts/audit.mjs --fixture` 生成截图与 `report.json`；本表是**逐项断言 + 人工/多模态结论**。
> 改面板后必须重跑；图变了而结论没更新 = 没审。
>
> 预览读真快照与真 GATE 配置；**写只进内存**（并模拟 GATE 热更），不会改 `~/.config/opencode/reeve/fallback.jsonc`。
> CI 用 `--fixture`（`preview/fixtures/ci.json`）保证确定性；本地不带 `--fixture` 读真数据。
>
> 断言（任一失败 CI 红）：步骤必须点到；控制台 error/异常 = 0；关键态文本；无横向溢出；
> 宿主 token 存在；可见按钮有可访问名；对比度 <3 硬失败 / 3–4.5 警告；保存类动线写入次数。

> 0.1.10 面板重排（2026-10-23，配插件 0.2.0）：**面板 UI 全部英文**；技术标识（链名 / agent / provider /
> 档位模型）原样显示，与配置和引擎一致。
> tab 改名「路由链 / 调用统计 / 任务记录」、删除无效的 `agent → 链` 编辑换成真正生效的
> `chain_for_model` 编辑面、策略与免费车道拆「常用 + 高级折叠」、路径/错误码/名册计数收进
> 「诊断信息」、文本编辑即时点亮保存条（不重绘不打断输入）。保存保真修复：未知 policy/链键保留、
> 只重写改过的节、`chain_for_model` 参与生效比对、删链前拒绝档位映射静默丢失。

| # | 项 | 结论（2026-10-23，0.1.10 英文界面 + 卡片版式后） |
| --- | --- | --- |
| 01 | `chain-default` | ✅ English UI；chain IDs as-is (reasoning/standard/...), default/@free badges; model short name + provider ID; save bar hidden when idle (fixed `[hidden]` vs `display:flex`) |
| 02 | `chain-row-selected` | ✅ 选中行主色底 + 左竖条；动作条为文字按钮：上移/下移/更换模型/移除 |
| 03 | `chain-picker` | ✅ 「更换模型」走同一拾取器；来源标签「可用 / 已在使用」 |
| 04 | `chain-picker-search` | ✅ 搜索即点即用 |
| 05 | `chain-added` | ✅ 未保存徽标（顶 + 节）+ 保存条即时出现 |
| 06 | `chain-saved` | ✅ 已生效——预览模拟热更后 `chain_targets` 真的变了；`syncSave` 现在还比对 `chain_for_model` |
| 07 | `chain-menu` | ✅ 档位在用的链拒绝删除并在菜单项说明（`删除（reeve/pro 在用）`）——不再静默丢档位映射 |
| 08 | `chain-new` | ✅ 新链行内表单（创建/取消）；控件右缘一致 |
| 09 | `tier-mapping` | ✅ **`chain_for_model`** editor; four tier rows map to chain IDs; other mappings preserved read-only |
| 10 | `chain-policy` | ✅ 重试与回退：最多尝试次数 / 失败后冷却 / 回到首选开关；`同服务商重试` 收进「高级」折叠 |
| 11 | `chain-narrow` | ✅ 380px 不溢出；分区标题不折词；模型名换行保留 `-flash` 后缀 |
| 12 | `chain-dark` | ✅ 深色输入框有面/边；hairline 可见 |
| 13 | `stats-light` | ✅ Requests/Success/Errors/Fallbacks/P50/P95; no empty provider bar column; long legend removed |
| 14 | `stats-dark` | ✅ 同上，深色可读 |
| 15 | `ledger-light` | ✅ Tasks/Running/Errors/Timed out; raw agent IDs; no `ses_` IDs or roster debug line |
| 16 | `chain-dirty-discard` | ✅ 丢弃后回到盘上状态 |
| 17 | `chain-keyboard` | ✅ 选中行清晰；Alt+↓ 换位 |
| 18 | `chain-selected-dark` | ✅ 深色选中态 |
| 19 | `free-default` | ✅ 常用只留开关/模型数/三个发现源 + 「当前可展开 N 个」一行摘要；偏好/排除/白名单/调参收进「高级」 |
| 20 | `free-cooling` | ✅ 冷却摘要（`N 个冷却中`）随刷新更新 |
| 21 | `free-empty` | ✅ 无可展开模型的空态摘要 |
| 22 | `free-error` | ✅ 运行态读取失败有错误横幅 |
| 23 | `free-max-dirty` | ✅ 改数字**即时**点亮未保存（不重绘、不打断输入；删掉了旧版 2.8s 轮询等待） |
| 24 | `free-prefer-add` | ✅ 「高级」折叠内加入偏好；**重绘后折叠块保持展开**（open 状态持久化） |
| 25 | `gate-down` | ✅ 页头徽标（路由引擎未就绪）+ 横幅（路由引擎没有启动）；页面仍可编辑 |
| 26 | `gate-problems` | ✅ problems 横幅 |
| 27 | `config-parse-error` | ✅ 横幅有标题与原因；原始路径/错误码在「诊断信息」 |
| 28 | `config-missing` | ✅ 横幅 + 「诊断信息」里的 `NOT_FOUND` tried 列表（含 staging 路径） |
| 29 | `ledger-missing` | ✅ 数据未就绪徽标 + 「数据快照读不到」横幅给出下一步 |
| 30 | `ledger-denied` | ✅ 权限提示指向 设置→扩展→文件系统 |
| 31 | `save-fail` | ✅ 没生效 + 写入失败 notice + 草稿保留 |
| 32 | `apply-stall` | ✅ 生效中（写了但引擎没跟上） |
| 33 | `policy-dirty` | ✅ 改策略数字即时出现未保存（同 23） |
| 34 | `ledger-filter-empty` | ✅ 筛选空态 ≠ 没有任务 |
| 35 | `stats-empty` | ✅ 空态说明台账路径与下一步 |
| 36 | `stats-stale` | ✅ 旧行窗口放宽提示 |
| 37 | `ledger-dark` | ✅ 行间细线可见 |
| 38 | `chain-loading` | ✅ spinner + 正在读路由配置 |
| 39 | `gate-running` | ✅ 主徽标「2 个运行中 · 1 排队」 |
| 40 | `chain-narrow-306` | ✅ 宿主侧栏 306px：免费行标题一行、更多可见、无溢出、空闲保存条不出现 |

## 复审方法

- 40 张截图逐项过了审计门（步骤点击、控制台零错误、零溢出、宿主 token、可访问名、对比度）。
- 本轮（0.1.10 英文界面 + 卡片版式）人工看图：01/02/05/09/12/13/15/19/24/25/28/40 逐张核对布局/层级/截断/空态；
  深浅两态都看过。历史轮的多模态复审记录（选中行对比度、控件渲染、窄栏布局等）见 git 历史。

## 真宿主复审（开发机 3001 + 对端 4610）

- 抓图：`scripts/host-shot.mjs`。面板在 OOPIF：headless 下对 OOPIF 的 `Page.captureScreenshot` 没有数据，
  走顶层页面的 screencast/截图；宿主的 "OpenCode 更新" 提示条只认真实鼠标事件，脚本用 `Input.dispatchMouseEvent` 关掉。
- 0.1.10 英文界面 + 卡片版式后需在两端重跑 `scripts/host-audit.mjs`（断言已同步到新文案）与 `--save` 安全保存测试。
- 对端 headless 客户端的 CJK 字体回退成 serif 是客户端字体环境（真实桌面客户端用宿主字体），不是面板缺陷。
- **安全保存测试**（`--save`）：备份 `fallback.jsonc` → 面板里"新增链"→ 建 `host-audit-<id>` →
  给链加模型 → 保存 → 等面板出现"已生效"→ 轮询 GATE `chain_targets` 确认临时链真的写进去了 → 删链、
  `finally` 回写备份并比对 sha256 → 再等 GATE 里临时链消失。仅空闲时跑：它会短暂改真配置。

## 怎么重跑

```bash
node extensions/reeve/scripts/audit.mjs --fixture        # 全量（40 项）
node extensions/reeve/scripts/audit.mjs --only 19        # 单项
node extensions/reeve/scripts/audit.mjs --strict-contrast # 3–4.5 也算失败
node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222          # 真宿主
node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222 --save   # + 安全保存测试
```

`report.json` 里有每项的 failures/warnings/consoleErrors；CI 上传整套图与报告。
