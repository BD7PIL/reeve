# REEVE 面板 —— UI 断言审计（44 项 + 双语矩阵）

> 由 `node extensions/reeve/scripts/audit.mjs --fixture` 生成截图与 `report.json`；本表是**逐项断言 + 人工结论**。
> 改面板后必须重跑；图变了而结论没更新 = 没审。
>
> 预览读真快照与真 GATE 配置；**写只进内存**（并模拟 GATE 热更），不会改 `~/.config/opencode/reeve/fallback.jsonc`。
> CI 用 `--fixture`（`preview/fixtures/ci.json`）保证确定性；本地不带 `--fixture` 读真数据。
>
> 断言（任一失败 CI 红）：步骤必须点到；控制台 error/异常 = 0；关键态文本；无横向溢出；
> 宿主 token 存在；可见按钮有可访问名；对比度 <3 硬失败 / 3–4.5 警告；保存类动线写入次数。

> 0.1.13 面板（配插件 0.2.2）：**语言真正跟随 OpenChamber**（`ctx.locale` → en / zh-CN 两套词表；
> 技术标识永不翻译）；版式改成宿主式 —— 分区是分隔带，**只有链是卡片**，模型行单行，
> 布尔项是 checkbox row，保存条在页面级（切 tab 不丢）。主套 44 项跑 `--locale=zh-CN`；
> 英文矩阵（01/09/19/22/24/25/28/40/41/42/43）输出 `*-en.png` 与 `report-en.json`。
>
> 复核时抓到的三个真实缺陷并已修：`[hidden]` 被 `display:flex` 盖过（切 tab 后旧 tab 仍显示）、
> 档位下拉的百分比宽度按 shrink-to-fit 父级解析（塌成 1–2 个字）、首帧闭包用旧快照
> （免费车道误报"运行态未就绪"）。

> 0.1.14 面板（配插件 0.2.4）：术语修订 —— zh「免费车道」→**免费模型池**、en `Free lane`→**Free pool**
> （用户裁决；GATE 的 provider lane 概念在文档里同步改为「通道」）。44 项 zh 主套 + 11 项 en 矩阵
> 全部重跑并逐张复核（`--fixture`，2026-10-24），report 均 0 fail。**注意**：不带 `--fixture` 的
> 默认模式读**真机状态**（真台账/真免费池），断言会随机器状态漂移 —— 门禁一律用 `--fixture`。

| # | 项 | 结论（2026-10-23，0.1.13 双语 + 宿主式版式） |
| --- | --- | --- |
| 01 | `chain-default` | ✅ 链卡只此一层；分区是分隔带；模型行单行（短名 + provider ID）；空闲时无保存条 |
| 02 | `chain-row-selected` | ✅ 选中行主色底 + 左竖条；动作条 Up/Down/Replace/Remove（Remove 为 destructive） |
| 03 | `chain-picker` | ✅ 替换走同一拾取器；`替换 <ref>` 分隔标题；来源标签「可用 / 已在使用」 |
| 04 | `chain-picker-search` | ✅ 搜索即点即用 |
| 05 | `chain-added` | ✅ 页头未保存徽标 + 节级未保存徽标 + 页面级保存条同时出现 |
| 06 | `chain-saved` | ✅ 已生效（预览模拟热更后 `chain_targets` 真的变了） |
| 07 | `chain-menu` | ✅ 「更多」带 chevron；档位在用的链拒绝删除并说明 |
| 08 | `chain-new` | ✅ 行内新链表单（创建/取消）；控件宽度按内容 |
| 09 | `tier-mapping` | ✅ `chain_for_model` 四个档位行；下拉宽 14rem，不再塌成 1–2 个字 |
| 10 | `chain-policy` | ✅ 数字字段 5.5rem；布尔项为 checkbox row；provider retries 收进「高级」 |
| 11 | `chain-narrow` | ✅ 380px：字段行纵排、控件满宽；无横向溢出 |
| 12 | `chain-dark` | ✅ 链卡用宿主 elevated 面，正文/边框对比度达标 |
| 13 | `stats-light` | ✅ 摘要数字格 + 按链（条/延迟）+ 按提供商（单次往返，无空条列） |
| 14 | `stats-dark` | ✅ 同上，深色可读 |
| 15 | `ledger-light` | ✅ 任务摘要 + 筛选条（`.oc-filter-bar`）；agent 原样；无 `ses_` ID |
| 16 | `chain-dirty-discard` | ✅ 丢弃后回到盘上状态 |
| 17 | `chain-keyboard` | ✅ 选中行清晰；Alt+↓ 换位 |
| 18 | `chain-selected-dark` | ✅ 深色选中态 |
| 19 | `free-default` | ✅ 开关/模型数/发现源 + 状态点（就绪绿、未就绪黄）+「当前可展开 N 个」 |
| 20 | `free-cooling` | ✅ 冷却摘要随刷新更新 |
| 21 | `free-empty` | ✅ 无可展开模型的空态摘要 |
| 22 | `free-error` | ✅ 运行态读取失败有错误横幅 |
| 23 | `free-max-dirty` | ✅ 改数字**即时**点亮未保存（不重绘、不打断输入） |
| 24 | `free-prefer-add` | ✅ 「高级」内加入偏好；重绘后折叠块保持展开 |
| 25 | `gate-down` | ✅ 页头红色徽标 + 横幅；页面仍可编辑 |
| 26 | `gate-problems` | ✅ 配置 problems 横幅（按语言复述） |
| 27 | `config-parse-error` | ✅ 横幅有标题与原因；路径/错误码在「诊断信息」 |
| 28 | `config-missing` | ✅ 横幅 + 诊断 tried 列表；错误码翻成可读句子，不再重复指向诊断 |
| 29 | `ledger-missing` | ✅ 数据未就绪 + 快照不可用横幅给出下一步 |
| 30 | `ledger-denied` | ✅ 权限提示指向 设置→扩展→文件系统 |
| 31 | `save-fail` | ✅ 未生效 + 写入失败 notice + 草稿保留 |
| 32 | `apply-stall` | ✅ 生效中（写了但引擎没跟上） |
| 33 | `policy-dirty` | ✅ 改策略数字即时出现未保存 |
| 34 | `ledger-filter-empty` | ✅ 筛选空态 ≠ 没有任务 |
| 35 | `stats-empty` | ✅ 空态说明台账路径与下一步 |
| 36 | `stats-stale` | ✅ 旧行窗口放宽提示 |
| 37 | `ledger-dark` | ✅ 行间细线可见 |
| 38 | `chain-loading` | ✅ spinner + 正在读路由配置 |
| 39 | `gate-running` | ✅ 主徽标「2 个运行中 · 1 个排队」 |
| 40 | `chain-narrow-306` | ✅ 306px：隐藏 provider 副标（title 保留完整 ref）、更多可见、无溢出 |
| 41 | `chain-selected-306` | ✅ 306px：选中前缀收起，Up/Down/Replace/Remove 仍可点 |
| 42 | `stats-306` | ✅ 306px：统计行拆两行（名字 / 次数+延迟），隐藏条形 |
| 43 | `free-advanced-306` | ✅ 306px：偏好/禁用/白名单与数字字段单列可读 |
| 44 | `gate-down-306` | ✅ 306px + 路由没起：红色徽标与横幅都不挤坏 |

## 复审方法

- 44 张中文截图逐项过了审计门（步骤点击、控制台零错误、零溢出、宿主 token、可访问名、对比度）。
- 本轮人工看图：01/02/05/09/10/12/13/15/19/24/25/28/31/40/41/42/43/44 逐张核对布局/层级/截断/空态。
- 英文矩阵 11 张（`*-en.png`）核对无中文残留、术语一致（Free lane / Chains / Stats / Tasks / Retry policy）。
- 历史轮的多模态复审记录见 git 历史。

## 真宿主复审

- 桌面客户端：`node scripts/host-audit.mjs --app=openchamber-ui://app/index.html --cdp=http://127.0.0.1:9222`
  （顶层页是 `openchamber-ui://`，面板 OOPIF 在 `http://127.0.0.1:<port>/api/guest-files/…/panel/index.html`；
  脚本按 `<html lang>` 自动选中/英文断言）。
- 抓图：`node scripts/host-shot.mjs --app=openchamber-ui://app/index.html --cdp=http://127.0.0.1:9222 --out=…`。
- 0.1.13 本机真宿主：PASS（文本 1154 字、console 0、无溢出）；面板显示中文（宿主 locale=zh-CN），
  链卡/分区/更多 chevron 与预览一致；截图 `desktop-reeve-0.1.13.png`、报告 `desktop.json`。
- 0.1.13 EL7 对端（4610）：**独立 headless Chrome**（自己的 user-data-dir、CDP 9333）+
  `--login`：PASS（文本 1652 字、console 0、无溢出）；peer settings 无 locale → 面板全英文，
  与宿主一致；截图 `peer-reeve-0.1.13.png`、报告 `peer-4610.json`。
- 复跑对端：先 `ocrc remote up <peer>`，再
  `PEER_UI_PASSWORD=$(ocrc … connect --json 取 uiPassword) node scripts/host-audit.mjs
  --app=http://127.0.0.1:4610/ --cdp=http://127.0.0.1:9333 --login`。
- **安全保存测试**（`--save`）：备份 `fallback.jsonc` → 面板里新增链 → 加模型 → 保存 →
  等「已生效」→ 轮询 GATE `chain_targets` → `finally` 回写并比对 sha256。仅空闲时跑：它会短暂改真配置。

## 怎么重跑

```bash
node extensions/reeve/scripts/audit.mjs --fixture --locale=zh-CN          # 主套（44 项）
node extensions/reeve/scripts/audit.mjs --fixture --locale=en --suffix=-en --only 01,09,19,22,24,25,28,40,41,42,43
node extensions/reeve/scripts/audit.mjs --only 19                        # 单项
node extensions/reeve/scripts/audit.mjs --strict-contrast                 # 3–4.5 也算失败
node scripts/host-audit.mjs --app=openchamber-ui://app/index.html --cdp=http://127.0.0.1:9222
node scripts/host-audit.mjs --app=http://127.0.0.1:4610/ --cdp=http://127.0.0.1:9333 --login   # 对端
```

`report.json`（中文主套）/ `report-en.json`（英文矩阵）里有每项的 failures/warnings/consoleErrors；
CI 上传整套图与报告。
