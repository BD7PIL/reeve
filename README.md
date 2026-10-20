# 控制台扩展（openchamber）

面板：三个 tab —— **链**（三个档位的回退链可视化编辑，唯一会写的地方）/ **统计**（Bifrost 归因 + 编排台账）/ **台账**（子任务列表）。
装在 openchamber 上（宿主的扩展机制）。

> **控制面不在这里。** 派活 / 中断全在模型侧（`foreman` 的 prompt + 记账插件的闸门）。
> 这个面板**只写一个文件**：`~/.reeve/chain.json`（REEVE 自己的链配置，路径取自快照里插件正在读的那份）——
> 引擎配置（`providers.reeve` 那两行）由插件的"端点自举"写，本面板**不碰**；
> 它也绝不 `startSession` / `prompt` / `compose` / `attach`。`check.mjs` 里有一条静态守门盯着这两件事
> （源码里每个 `writeFile(` 的实参都必须是 `chainPathFor(…)`）。

---

## 三个 tab 与数据源

| tab | 数据来源 | 写不写 |
|---|---|---|
| **链** | 读快照的 `chain` 节（插件正在读的链文件、已生效时刻、漂移、问题） | **写** `chain.json`（唯一写路径）→ 插件 ≤5 秒热更运行时规则 → 快照 `appliedAt` 前进 = 真生效 |
| **统计** | 读快照的 `stats` 节（插件聚合好的 Bifrost 归因 + 编排台账） | 不写 |
| **台账** | 读快照的 `tasks` / `agentTable` / `roster` 节 | 不写 |

**为什么统计不自己算**：面板跑在沙箱 iframe 里（**没有网络能力**，只有宿主给的 readFile/writeFile），
而 `/api/logs`、`/v1/models` 是本机回环的 HTTP —— 只有引擎进程里的插件够得着。所以插件取数 + 聚合，面板只读。
**为什么台账走文件**：权威是插件的 `ctx.storage`，那份 JSON 是**投影**，面板只读、永不回写 —— 不会出现两处互相覆盖。

---

## 装

扩展是**打好的 JS**（宿主不会编译 TS）。发布包里要有：

```
package.json          # manifest（openchamber 块）
panel/index.html
panel/main.js         # classic IIFE —— 宿主 iframe 不能加载 ESM
```

装法（二选一）：

```bash
# A. 文件夹（开发时最快）：放进 openchamber 的 dataDir
cp -r extensions/reeve ~/.config/openchamber/extensions/reeve

# B. zip：设置 → 扩展 → 安装（宿主会跑 inspectGuestPackage 校验 on-disk 的完整性）
```

装完在 **设置 → 扩展** 里**批准两个能力**：`sessions`（读会话/项目）与 `filesystem`（读写台账与链文件这两个位置）。
没批准的话面板会显示"权限还没批准"——它会说清楚，不会假装空数据。

**部署对表**：插件侧 `options.snapshotPath`（默认 `~/.reeve/ledger.json`）与
`options.chainFilePath`（默认 `~/.reeve/chain.json`）指向的位置，必须落在 manifest 的
`contributes.filesystem` 模式里。

> EL7 staging 时引擎的 `HOME` 与 openchamber 的 `HOME` 不是同一个，所以 manifest 里
> 多声明了 `~/.reeve-staging/...` 两条给那种隔离验证用。生产部署只留 `~/.reeve/**` 即可。

---

## 改

```bash
npm install             # 一次：devDeps 钉了宿主 SDK（2.3.2，对应 openchamber 2.3.3）+ esbuild（0.28.2）
node build.mjs          # src/panel/main.js → panel/main.js（IIFE，esbuild）
node check.mjs          # 宿主解析器校验 manifest + 打包完整性 + 守门（禁控制调用 / 只许写链文件）
```

`build.mjs` **不 vendor** `@openchamber/sdk`（它是宿主的产物，版本跟着宿主走，这里只钉在验证过的那一档）：
优先用本目录 `node_modules/`，找不到才回落到相邻的 ocrc 检出，再找不到就用 `--sdk=<路径>` 指定。
`check.mjs` 同理（`--sdk=<路径>`）。

**改完必跑 `check.mjs`**：它查的正是宿主 `install` 时会拒的那几项
（manifest 合法性、`panel.entry` 存在、HTML 引的 JS 都在包里、产物是 IIFE 而不是 ESM）。

---

## 许可

本扩展**只用** openchamber 的公开 SDK（`@openchamber/sdk`，宿主自带）。
不 vendor 宿主代码；不引入 `oh-my-openagent`（SUL-1.0）的任何代码或 prompt 字面。

---

## 实测记录（2026-10-19，EL7 上的 openchamber 2.3.3）

装法（当时用的）：

```bash
# 包放在 ~/.reeve-ext-src（Install 会**引用**这个路径，不复制）
curl -b <会话 cookie> -X POST -H 'Content-Type: application/json' \
  -d "{\"path\":\"${HOME}/.reeve-ext-src\"}" http://127.0.0.1:2610/api/guests   # → 201
curl -b <会话 cookie> -X PUT -H 'Content-Type: application/json' \
  -d '{"granted":["sessions","filesystem"]}' \
  http://127.0.0.1:2610/api/guests/reeve/capabilities                              # → 200
```

> ⚠️ `source=path` 的安装**不复制包**，只登记这个路径 —— 所以**改完文件不用重装**
> （但浏览器里的 iframe 要重新打开才会加载新 JS）。

验证（用 EL7 上那个 headless Chrome 的 CDP，脚本就是本目录的 `cdp-panel{,2}.mjs`）：

| 检查 | 结果 |
|---|---|
| 侧栏出现入口 | ✅ 按钮 `title="REEVE 编排"`（Branch 图标） |
| 点击后宿主建 iframe | ✅ `/api/guests/reeve/panel/index.html?oc_ui=issue-page&oc_url_token=oc_url_…` |
| 面板渲染 | ✅ 标题 + 徽章 `0 在飞 / 4 总` + 刷新 + 两个分区；**console 无报错** |
| **台账读到了** | ✅ `4 条记录 · 0 在飞 · 生成于 18:51:41（~/.reeve-staging/…/reeve/ledger.json）`，四行 `scout` 子任务带子会话 id 与耗时（用的是宿主套件的 `oc-sdk-list` / toned badge） |
| 会话树 | ⚠️ 该实例**注册项目数为 0**（界面显示 "Choose project"），面板如实显示"先打开一个项目" —— 空态**是对的**，不是 bug |

两处**教训**（已写进实现）：

1. 读文件失败要**把 `NOT_FOUND` / `NOT_GRANTED` / `BAD_PATH` 原样显示出来**。
   第一版只显示一句"还没读到台账快照"，看起来像"台账是空的"——把原因摊开之后一眼就定位了。
   **空台账与读不到是两件事，面板不许混为一谈。**
2. 面包屑只读**自己的**数据：SDK 的 `payload: ["messages"]` 会多要一个 `conversation` 能力。
   本面板不需要读消息内容 → 去掉，请求能力收敛到 `sessions,filesystem`。

---

## 验证脚手架（`cdp-*.mjs`）

这些脚本用 **EL7 上那个 headless Chrome（:9222）** 驱动真界面。

**主力工具是 `cdp-open-panel.mjs`**（2026-10-20 加）：打开面板 → 读面板文本 → **真鼠标点按**（按选择器/文字）
→ **真输入**（`Input.insertText`）→ 按 iframe 矩形裁剪截图（浅/深两版）。

```bash
# 打开面板并打印它的文本（最常用的排查手段）
node cdp-open-panel.mjs
# 切 tab + 浅色截图（--tab 用 data-id：chain / stats / ledger）
node cdp-open-panel.mjs --tab=stats --shot=/tmp/p.png --shot-dark=/tmp/p-dark.png
# 在面板里操作（按命令行顺序执行）：切 tab → 点「＋ 加回退」→ 手填模型 → 加入 → 保存并生效
node cdp-open-panel.mjs --tab=chain "--click=[data-tier=\"flash\"] [data-act=\"add\"]" \
  "--type=[data-tier=\"flash\"] [data-act=\"manual\"] input|deepseek-api/deepseek-v4-flash" \
  --click-text=加入 --click-text=保存并生效 --wait=12000 --shot=/tmp/after.png
```

它踩过并写进代码的坑（都是**采集**的坑，不是面板的）：

| 坑 | 现象 | 现在的做法 |
|---|---|---|
| 面板在 sandbox iframe 里（无 allow-same-origin） | `contentDocument === null` | 读/求值走 `Page.createIsolatedWorld(frameId)`（页面重载后上下文作废 → 缓存要能重建）；点按走 `Input.dispatchMouseEvent`（坐标在隔离世界量 + iframe 偏移） |
| 没被选中的 section **也挂着 iframe** | 尺寸正常但看不见 → 截到"别的 section" | 用 `checkVisibility()` 判，量尺寸不算数 |
| 宿主的 "Saving…" 抽屉 | 打开设置就会盖住面板，且长时间不消失 | 切完主题**点 `aria-label="Close settings"` 关掉**，并等"无 Saving / 无 aria-busy / 无对话框 / 面板非读取中" |
| 主题判定 | `style.colorScheme` 切了主题也不更新；`settings.json.themeVariant` 不是运行时真相 | 读**渲染出来的背景亮度**判浅/深；切主题走 设置→外观→颜色模式 |
| iframe 偶尔迟迟不出现 | 重载后约 1/5 概率 | 每张图带一次"重新加载再试"；**面板不在前台就拒绝出图**（宁可不产图也不产错图） |
| 宿主提示条压住保存条 | "OpenCode update" 浮在右下 | 截图前先点 Dismiss |

> 结论：**截图类验收必须有"干净度断言"**，否则会拿到"看起来像证据其实拍的是别的东西"的图（第 2 轮四张全废）。

旧脚本（保留，做别的验证用）：

| 脚本 | 干什么 |
|---|---|
| `cdp-panel.mjs` | 导航到 app → 点侧栏的「REEVE 编排」→ 截屏（验证面板被识别、iframe 被建） |
| `cdp-panel2.mjs` | 进 guest iframe 的**执行上下文**读它的真实 DOM + console（验证面板渲染成什么样） |
| `cdp-submit-project.mjs` | Projects 页 `+` → 输路径 → Add project（**面板保存 agent 需要项目上下文**） |
| `cdp-ui-save-full.mjs --save` | 全 UI 路径：选项目 → Settings → Agents → `+` → 填名/描述/prompt → Create |
| `cdp-capture-create-error.mjs` | 抓 `POST /api/config/agents/*` 的**请求体与响应**（比如缺项目时的 400） |
| `cdp-delete-via-panel.mjs` | 用面板自己的 `DELETE` 端点删掉探针 agent（清理） |

**面板层「零冲突」的完整复现顺序**：`cdp-submit-project.mjs` → `cdp-ui-save-full.mjs --save`
→（外部比对配置文件的 hash/mtime）→ `cdp-delete-via-panel.mjs`。
测量结果与留下的痕迹见 [../../docs/PROGRESS.md](../../docs/PROGRESS.md) §5.5。