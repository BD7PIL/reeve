# 控制台扩展（openchamber）

**只读**面板：把 REEVE 的**会话树**与**台账**摆在一起看。装在 openchamber 上（宿主的扩展机制）。

> **控制面不在这里。** 派活 / 中断 / 改档位全在模型侧（`foreman` 的 prompt + 记账插件的闸门）。
> 这个面板**不写任何东西** —— 它连 `startSession` / `prompt` / `writeFile` 都不调
> （`check.mjs` 里有一条静态检查专门盯这个）。

---

## 两个数据源

| 来源 | 怎么拿 | 为什么 |
|---|---|---|
| **会话树** | 宿主给的 `listProjects` → `listSessions` + `onSessions`（用 `parentId` 成树） | openchamber 自己就知道会话的父子关系 |
| **台账** | **读文件**：`~/.local/share/opencode/reeve/ledger.json` | 见下 |

**为什么台账要走文件**：面板跑在沙箱 iframe 里（有 CSP、无网络），拿不到引擎的 SQLite；
而宿主给了它一个 `readFile`（需要 `contributes.filesystem` 声明 + 使用者批准）。

那份 JSON 由**记账插件**写（`options.snapshotPath`，见 [../../plugin/README.md](../../plugin/README.md)）。
它是**投影**：权威仍是插件的 `ctx.storage`，面板只读、永不回写 —— 所以不会出现两处互相覆盖。

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

装完在 **设置 → 扩展** 里**批准两个能力**：`sessions`（读会话树）与 `filesystem`（读台账文件）。
没批准的话面板会显示"文件读取权限还没批准"——它会说清楚，不会假装空数据。

**部署对表**：插件侧 `options.snapshotPath` 指向的位置，必须落在 manifest 的
`contributes.filesystem` 模式里。默认是：

```
~/.local/share/opencode/reeve/ledger.json
```

> EL7 staging 时引擎的 `HOME` 与 openchamber 的 `HOME` 不是同一个，所以 manifest 里
> **第二条模式**（`~/.reeve-staging/...`）是给那种隔离验证用的。生产部署只留第一条即可。

---

## 改

```bash
node build.mjs          # src/panel/main.js → panel/main.js（IIFE，esbuild）
node check.mjs          # 用宿主自己的解析器校验 manifest + 打包完整性
```

`build.mjs` **不 vendor** `@openchamber/sdk`（它是宿主的产物，版本跟着宿主走）：
默认去 `node_modules/` 或相邻的 ocrc 检出里找，找不到就用 `--sdk=<路径>` 指定。
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
# 包放在 /home/demo/.reeve-ext-src（Install 会**引用**这个路径，不复制）
curl -b <会话 cookie> -X POST -H 'Content-Type: application/json' \
  -d '{"path":"/home/demo/.reeve-ext-src"}' http://127.0.0.1:2610/api/guests        # → 201
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

这些脚本用 **EL7 上那个 headless Chrome（:9222）** 驱动真界面。都需要先登录并把 cookie 写到
`/tmp/oc.cookies`（`POST /auth/session`，密码取自 openchamber 进程环境里的 `OPENCHAMBER_UI_PASSWORD`）。

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