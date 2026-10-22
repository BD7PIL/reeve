# 控制台扩展（openchamber）

> **In English:** an openchamber panel for REEVE — **chain** (per-chain candidates,
> `@free` automatic rows, the free-lane card, agent mapping, policy; the only
> writable surface), **stats** (GATE attribution from the ledger) and **ledger**
> (child-task list). It writes exactly one file,
> `~/.config/opencode/reeve/fallback.jsonc` (path taken from the snapshot's
> `gate.from`), preserving comments and rewriting only the sections it changed.
> It never starts sessions/prompts and never touches the engine config. All
> colours/type sizes come from host tokens; controls are the host kit.

面板：三个 tab —— **链**（每条链的候选、`@free` 自动行、免费车道卡、agent 映射、策略；唯一会写的地方）/
**统计**（GATE 台账归因）/ **台账**（子任务列表）。装在 openchamber 上（宿主的扩展机制）。

> **控制面不在这里。** 派活 / 中断全在模型侧。这个面板**只写一个文件**：
> `~/.config/opencode/reeve/fallback.jsonc`（REEVE 自己的 GATE 配置，路径取自快照 `gate.from`）——
> 引擎配置（`providers.reeve` 那一段）由插件的"端点自举"写，本面板**不碰**；
> 它也绝不 `startSession` / `prompt` / `compose` / `attach`。`check.mjs` 里有静态守门盯着这两件事
> （源码里每个 `writeFile(` 的实参都必须是 `fallbackConfigPathFor(…)`）。

## 免费车道卡

链 tab 里的「免费车道」卡编辑配置的 `free` 节：启用、免费尝试次数（含 3+1 预算提示）、
参与发现的 provider（opencode / openrouter / nvidia，含 key 与发现状态）、偏好顺序（置顶/排除/固定）、
NVIDIA 白名单、发现/冷却参数、**当前展开**（运行时只读，来自插件快照）。语义见 `../../docs/FREE-LANE.md`。

链里写 `@free` 显示为「免费车道（自动）· 最多 N 个」；保存后「已生效」比较的是
`chain_targets` + `policy` + `free` 三者的真实变化，不再只比链名。

## 构建与守门

```bash
npm install                  # 一次：devDeps 钉了宿主 SDK（2.3.2）+ esbuild
node build.mjs               # src/panel/main.js → panel/main.js（classic IIFE）
node check.mjs               # manifest / 打包完整性 / 写路径守门 / fallback-edit 单测
node test/fallback-edit.test.mjs   # 纯函数单测（check.mjs 也会跑）
node scripts/audit.mjs --fixture   # 39 项动线审计（断言 + 截图 + report.json）
node scripts/preview.mjs           # 真面板挂假宿主：?tab=&theme=&scenario=&fixture=ci
```

`build.mjs` 不 vendor `@openchamber/sdk`（宿主自带）；预览里除 `connectHost` 之外全是真 SDK。
改完 `src/` 必须重建 `panel/`（CI 会逐字节比对），并重跑审计；**审计截图要逐张看**，
结论写进 `preview/audit/README.md`（本轮还跑了多模态复审，结论同样在那张表里）。

## 装进宿主

两种方式（宿主设置 → 扩展）：

- **zip**：发布资产 `reeve.zip`（tag `reeve-latest` / `reeve-<ver>`），设置里安装；
- **git**：本扩展的仓库是 `BD7PIL/reeve`，用 `https://github.com/BD7PIL/reeve#main`
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
- 选中行必须比未选中行**更清楚**（浅色下不能用 kit 的 selectionForeground——它偏灰，已在 index.html 覆盖）。
- 窄栏（≤520px）标签在上、控件满宽；候选名允许换行，不许把 `-flash` 这种后缀截掉。
- 错误/空/加载/脏态必须一眼可读，并给出下一步（刷新/重新读取/批准权限）。

相关：`../../docs/FREE-LANE.md`、`../../docs/GATE.md`、`preview/audit/README.md`。
