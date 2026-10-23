# 控制台扩展（openchamber）

> **In English:** an openchamber panel for REEVE — **routes** (per-chain models,
> `@free` rows, tier mapping for the effective `chain_for_model`, retry policy,
> the free-lane card; the only writable surface), **stats** (request attribution
> from the proxy ledger) and **tasks** (child-task list). It writes exactly one
> file, `~/.config/opencode/reeve/fallback.jsonc` (path taken from the
> snapshot's `gate.from`), preserving comments and rewriting only the sections
> it changed. It never starts sessions/prompts and never touches the engine
> config. All colours/type sizes come from host tokens; controls are the host kit.

面板：三个 tab —— **路由链**（每条链的模型、`@free` 免费兜底行、档位映射、重试与回退、免费车道；唯一会写的地方）/
**调用统计**（代理台账归因）/ **任务记录**（子任务列表）。装在 openchamber 上（宿主的扩展机制）。

> **控制面不在这里。** 派活 / 中断全在模型侧。这个面板**只写一个文件**：
> `~/.config/opencode/reeve/fallback.jsonc`（REEVE 自己的 GATE 配置，路径取自快照 `gate.from`）——
> 引擎配置（`providers.reeve` 那一段）由插件的"端点自举"写，本面板**不碰**；
> 它也绝不 `startSession` / `prompt` / `compose` / `attach`。`check.mjs` 里有静态守门盯着这两件事
> （源码里每个 `writeFile(` 的实参都必须是 `fallbackConfigPathFor(…)`）。

## 免费车道卡

路由链 tab 里的「免费车道」卡编辑配置的 `free` 节：启用、免费模型数（含预算提示）、
参与发现的来源（OpenCode / OpenRouter / NVIDIA，含发现状态）、「当前可展开 N 个」一行摘要。
偏好顺序、排除、NVIDIA 白名单、刷新/冷却参数收在「高级」折叠里。
动态 image 过滤（`require_image` + models.dev modalities）在插件侧，面板只显示结果。
纯文本免费模型不会进入展开。

链里写 `@free` 显示为「免费车道 · 自动 · 最多 N 个」；保存后「已生效」比较的是
`chain_targets` + `chain_for_model` + `policy` + `free` 的真实变化，不再只比链名。

## 档位映射（0.1.7 起替代 agent → 链）

会话里选 `reeve/*` 档位时走哪条链，由配置的 `chain_for_model` 决定 —— 这是**真正生效**的
路由面（旧的 `agents` 段没有生产调用方，0.1.x 把它做成了编辑面是误导）。面板给四个档位
各一行下拉；非档位的映射（例如把某个 `provider/model` 钉到链上）只读展示、保存时原样保留。

## 构建与守门

```bash
npm install                  # 一次：devDeps 钉了宿主 SDK（2.3.2）+ esbuild
node build.mjs               # src/panel/main.js → panel/main.js（classic IIFE）
node check.mjs               # manifest / 打包完整性 / 写路径守门 / fallback-edit 单测
node test/fallback-edit.test.mjs   # 纯函数单测（check.mjs 也会跑）
node scripts/audit.mjs --fixture   # 40 项动线审计（断言 + 截图 + report.json）
node scripts/preview.mjs           # 真面板挂假宿主：?tab=&theme=&scenario=&fixture=ci
```

`build.mjs` 不 vendor `@openchamber/sdk`（宿主自带）；预览里除 `connectHost` 之外全是真 SDK。
改完 `src/` 必须重建 `panel/`（CI 会逐字节比对），并重跑审计；**审计截图要逐张看**，
结论写进 `preview/audit/README.md`（本轮还跑了多模态复审，结论同样在那张表里）。

## 装进宿主

两种方式（宿主设置 → 扩展）：

- **zip**：发布资产 `reeve.zip`（tag `reeve-latest` / `reeve-<ver>`），设置里安装；
- **git**：本扩展的仓库是 `BD7PIL/reeve`，用 `https://github.com/BD7PIL/reeve#reeve`
  （git 装法能跟着更新；zip 装法不能）。

开发机上也常用**路径安装**（安装引用路径、不复制，改完文件重开 iframe 即可）：

```bash
curl -b <会话 cookie> -X POST -H 'Content-Type: application/json' \
  -d "{\"path\":\"${HOME}/.reeve-ext-src\"}" http://127.0.0.1:2610/api/guests
curl -b <会话 cookie> -X PUT -H 'Content-Type: application/json' \
  -d '{"granted":["sessions","filesystem"]}' http://127.0.0.1:2610/api/guests/reeve/capabilities
```

能力只要 `sessions` + `filesystem`（读快照/配置、写配置）。**不请求网络能力**：
面板的数据全部由插件投影进快照（`~/.reeve/ledger.json`）。

## 真宿主验证（CDP）

`cdp-open-panel.mjs`（可 `--app/--cdp` 重定向）会打开宿主、点侧栏入口、在 guest iframe 里
执行断言（控制台 0 错、无横向溢出、badge/banner 文本）、切深浅主题并截图；钩子用
`data-act`（`refresh/add/swap/remove/save/add-chain/chain-menu/free-refresh` 等）、`.oc-savebar`、
`button[data-loading]`。其余 `cdp-panel*.mjs` 是早期探索脚本，按需改参数。

写保存的安全测试用 `scripts/host-audit.mjs`：备份 `fallback.jsonc` → 加临时链 → 保存 →
读 GATE `/gate/version` 确认 `chain_targets` 真的变了 → 删除并恢复（finally 校验 sha256）。

## 面板规范（别退回上一版）

- 颜色/字体/圆角**只来自宿主 token**（`--surface-*` / `--interactive-*` / `--primary` / `--status-*`；
  字阶 14/14/13px）；不自绘卡片、阴影、调色板。
- 结构照 app 自己的 SettingsView：平铺行 + 细线分组 + 左标签/右控件；控件一律用 kit。
- **面板 UI 英文**；技术标识（链名 / agent / provider / 档位模型）原样显示，与配置和引擎一致；
  `labels.js` 只做 `provider/model` 的展示拆分，不参与保存。
- 低频调参收进「高级」折叠（折叠状态跨重绘保留）；路径/错误码/名册计数只进「诊断信息」。
- 选中行必须比未选中行**更清楚**（浅色下不能用 kit 的 selectionForeground——它偏灰，已在 index.html 覆盖）。
- 窄栏（≤520px）标签在上、控件满宽；模型名允许换行，不许把 `-flash` 这种后缀截掉。
- 错误/空/加载/脏态必须一眼可读，并给出下一步（刷新/重新读取/批准权限）；
  文本编辑即时点亮保存条（不重绘，不打断输入）。

相关：`preview/audit/README.md`（40 项审计与结论）、`plugin/src/gate/free.js`（免费车道的实现与注释）。
