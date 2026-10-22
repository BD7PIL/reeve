# REEVE 面板 —— UI 断言审计（40 项 + 多模态复审）

> 由 `node extensions/reeve/scripts/audit.mjs --fixture` 生成截图与 `report.json`；本表是**逐项断言 + 人工/多模态结论**。
> 改面板后必须重跑；图变了而结论没更新 = 没审。
>
> 预览读真快照与真 GATE 配置；**写只进内存**（并模拟 GATE 热更），不会改 `~/.config/opencode/reeve/fallback.jsonc`。
> CI 用 `--fixture`（`preview/fixtures/ci.json`）保证确定性；本地不带 `--fixture` 读真数据。
>
> 断言（任一失败 CI 红）：步骤必须点到；控制台 error/异常 = 0；关键态文本；无横向溢出；
> 宿主 token 存在；可见按钮有可访问名；对比度 <3 硬失败 / 3–4.5 警告；保存类动线写入次数。

| # | 项 | 结论（2026-10-22，0.1.7） |
| --- | --- | --- |
| 01 | `chain-default` | ✅ 链卡平铺、@free 自动行、免费车道卡；右侧只有「更多」 |
| 02 | `chain-row-selected` | ✅ 选中行有主色底 + 左竖条 + 正文色（修掉浅色下 selectionForeground 的 2.3:1 灰） |
| 03 | `chain-picker` | ✅ 换模型走同一拾取器；动作条在选中行下 |
| 04 | `chain-picker-search` | ✅ 搜索即点即用 |
| 05 | `chain-added` | ✅ 未保存徽标 + 保存条 |
| 06 | `chain-saved` | ✅ 已生效——预览模拟 GATE 热更后 `chain_targets` 真的变了（旧版只比链名会假绿） |
| 07 | `chain-menu` | ✅ 危险项在菜单里且带 destructive 色 |
| 08 | `chain-new` | ✅ 新链行内表单；控件右缘一致 |
| 09 | `chain-agents` | ✅ 每个 agent 一行下拉，控件共享右缘（修掉 `.node` 误用导致控件不渲染） |
| 10 | `chain-policy` | ✅ 策略卡字段与开关都渲染（同一修复） |
| 11 | `chain-narrow` | ✅ 380px 不溢出；分区标题不折词；模型名换行保留 `-flash` 后缀 |
| 12 | `chain-dark` | ✅ 深色输入框有面/边；hairline 可见 |
| 13 | `stats-light` | ✅ 条有共同基线；图注说明 p95/量程 |
| 14 | `stats-dark` | ✅ 同上，深色可读 |
| 15 | `ledger-light` | ✅ 有子会话的行有 `›` 且可点；无子会话行 disabled；无 undefined |
| 16 | `chain-dirty-discard` | ✅ 丢弃后回到盘上状态 |
| 17 | `chain-keyboard` | ✅ 选中行清晰；Alt+↓ 换位 |
| 18 | `chain-selected-dark` | ✅ 深色选中态 |
| 19 | `free-default` | ✅ 免费车道卡：开关/次数/来源/偏好/当前展开 |
| 20 | `free-cooling` | ✅ 冷却徽标与剩余时间 |
| 21 | `free-empty` | ✅ 无可展开候选的空态 |
| 22 | `free-error` | ✅ 运行态读取失败有错误横幅（不再只是灰字重复） |
| 23 | `free-max-dirty` | ✅ 免费车道节有「未保存」标记；次数变化可见 |
| 24 | `free-prefer-add` | ✅ 加入偏好可见；当前展开随运行时更新 |
| 25 | `gate-down` | ✅ 页头徽标 + 横幅；页面仍可编辑 |
| 26 | `gate-problems` | ✅ problems 横幅 |
| 27 | `config-parse-error` | ✅ 横幅有标题、失败文件、解析位置 + 重新读取 |
| 28 | `config-missing` | ✅ NOT_FOUND 路径列表 + 重新读取 |
| 29 | `ledger-missing` | ✅ 链 tab 顶部横幅给出原因 + 下一步（不再只有页头 chip） |
| 30 | `ledger-denied` | ✅ 权限提示指向 设置→扩展→文件系统 |
| 31 | `save-fail` | ✅ 没生效 + 写入失败 notice + 草稿保留 |
| 32 | `apply-stall` | ✅ 生效中（写了但 GATE 没跟上） |
| 33 | `policy-dirty` | ✅ 策略节有「未保存」标记 |
| 34 | `ledger-filter-empty` | ✅ 筛选空态 ≠ 台账空 |
| 35 | `stats-empty` | ✅ 空态说明台账路径与下一步 |
| 36 | `stats-stale` | ✅ 旧行窗口放宽提示 |
| 37 | `ledger-dark` | ✅ 行间细线可见 |
| 38 | `chain-loading` | ✅ spinner + 正在读 GATE 配置 |
| 39 | `gate-running` | ✅ 主徽标「2 在飞 / 1 排队 / 4 总」 |
| 40 | `chain-narrow-306` | ✅ 宿主侧栏 306px：@free 行标题+自动徽标一行、更多可见、无溢出（≤360 隐藏次要 meta） |

## 多模态复审（本轮新增的门）

- 方法：审计截图分批交 `multimodal-looker`，按宿主规范逐图 pass/fail（一致性、层级、对齐、字号、对比度、截断、空/错/加载态、深浅一致）；真宿主截图同一套复审。
- 发现并修掉的真问题：浅色选中行对比度 ~2.3:1；agent/策略/免费车道的**控件根本没渲染**（`el().node` 误用）；深色输入框无面；窄栏标题折词/动作脱行；台账 `隐藏 undefined`；台账行无细线/无可点暗示；配置错误无文件路径/无恢复动作；免费车道错误只有灰字；脏态不定位到节。
- 复审结论：40/40 PASS（02/11/22/23/24/27/29/33/37/38 经二轮复审通过；40 是 306px 宿主侧栏专项；残余 nits 不影响验收）。

## 真宿主复审（开发机 3001 + 对端 4610）

- 抓图：`scripts/host-shot.mjs`。面板在 OOPIF：headless 下对 OOPIF 的 `Page.captureScreenshot` 没有数据，
  走顶层页面的 screencast/截图；宿主的 "OpenCode 更新" 提示条只认真实鼠标事件，脚本用 `Input.dispatchMouseEvent` 关掉。
- `preview/host-audit/dev-3001.png`（中文宿主，sheet ~518px）：多模态 **PASS** —— 链卡、@free 行 +
  自动徽标 + 完整 "最多 3 个 · 全部冷却走付费"、首选徽标、每节 更多、刷新全在；无裁切/溢出/提示条遮挡。
- `preview/host-audit/peer-4610.png`（英文宿主，经 ocrc 转发 4610）：**PASS**。修复前该宿主侧栏 306px 下
  @free 标题被挤成一字一行、徽标被推出、免费行说明被截；扩展 0.1.4 在 ≤360px 隐藏次要 meta，40 项审计的
  `chain-narrow-306` 钉住这个宽度。
- 对端 headless 客户端的 CJK 字体回退成 serif 是客户端字体环境（真实桌面客户端用宿主字体），不是面板缺陷。
- 真宿主 DOM 断言（`scripts/host-audit.mjs`）另有一份报告：`preview/host-audit/3001.json` 与 `4610.json`。
- **安全保存测试**（`--save`，0.1.10 新增）：备份 `fallback.jsonc` → 面板里"新增链"→ 建 `host-audit-<id>` →
  给链加 `deepseek/deepseek-flash` 候选 → 保存 → 等面板出现"已生效"→ 轮询 GATE `chain_targets` 确认临时链真的
  写进去了 → 删链、`finally` 回写备份并比对 sha256 → 再等 GATE 里临时链消失。
  两端结果（2026-10-22）：开发机 3001 与对端 4610 均 `applied=true`、`targets=["deepseek/deepseek-flash"]`、
  `restored=true`、`gateDropped=true`，前后 sha256 同为 `a134a3887817d28c5dd9481e2bfd3d712993043833b95b13f9331a00ff7441a4`。
  这条测试先抓出面板"已生效"要等 60s 统计的假阴性（插件 0.1.10 改为 2s 刷新），又抓出同一 Edge 开两个 app 页时
  脚本会连错 OOPIF（已按 `appHost` 过滤）。仅空闲时跑：它会短暂改真配置。

## 怎么重跑

```bash
node extensions/reeve/scripts/audit.mjs --fixture        # 全量（39 项）
node extensions/reeve/scripts/audit.mjs --only 19        # 单项
node extensions/reeve/scripts/audit.mjs --strict-contrast # 3–4.5 也算失败
node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222          # 真宿主
node scripts/host-audit.mjs --app=http://127.0.0.1:3001/ --cdp=http://127.0.0.1:9222 --save   # + 安全保存测试
```

`report.json` 里有每项的 failures/warnings/consoleErrors；CI 上传整套图与报告。
