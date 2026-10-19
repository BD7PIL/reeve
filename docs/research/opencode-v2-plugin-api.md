# opencode v2 插件 API 施工图（v2.0.32 实测）

> **用途**：写 REEVE 记账插件时的唯一权威依据。凡本文与旧文档冲突，**以本文为准**。
> **来源**：本机 `D:\develop\ocrc-exp\node_modules\@opencode\cli`（= `@opencode/cli@2.0.32`）
> 与上游 `anomalyco/opencode` 的 tag **`v2.0.32`**（`gh api` 只读取到）。**日期**：2026-10-19。
> **它取代**：[orchestration-stack-verdict.md](orchestration-stack-verdict.md) §4.2 的挂载点写法、
> [HANDOFF.md](../HANDOFF.md) §6.1 的挂载点写法、§6.2 与 §12 的"不再发 `session.idle`"、
> §3.3 的方法清单。逐条对照见文末 **§11**。

---

## 0. 先说四个会直接踩的坑

1. **`tool.execute.before` / `tool.execute.after` 在 v2 里不存在。** 那是 v1 的 hook 名。
   v2 是 `ctx.tool.hook("execute.before" | "execute.after", cb)`。
2. **注册的工具必须同时带 `options.namespace` 与 `options.codemode: false`，否则模型看不见它。**
   `namespace` 负责命名（工具变成 `<ns>_<name>`），**`codemode: false` 才是"暴露给模型"的开关**。
   **两个都要。** 实测（v2.0.32，见 §3.1）：
   四个变体注册后 `ctx.tool.list()` **四个都在**，但模型只收到**带 `codemode: false` 的那两个**。
   → REEVE 一律写 `options: { namespace: "reeve", codemode: false }`。
3. **本地路径插件必须指向目录，且该目录的根上要有入口文件。**
   - 不能指向 `.js` 文件（loader 把配置里的本地插件一律当目录解析）
   - **入口必须在目录根**：实测 `package.json` 的 `main` 指向子目录（如 `src/index.js`）
     时**插件根本不会被加载**，而且**不报错**。根上加一个 `export { default } from './src/index.js'` 即解决。
   - 发现目录：`.opencode/plugins/` 与 `~/.config/opencode/plugins/`；也可在 `plugins` 数组里写绝对路径
   - **Windows 上路径要写正斜杠**——反斜杠在 JSON 里是非法转义，会让**整份配置被静默丢弃**（见 §15）
4. **`session.idle` 仍发但已 deprecated**；`message.part.updated` / `question.*` 不在 v2 类型联合里。

**另一个陷阱（版本）**：本机 `D:\develop\ocrc\node_modules\@opencode-ai\plugin@1.18.34` 是 **v1 线**的包，
它 `dist/v2/*` 子路径里那份 `Context` 是**过时的 v2 草稿**（只有 9 个域），**不要照它写**。
本文的 v2 签名来自上游 `v2.0.32` tag。

---

## 1. 插件入口

```ts
// packages/plugin/src/promise/plugin.ts @ v2.0.32
export type Cleanup = () => Promise<void> | void
export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}
export function define(plugin: Plugin) { return plugin }
```

- `setup` 收到 `Context`，**返回一个 cleanup 函数**（或 void）——**不是**返回 hooks 对象。
- `define()` 是恒等函数，直接 `export default { id, setup }` 也可以。
- 另有 Effect 变体：`{ id, effect(context) }`（`packages/plugin/src/effect/plugin.ts`）。

**loader**（`packages/core/src/plugin/module.ts` @ v2.0.32）只认 **default export**，且必须是二选一：

```ts
const Module = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({ id: Schema.String, effect: <function> }),
    Schema.Struct({ id: Schema.String, setup: <function> }),
  ]),
})
// 报错原文："Plugin must export a default definition with an id and an effect or setup function."
```

**具名导出不会被加载**（v1 那种 `export const X = async () => hooks` 在 v2 无效）。
这条正是 omo 在 v2 上加载失败的原因：它的默认导出还是 v1 形状 `{ id, server }`。

**配置键**：`plugins`（复数）是 v2 原生键，`plugin`（单数）是 v1 遗留键，**两者都会被读取并合并**
（`packages/core/src/config/normalize.ts`）：

```ts
const legacyPlugins = decodeList(input.plugin,  ConfigPluginV1.Spec, ["plugin"],  ...)
const nativePlugins = decodeList(input.plugins, ConfigPlugin.Plugin,  ["plugins"], ...)
if (...) encoded.plugins = [...legacyPlugins, ...nativePlugins]
```

`ConfigPlugin.Plugin = string | { package: string; options?: Record<string, unknown> }`。

---

## 2. `Context` 的全部域（24 个）

```ts
// packages/plugin/src/promise/plugin.ts @ v2.0.32
export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly credential: Pick<CredentialApi, "activate">
  readonly event: EventDomain
  readonly experimental: { readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read"> }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi, "list">
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}
```

REEVE 只用到 `tool` / `event` / `session` / `storage` / `agent` 五个。

---

## 3. 注册工具（`ctx.tool.transform`）

**setup 的返回值里没有 `tool` 键。** 注册走 `tool` 域：

```ts
// packages/plugin/src/promise/tool.ts @ v2.0.32
export interface ToolEditor {
  list(): readonly (Info & { readonly id: string })[]
  get(id: string): (Info & { readonly id: string }) | undefined
  namespace(namespace: Tool.Namespace): void
  add<Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
    tool: Info<Input, Output>): void
  update(id: string, update: (tool: Types.Mutable<Info>) => void): void
  remove(id: string): void
}
export interface ToolDomain {
  readonly transform: Transform<ToolEditor>   // Transform = (cb) => Promise<Registration>
  readonly reload: () => Promise<void>
  readonly list: () => Promise<readonly (Info & { readonly id: string })[]>
  readonly hook: Hooks<ToolHooks, ToolFailures>
}
```

**工具描述符**（`packages/schema/src/tool.ts` @ v2.0.32）：

```ts
export type ValueSchema<A = unknown> =
  | Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema

export type Info<
  Input  extends ValueSchema<any> = ValueSchema<any>,
  Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined,
> = {
  readonly name: string
  readonly input: Input                                  // ← 不是 `args`
  readonly description: string
  readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>
  readonly output?: Output
  readonly options?: Options
}

export interface Result<Output = ...> {
  readonly output?: ...
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Metadata
}

interface BaseOptions {
  readonly namespace?: string
  readonly permission?: string
}
```

- **入参 schema** 三选一：Effect 的 `Schema.Codec`、`StandardSchemaV1`（zod / valibot 都实现它）、
  或**裸 JSON Schema**。zod 可用。
- **handler 上下文**：`{ sessionID, agent, messageID, id, signal: AbortSignal, progress(update) }`
  —— 拿得到 `sessionID`，拿得到 `AbortSignal`。
- **返回**：`{ output?, content?, metadata? }`。

**命名**（`packages/core/src/tool/runtime.ts` 的 `effectiveName()`）：

```ts
options?.namespace === undefined
  ? normalizedName(name)
  : `${namespace.replaceAll(".", "_")}_${normalizedName(name)}`
```

### 3.1 ⚠️ 真正决定"模型能否看见"的是 `codemode: false`，不是 `namespace`

**实测（2026-10-19，v2.0.32，隔离栈 + 记录工具名的探针桩）**：一个插件注册四个变体——

| 变体 | 入参字段 | `namespace` | `codemode` | `ctx.tool.list()` 里在吗 | **模型收到了吗** |
|---|---|---|---|---|---|
| `v1_input` | `input` | `reeve` | — | ✅ 在 | ❌ **没有** |
| `v2_input_codemode` | `input` | `reeve` | `false` | ✅ 在 | ✅ **收到** |
| `v3_args` | `args` | `reeve` | — | ✅ 在 | ❌ **没有** |
| `v4_args_codemode` | `args` | `reeve` | `false` | ✅ 在 | ✅ **收到** |

模型侧实际收到的工具名（14 个 = 12 个内置 + 2 个探针）：

```
["edit","glob","grep","question","read","reeve_v2_input_codemode",
 "reeve_v4_args_codemode","shell","skill","subagent","webfetch","websearch","write","execute"]
```

**结论（三条，都要记住）**：
1. **`options.codemode: false` 是必需的**——没有它，工具**注册成功、`tool.list()` 里能看到、
   但不会出现在模型工具表里**。**静默失败，不报错。**
2. **`options.namespace` 只负责命名**（`reeve_<name>`），不是暴露开关。
   —— 这与早先"光有 namespace 就行"的说法**不一致**，那条是 ocrc 在 2.0.27 上的经验，
   且它的代码里其实**同时**传了 `codemode: false`。
3. **入参 schema 用 `input` 或 `args` 都行**（`args` 被接受为别名）。

→ **REEVE 一律写 `options: { namespace: "reeve", codemode: false }`。**

**调试技巧**：`await ctx.tool.list()` 会返回**完整工具注册表**（含内置的 `patch`、
`opencode_session_rename`、`opencode_worktree_*`、`opencode_models` 等）。
用它区分"没注册上"与"注册了但没暴露给模型"——**这两种失败的排查方向完全不同**。

---

## 4. 钩子

### 4.1 工具钩子（记账层的主要挂载点）

```ts
// packages/plugin/src/promise/tool.ts @ v2.0.32
interface ToolHooks {
  readonly "execute.before": {
    readonly tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    input: unknown                 // ← 非 readonly，可原地改
  }
  readonly "execute.after": {
    readonly tool: string
    readonly sessionID: Session.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly id: Tool.CallID
    readonly input: unknown
  } & (
    | { readonly status: "completed"; result: Tool.Result }
    | { readonly status: "error";     error:  Tool.Error  }
  )
}

// 只有 execute.before 可以失败：返回 Tool.Error 会在工具执行前拒绝这次调用
export interface ToolFailures extends Record<keyof ToolHooks, unknown> {
  readonly "execute.before": Tool.Error
  readonly "execute.after":  never
}
```

- **注册**：`ctx.tool.hook("execute.before", cb) => Promise<Registration>`
- **`before` 能改参数吗**：能。`input` 是非 readonly，内置的 `subagent` 工具自己就这么改（`event.input = input`）。
- **`before` 能拦下调用吗**：能。`execute.before` 的失败通道是 `Tool.Error`——在工具跑之前就拒绝。
- **`after` 永远不会失败**。

### 4.2 会话钩子

`ctx.session.hook(name, cb, options?)` 暴露的 `SessionHooks`：

```
prompt · context · compaction · generate · title · model.request
http.request · http.response · retry
experimental.ws.handshake · experimental.ws.send · experimental.ws.receive
```

例：`SessionContext = { sessionID, model, system, messages, options, agent, tools }`（可变）。

### 4.3 ⚠️ v1 钩子名在 v2 不存在

`tool.execute.before`、`chat.message`、`chat.params`、`experimental.chat.messages.transform`
**都是 v1 的名字**（见 `@opencode-ai/plugin@1.18.34` 的 `interface Hooks`）。
在 2.0.32 的二进制里搜这两个字面 → **零命中**。

**唯一例外**：`experimental.chat.messages.transform` 是 omo-slim 的 `rehydrateHistoricalRunningTasks`
用的挂载点（v1 形态）。**REEVE 的惰性对账不能照抄这个钩子名**——v2 上要用
`ctx.session.hook("context", cb)` 或 `ctx.session.hook("prompt", cb)` 作为"父会话下次活动"的触发点，
具体选哪个**需要实测**（见 §10）。

---

## 5. 事件

```ts
// packages/plugin/src/promise/event.ts
export interface EventDomain extends Pick<EventApi, "subscribe"> {}
// generated client: subscribe(requestOptions?) => AsyncIterable<EventSubscribeOutput>  (SSE, GET /api/event)
```

用法：`for await (const ev of ctx.event.subscribe({ signal })) { ... }`

**v2.0.32 的事件名全集**（`packages/client/src/promise/generated/types.ts`）：

```
session.created · session.deleted · session.renamed · session.moved · session.forked
session.agent.selected · session.model.selected · session.metadata.updated
session.permissions · session.viewed
session.message.content.updated · session.usage.recorded · session.usage.updated
session.inbox.delivered/enqueued/cancelled/delivery.changed
session.execution.started · session.execution.succeeded
session.execution.failed  · session.execution.interrupted
session.instructions.updated · session.synthetic · session.skill.activated
session.shell.started/ended
session.step.started/streamed/ended/failed
session.text.started/delta/ended
session.reasoning.started/delta/ended
session.tool.input.started/delta/ended · session.tool.called/progress/success/failed
session.retry.scheduled
session.compaction.started/delta/ended/failed
session.revert.staged/cleared/committed
session.status · session.idle
permission.asked · permission.replied
server.connected · file/filesystem.changed
installation.updated · installation.update-available
mcp.resources.changed · mcp.status.changed · lsp.*
pty.created/updated/exited/deleted · project.updated · reference.updated
plugin.updated · command.updated · vcs.branch.updated · worktree.* · tui.*
```

**REEVE 要用的四个**（`packages/schema/src/session-event.ts`，durable）：

| 事件 | 载荷 |
|---|---|
| `session.execution.started` | `Base`（含 `sessionID`） |
| `session.execution.succeeded` | `Base` |
| `session.execution.failed` | `Base` + `error: SessionError.Error` |
| `session.execution.interrupted` | `Base` + `reason: "user" \| "shutdown" \| "superseded" \| "inactivity"` |

**`session.idle` 仍然存在**，但源码里明确标了 `// deprecated`
（`session-status-event.ts`：`Event.ephemeral({ type: "session.idle", schema: { sessionID } })`）。
→ **旧文档说"v2 不再发 `session.idle`"是错的。** 它发，只是已弃用。
REEVE 的用法不变（`session.idle` 只当**候选**，不作终止判定），但要知道它是弃用 API，别在上面加依赖。

`session.status` 是 ephemeral，载荷 `{ sessionID, status: {type:"idle"} | {type:"busy"} | {type:"retry", attempt, message, next, action?} }`。

`permission.asked`（ephemeral）载荷 `{ id, sessionID, action, resources: string[], save?, metadata?, source?, message? }`；
`permission.replied` 载荷 `{ sessionID, requestID, reply: "once"|"always"|"reject" }`。
注意 v2 的字段名是 `action`/`resources`，**不是** v1 的 `permission`/`patterns`。

**不在 v2 类型联合里的**：`message.part.updated`（只在 v1 遗留模块 `packages/schema/src/v1/session.ts`）、
`question.*`（`question.ts` 只定义数据 schema，没有事件）。二进制里能搜到
`question.asked` / `question.v2.asked` 字符串，ocrc 在 2.0.27 上映射过
`question.v2.asked|replied|rejected` → **运行期可能仍存在，但 2.0.32 的类型联合里没有**，按未验证处理。

> ⚠️ **文档陷阱**：`packages/web/src/content/docs/plugins.mdx` @ v2.0.32 这一页文档的是
> **v1 的函数式插件 API**（`export const MyPlugin = async ({project, client, $, ...}) => ({ "tool.execute.before": ..., event: ... })`），
> 与同 tag 的 loader（只认 `default {id, effect|setup}`）**自相矛盾**。**别信那一页。**

---

## 6. 插件能拿到的会话方法（`SessionDomain`）

```ts
// packages/plugin/src/promise/session.ts @ v2.0.32
export type SessionDomain = Pick<SessionApi,
  | "create" | "get" | "remove" | "switchAgent" | "switchModel"
  | "prompt" | "generate" | "command" | "compact" | "synthetic"
  | "interrupt" | "update" | "move" | "wait" | "context"
> & { readonly hook: ModelHooks<SessionHooks> }
```

**结论：插件确实拿不到 `list` / `children` / `status` / `todo`** —— 这四条在 2.0.32 的 `Pick` 里没有。
→ 记账层"必须自持台账"的硬约束**成立**。

**但旧文档的清单有两处漏项**：`remove` 与 `compact` **是给插件的**。

⚠️ **版本敏感**：上游 `dev` 分支后来把 `list` 加进了这个 `Pick`。
REEVE 的版本 pin 是 **2.0.32**；升级引擎时必须重新核对这张清单。

**abort / interrupt 的签名**（`SessionInterruptInput` @ v2.0.32）：

```ts
export type SessionInterruptInput = {
  readonly sessionID: string
  readonly resume?: boolean | undefined
}
```

→ `ctx.session.interrupt({ sessionID, resume: false })` **确认**（旧文档这条是对的）。

**prompt 的签名**：

```ts
export type SessionPromptInput = {
  readonly sessionID: string
  readonly id?: { readonly id?: string | null; readonly text: string; readonly files?: ... }
}
```

---

## 7. 存储（`ctx.storage`）

```ts
// packages/plugin/src/promise/storage.ts @ v2.0.32
export interface StorageDomain {
  readonly get:    (key: string) => Promise<Schema.Json | undefined>
  readonly set:    (key: string, value: Schema.Json) => Promise<void>
  readonly remove: (key: string) => Promise<void>
  readonly scan:   (options: StorageScanOptions) => Promise<StorageScanResult>
}
// packages/plugin/src/storage.ts
export interface StorageScanOptions { readonly prefix: string; readonly after?: string; readonly limit?: number }
export interface StorageScanResult  { readonly entries: readonly StorageEntry[]; readonly next?: string }
export interface StorageEntry       { readonly key: string; readonly value: Schema.Json }
```

- **任意字符串键 + JSON 值 + 前缀 `scan`**，够 REEVE 用。
- **命名空间由宿主加**：每个键自动前缀 —— 二进制里是
  `storage.store(\`plugin.${t.id}.${h}\`, m)`；**但落到磁盘上的形式不一样**：

  > ⚠️ **实测更正（2026-10-19，EL7 v2.0.27，读 `opencode.db` 的 `kv` 表）**：
  > 实际键是 **`plugin:<插件 id 的 hex>:<你的键>`** —— 分隔符是 **`:`** 而不是 `.`，
  > 且 id 被 **hex 编码**。REEVE 的真实样本：
  > `plugin:00720065006500760065:ledger/call_8dbc86b68d8048fa923b3376`
  > （`0072 0065 0065 0076 0065` = `reeve`）。
  > → **步 5 的控制台若要直读台账，必须按这个格式拼键**（或改用插件的 `reeve_task_status` 工具）。
  > 本文早先按二进制字符串写成 `plugin.<id>.`，按那个格式在文件里查是**查不到**的。

  → **你的 `id` 就是隔离边界**，不必自己加前缀。
- 持久化在宿主存储服务里（本机 `~/.local/share/opencode/opencode.db` 的 **`kv` 表**，
  列为 `key, value, time_created, time_updated`）。
- **注意区分**：二进制里另有一个 `context.storage.store(name, {initial})` / `.memory(name, {initial})`
  返回 `[value, setter]` —— 那是 **TUI 的响应式 store**，与插件的 `StorageDomain` **不是一回事**。

---

## 8. `subagent` 工具（记账层的输入源）

`packages/core/src/tool/plugin/subagent.ts` @ v2.0.32：

```ts
export const name = "subagent"
export const Input = Schema.Struct({
  agent:       Schema.String,
  description: Schema.String,
  prompt:      Schema.String,
  model:       Schema.optionalKey(Schema.String),    // "providerID/modelID" 或 ".../modelID#variant"
  sessionID:   Schema.optionalKey(SessionSchema.ID), // 续跑某个子会话
  background:  Schema.optionalKey(Schema.Boolean),
})
export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status:    Schema.Literals(["completed", "running"]),
  output:    Schema.String,
})
```

注册为 `ctx.tool.transform(editor => editor.add({ name, options: { codemode: false }, description, input: Input, output: Output, execute }))`。
工具 id = `opencode.tool.subagent`。

**返回值（这就是台账的输入）**：

| 情形 | 返回 |
|---|---|
| **后台立即返回** | `{ sessionID, status: "running", output: "<文本，含 (sessionID: <id>) 与'不要轮询'>" }` |
| **前台成功** | `{ sessionID: child.id, status: "completed", output: result?.info.output ?? NO_TEXT }` |
| **失败** | 文本 `Subagent failed (sessionID: <id>): ...` |
| **取消** | 文本 `Subagent cancelled (sessionID: <id>)` |

前台成功时 tool 的 **content 被包成**：

```
<subagent sessionID="<id>" state="completed">
<output>
</subagent>
```

metadata = `{ sessionID, status }`。

**→ 解析策略（按可靠性排序）**：
1. 优先读**结构化的** `output.sessionID` / `metadata.sessionID`（`execute.after` 里拿得到 `Tool.Result`）；
2. 退化到文本正则：后台的 `(sessionID: <id>)`、完成的 `<subagent sessionID="<id>" ...>`。

工具描述里会追加 `Available subagents:` 与 `- <id>: <description>` 行，受调用方的 `subagent` 权限控制。

---

## 9. agent 定义 schema（v2）

`packages/schema/src/config/agent.ts` @ v2.0.32：

```ts
export class Info extends Schema.Class<Info>("Config.Agent")({
  model:       ConfigModel.Selection.pipe(optional),
  request:     ConfigProvider.Request.pipe(optional),
  system:      Schema.String.pipe(optional),          // ← 不是 v1 的 prompt
  description: Schema.String.pipe(optional),
  mode:        Schema.Literals(["subagent", "primary", "all"]).pipe(optional),
  hidden:      Schema.Boolean.pipe(optional),
  color:       Color.pipe(optional),
  steps:       PositiveInt.pipe(optional),            // ← 不是 v1 的 maxSteps
  disabled:    Schema.Boolean.pipe(optional),         // ← 不是 v1 的 disable
  permissions: Permission.Ruleset.pipe(optional),     // ← 不是 v1 的 permission
}) {}
```

- 配置键是 **`agents`（复数）**，类型 `Record<string, ConfigAgent.Info>`
  （`packages/schema/src/config.ts`）；v1 的单数 `agent` 会被自动迁移。
- 顶层权限键同样是复数 **`permissions`**。
- 运行期形态 `Agent.Info = { id, name, model?, request, system?, description?, mode, hidden, color?, steps?, permissions }`。

→ **旧文档 §3.1 的键名对照表（`agents` 复数 / `system` / `permissions` / `steps`）确认无误**，
补两条：`disable` → `disabled`、`variant` 以 `#variant` 后缀出现在 model 字符串里。

---

## 10. provider 配置（v2）

`packages/schema/src/config.ts` @ v2.0.32 声明的**原生**键是**复数**：

```ts
providers: Schema.Record(Schema.String, ConfigProvider.Info).pipe(optional)
```

而 `packages/core/src/config/normalize.ts` 会把**遗留的单数** `provider` 迁移进来：

```ts
const legacyProviders = migrateProviders(input.provider, diagnostics)              // 单数
const nativeProviders = decodeMap(input.providers, ConfigProvider.Info, ["providers"], ...)  // 复数
mergeMap(encoded, "providers", legacyProviders, nativeProviders, ..., ...)
```

→ **两种写法在 2.0.32 上都有效**。本机 `D:\develop\ocrc-exp\home\.config\opencode\opencode.json`
用的就是**单数**形态（`npm` + `options: { baseURL, apiKey }`，属 v1 字段名，会被迁移成
`package` + `settings`），而 `stub-log.jsonl` 证明真实流量确实打到了自定义 `baseURL`。

**原生 `ConfigProvider.Info` 字段**：`{ canonical?, name?, env?, package?, compatibility?, settings?, headers?, body?, models? }`
—— 注意是 **`package`**（不是 `npm`）与 **`settings`/`headers`/`body`**（不是 `options`）。

**已实测的关键事实（写代理层时用）**：自定义 provider 的 **`models` 的 key 会成为发给端点的 `model` 值**。
隔离栈证据（`D:\develop\ocrc-exp\stub-log.jsonl`，8 条记录）：

```json
{"seq":4,"method":"POST","url":"/v1/chat/completions","requestModel":"router/flash","stream":true,"messageCount":2,"tools":null}
{"seq":5,...,"requestModel":"router/flash",...,"tools":12}
```

配置里 `model` 写的是 `probe/router/flash`（provider id `probe` + models key `router/flash`），
**端点收到的是 `router/flash`**。含第 3、4 回合不带 `--model` 标志的请求，也仍是 `router/flash`。

### 10.1 ⚠️ `modelID` 别名：能用，但**只在原生 `providers` 形态下生效**

模型条目另有一个 **`modelID`** 字段，可**显式指定线上名**，让"ref"与"线上名"解耦：

```ts
// packages/schema/src/config/provider.ts @ v2.0.32
class Model extends Schema.Class<Model>("Config.Model")({
  modelID: ID.pipe(optional),   // ← 线上名
  family, name, releaseDate, compatibility, package, ...ModelOverlays,
  capabilities, variants, cost, disabled, limit,
}) {}
// 消费点：packages/core/src/model-resolver.ts:234
//   module.model(resolved.modelID ?? resolved.id, settings)
// 测试断言：packages/core/test/model-resolver.test.ts:263
//   "uses the API modelID instead of the catalog ID for native OpenAI routes"
```

**⚠️ 文档里没有这个字段**（`models.mdx` 没有 Aliases 一节）——属于"可用但未文档化"，
升级引擎必须重新核对。

**实测：能不能生效，取决于 provider 用哪种配置形态**（2026-10-19，隔离栈 + 桩服务）：

| provider 配置形态 | `modelID` 是否生效 | 桩收到的 `model` |
|---|---|---|
| **原生复数** `providers` + `package`/`settings` | ✅ **生效** | `reeve/flash` |
| **遗留单数** `provider` + `npm`/`options` | ❌ **被忽略** | `flash`（models 的 key） |

两条实测记录（桩日志 `requestModel` 字段）：

```
原生形态  ：{"seq":1,"method":"POST","url":"/v1/chat/completions","requestModel":"reeve/flash",...}
遗留形态  ：{"seq":2,"method":"POST","url":"/v1/chat/completions","requestModel":"flash",...}
```

**→ 结论（REEVE 必须照做）**：
1. opencode 侧接 Bifrost 的 provider **必须写成原生复数 `providers` + `package`/`settings`**；
   用遗留单数形态虽然也能通（流量确实打到自定义 baseURL），但**`modelID` 会被静默忽略**——
   线上名退化成 models 的 key，Bifrost 的 CEL 就会匹配不上。**这是静默失败，不是报错。**
2. 想用别名（ref ≠ 线上名），只能走原生形态。

**REEVE 的用法**（让 ref 与线上名一致）：

```jsonc
"providers": { "reeve": { "name": "REEVE Router",
  "package": "@ai-sdk/openai-compatible",
  "settings": { "baseURL": "http://127.0.0.1:8080/v1", "apiKey": "env.BIFROST_KEY" },
  "models": {
    "flash":      { "modelID": "reeve/flash" },
    "pro":        { "modelID": "reeve/pro" },
    "multimodal": { "modelID": "reeve/multimodal" }
  } } }
```

→ agent 写 `model: reeve/flash`；**ref 与线上名都是 `reeve/flash`**；
Bifrost 的 CEL 写 `model == "reeve/flash"`，**零映射层**。

> **⚠️ 更正**：本文档早先写"**不需要** HANDOFF §4.8 说的原生 Aliases 那层"——**那是错的**。
> 当时只验证了"models 的 key 会成为线上名"（在遗留形态下确实如此），
> 没验证 `modelID` 是否存在、是否可用。**HANDOFF §4.8 从一开始就是对的。**

---

## 11. 本文取代的旧说法（逐条）

| 旧说法 | 出处 | 本文结论 |
|---|---|---|
| `tool.execute.before` / `tool.execute.after` | HANDOFF §6.1、§6.2⑤；verdict §4.2⑤ | ❌ v1 名。v2 是 `ctx.tool.hook("execute.before"\|"execute.after", cb)` |
| 工具注册（未指明 API） | HANDOFF §6.1① | 用 `ctx.tool.transform(e => e.add({ name, description, input, output, options, execute }))`；**必须带 `options.namespace`** |
| "v2 **不再发** `session.idle`" | HANDOFF §6.1 注、§12 | ⚠️ 部分错：v2 **仍发**，只是标了 `// deprecated` |
| `message.part.updated` 是 v2 事件 | verdict §4.4① | ❌ 只在 v1 遗留模块；v2 是 `session.text.*` / `session.tool.*` / `session.step.*` |
| `question.*` 事件 | verdict §4.4① | ⚠️ 不在 2.0.32 类型联合里（运行期可能仍在，未验证） |
| `SessionDomain` 只有 `create/get/switchAgent/switchModel/prompt/generate/command/synthetic/interrupt/update/move/wait/context` | HANDOFF §3.3 | ⚠️ 漏了 **`remove`** 与 **`compact`**；"拿不到 `list`/`children`/`status`/`todo`"**成立** |
| `experimental.chat.messages.transform` 是惰性对账的挂载点 | verdict §4.4③（转述 omo-slim） | ❌ v1 钩子名；v2 需改用 `ctx.session.hook("context"\|"prompt", cb)`，**选哪个待实测** |
| `{ id, setup }` 入口 | HANDOFF §1.1 | ✅ 正确（v1 是 `{ id, server }`） |
| `ctx.session.interrupt({ sessionID, resume: false })` | HANDOFF §6.2④ | ✅ 正确 |
| `ctx.storage` 键值域 | HANDOFF §6.4 | ✅ 正确（`get/set/remove/scan`；宿主自动加 `plugin.<id>.` 前缀） |
| `agents` 复数 / `system` / `permissions` / `steps` | HANDOFF §3.1 | ✅ 正确 |
| subagent 工具输出可解析出 sessionID | HANDOFF §6.2② | ✅ 正确，且是**结构化**的 `{ sessionID, status, output }` |

---

## 12. 仍未验证（下一步要实测的）

1. **`tool.execute.before` 的返回值能否替换 args**（而不只是原地改 `input`）。
   类型允许原地改，内置 `subagent` 工具就是这么做的；返回对象是否被采用**源码里没看到证据**。
2. **`question.*` 事件在 2.0.32 运行期是否存在**（类型联合里没有，二进制里有字符串）。
3. **`ctx.storage` 的实际读写行为**（键前缀、并发、跨进程可见性）—— 类型已确认，行为未跑过。

**已由 2026-10-19 的探针实测解决**（不要再当未决项）：

| 原未决项 | 结论 | 出处 |
|---|---|---|
| 工具是否还需要 `namespace` 之外的开关 | ✅ **需要 `options.codemode: false`**；`namespace` 只管命名 | §3.1 |
| 本地目录插件的加载路径 | ✅ `plugins: ["<绝对路径>"]` 可用（**Windows 上必须正斜杠**）；发现目录 `.opencode/plugins/` 与 `~/.config/opencode/plugins/` | §14.7 |
| 惰性对账挂 `context` 还是 `prompt` | ✅ 两者都触发；**`prompt` 先触发**（回合开始，早于 `session.execution.started`），`context` 在构造模型调用时触发 | §14.7 |
| 插件入口/钩子/事件是否真的工作 | ✅ `setup()` 被调用、钩子被调用、事件流正常 | §14.7 |

---

## 13. 复现方式

- 上游类型：`gh api "repos/anomalyco/opencode/contents/<path>?ref=v2.0.32"`
- 本机二进制：`D:\develop\ocrc-exp\node_modules\@opencode\cli-windows-x64\bin\opencode.exe`（213 MB Bun bundle，可 grep 运行期字符串）
- 隔离栈：`D:\develop\ocrc-exp\home\`。⚠️ **只有 `HOME` 是有效杠杆**——
  实测 `XDG_CONFIG_HOME` 与 `OPENCODE_CONFIG_DIR` **都不重定向配置目录**（见 §14.2）
- 桩服务：`D:\develop\ocrc-exp\stub.mjs`（伪装 OpenAI 兼容端点，记录每个请求的 `model`）
- ocrc 侧的黑盒验证记录：`D:\develop\ocrc\docs\research\e2-verdict.md`（工具面在 2.0.27 上实测过）

---

## 14. agent 定义的加载（2026-10-19 实测）

### 14.1 三种定义方式，全部可用

在隔离栈上逐一验证（`opencode debug agents`，v2.0.32）：

| 方式 | 位置 | 实测结果 |
|---|---|---|
| **配置 `agents` 键** | `$HOME/.config/opencode/opencode.json` 的 `agents: { <id>: {...} }` | ✅ 生效 |
| **markdown，单数目录** | `$HOME/.config/opencode/agent/<id>.md` | ✅ 生效 |
| **markdown，复数目录** | `$HOME/.config/opencode/agents/<id>.md` | ✅ **也生效**（两个目录都被扫描） |

markdown 的 frontmatter 字段名与配置键一致（`description` / `mode` / `model` / `system` / `permissions` / `steps`…）。

**v2 内置 agent**（未配置时也存在，供对照）：`build` / `compaction` / `explore` /
`general` / `plan` / `summary` / `title`。

**默认权限规则集**（未指定 `permissions` 时自动附加）：

```json
[
  { "action": "*",       "resource": "*",             "effect": "allow" },
  { "action": "read",    "resource": "*.env",         "effect": "ask"   },
  { "action": "read",    "resource": "*.env.*",       "effect": "ask"   },
  { "action": "read",    "resource": "*.env.example", "effect": "allow" },
  { "action": "browser", "resource": "*",             "effect": "deny"  }
]
```

→ 注意 **`browser` 默认 deny**；`permissions` 的规范形态是
`[{ action, resource, effect }]` 对象数组（不是 v1 的 `[["edit","deny"]]` 二元组，
后者只出现在遗留的 `permission` 键上，会被 `Hx()` 转换）。

### 14.2 ⚠️ 配置目录的杠杆是 `HOME`，不是 `OPENCODE_CONFIG_DIR`

**实测结论（Windows / v2.0.32）**：

| 变量 | 是否重定向配置目录 |
|---|---|
| `HOME`（+ `USERPROFILE`） | ✅ **是**（配置 = `$HOME/.config/opencode`） |
| `XDG_CONFIG_HOME` | ❌ **否** |
| `OPENCODE_CONFIG_DIR` | ❌ **否** |

**验证方式**：把三个候选变量分别指向含唯一标记 provider 的目录，
停掉后台 service 后跑 `opencode debug config`，看读到的是哪个 provider
——只有 `HOME` 生效（读到 `$HOME/.config/opencode` 里的配置）。

> ⚠️ **这直接改写 PLAN §2「配置目录隔离」的做法**：ocrc 要隔离 v2 实例的配置，
> **设 `OPENCODE_CONFIG_DIR` 不管用**（在 Windows 上已证伪；**Linux/EL7 上未验证**，
> 必须先在 EL7 上重做同一实验）。**EL7 上的待验证项**。

### 14.3 ⚠️ 后台常驻 service 会钉住环境（最容易踩的坑）

**v2 默认跑一个后台 service**（`opencode service start|stop|restart|status`），
`debug config` / `debug agents` 等命令**打的是这个 service**，而不是当场起进程。

**后果**：改 `HOME` / 配置 / 环境变量后，**不重启 service 就看不到任何变化**——
而且 `--standalone` 对 `debug` 子命令**无效**（报 `Unrecognized flag`）。

**正确的隔离栈操作姿势**：
```
opencode service stop          # 必须先停
HOME=<隔离目录> opencode debug agents
```
（`service get/set/unset` 可改 service 自身的配置。）

**这条踩过**：本次调查中我一度因为 service 钉住了最初那套环境，
得出过"`OPENCODE_CONFIG_DIR` 不生效"与"配置 `agents` 键不生效"两个**错误结论**——
都是 service 造成的假象。**任何环境相关的结论，都要在 `service stop` 之后重做。**

### 14.4 ⚠️ `service stop` 之后的第一次调用会返回空

**实测**：`opencode service stop` 紧接着调 `debug agents`，返回 `[]`（**连内置 agent 都没有**）
——service 还没起来。**必须预热一次或 sleep 几秒再读**。

**这条也踩过**：一次二分排查中，我每轮都 `service stop` 再单次调用，
结果 8 个 agent 全部显示加载失败——**是假阴性**，差点得出"我的 frontmatter 有错"的错误结论。

**隔离栈读取姿势（最终版）**：
```bash
opencode service stop
sleep 3
opencode debug agents >/dev/null    # 预热，丢弃
opencode debug agents               # 真读
```

### 14.5 两条已验证的语义

**① markdown 的正文就是 `system`（不是文件名、不是额外字段）**

实测：`agent/aaa-cfg-agent.md` 的 frontmatter 之后写 `You are probe AAA-cfg-agent.`，
`debug agents` 里该 agent 的 `system` 字段**逐字就是那行正文**。

→ **所以"agent 定义文件"与"system prompt"是同一个东西，不需要再维护一份 `prompts/*.md`**
（那会造成两处真相）。REEVE 的 8 个 agent 因此**只落 `agents/*.md`**，不另设 prompt 文件。

**② `permissions` 与默认规则集是"合并"，不是"替换"**

实测：显式写 5 条 `permissions` 的 agent，最终规则数是 **10 条**（5 条自定义 + 6 条默认，去重后 10）。
→ 默认的 `*.env → ask` / `browser → deny` **不会因为自定义 permissions 而丢失**，
不必在每个 agent 里重复抄一遍默认规则。

（重复声明同一条规则是安全的——`browser deny` 会出现两次，无副作用。）

### 14.6 REEVE 的 8 个 agent 实测加载结果

**第一次运行（2026-10-19，档位命名空间还是 `router/`）**：

```
总数: 15（8 个自定义 + 7 个内置）

advisor     subagent  reeve/router/pro     deny:[edit,shell,browser]
critic      subagent  reeve/router/pro     deny:[edit,shell,browser]
planner     subagent  reeve/router/pro     deny:[edit,shell,browser]
reviewer    subagent  reeve/router/pro     deny:[edit,shell,browser]
foreman     primary   reeve/router/pro     deny:[browser]
librarian   subagent  reeve/router/flash   deny:[edit,browser]
scout       subagent  reeve/router/flash   deny:[edit,browser]
executor    subagent  reeve/router/flash   deny:[browser]          ← 唯一有写权的 subagent

内置（对照）：
build       primary   —                    deny:[browser]
compaction  primary   —                    deny:[browser]
explore     subagent  —                    deny:[*,subagent,browser]
general     subagent  —                    deny:[question,subagent,browser]
plan        primary   —                    deny:[edit,browser]
summary     primary   —                    deny:[*,browser]
title       primary   —                    deny:[*,browser]
```

**改名后复验（2026-10-19，命名空间 `router/` → `reeve/`，配原生 `providers` + `modelID`）**：

```
自定义 agent 数: 8
  advisor     subagent  reeve/pro
  critic      subagent  reeve/pro
  executor    subagent  reeve/flash
  foreman     primary   reeve/pro
  librarian   subagent  reeve/flash
  planner     subagent  reeve/pro
  reviewer    subagent  reeve/pro
  scout       subagent  reeve/flash
```

**两次全部通过**：无 schema 报错、`mode`/`model`/`permissions` 均按预期归一化。

**关于 model ref（最终形态）**：写 `model: reeve/pro` 表示
provider id = `reeve` + models key = `pro`；该条目的 `modelID` 显式设为 `reeve/pro`，
所以 **ref 与发给端点的线上名都是 `reeve/pro`**（实测见 §10.1）。
→ Bifrost 的 CEL 直接写 `model == "reeve/pro"`，**零映射层**。
**前提**：provider 必须用**原生复数 `providers` + `package`/`settings`** 形态——
遗留单数形态会**静默忽略 `modelID`**（§10.1）。

### 14.7 插件端到端探针（2026-10-19 实测）

用一个最小插件（`export default { id, setup }`）走通了**整条插件链路**。

**加载**：`plugins: ["D:/develop/.../pkg"]`（目录绝对路径，**正斜杠**）→ 成功。
目录里放 `package.json`（`{"type":"module","main":"index.js"}`）+ `index.js` 即可。

**实测输出**（`--print-logs`，stderr）：

```
[probe] setup() 被调用
[probe] 两个工具已注册
[probe] 钩子已挂
[probe] 事件订阅已建立
[probe] session.hook prompt sid=ses_plug002        ← 先触发
[probe] event session.inbox.enqueued
[probe] event session.execution.started
[probe] event session.instructions.updated
[probe] event session.inbox.delivered
[probe] session.hook context sid=ses_plug002       ← 后触发（构造模型调用时）
[probe] event session.step.started
[probe] event session.text.started / delta / ended
[probe] event session.step.streamed / ended
[probe] event session.usage.updated
[probe] event session.execution.succeeded
[probe] event session.renamed
```

**由此确定的事实**：

1. **插件入口、`setup()`、`ctx.tool.transform`、`ctx.tool.hook`、`ctx.session.hook`、
   `ctx.event.subscribe()` 全部可用**——整条链路打通。
2. **回合内的触发顺序**（对记账层很重要）：
   `session.hook("prompt")` → `session.execution.started` → `session.hook("context")`
   → `session.step.started` → … → `session.execution.succeeded`。
   → **惰性对账挂 `prompt` 最稳**（回合一开始就触发，早于执行）；`context` 也可以，
   但它在构造模型调用时才触发，语义更"贴近请求"。
3. **事件名与类型联合一致**：`session.execution.started/succeeded` 确实发；
   `session.inbox.*` / `session.step.*` / `session.text.*` / `session.usage.updated` /
   `session.renamed` 也都观测到了。
4. **`session.idle` 在这次运行里没被观测到**（该会话跑完即结束）——它存在但已弃用，
   不要依赖它。
5. **工具暴露的开关是 `options.codemode: false`**，不是 `namespace`（§3.1）。

---

## 15. ⚠️ 配置 JSON 的一个语法错会**静默丢掉整份配置**

**实测踩到**：把插件路径写成 Windows 反斜杠——

```jsonc
"plugins": ["D:\develop\ocrc-exp\plugprobe\pkg"]     // ❌ \d \o \p 不是合法 JSON 转义
```

结果**不报错**，但 `opencode debug config` 只剩一个 `{"type":"directory"}` 源，
**没有 `document`**——整份配置文档被丢弃：provider 没了、model 没了、
于是请求打到了 OpenCode 自带的免费档，报
`OpenCode's free tier can only be used from within OpenCode`。

**判据**：`debug config` 里**必须有 `{"type":"document","path":...}` 这一项**。
只有 `directory` = 你的配置文件没被读进去。

**规避**：JSON 里一律用**正斜杠**（Windows 也认）；改完配置先跑一次 `debug config` 确认 document 在。

---

## 16. skill 的发现规则与 apiKey 的两种语法（2026-10-19 实测）

### 16.1 skill 目录必须含 `SKILL.md` 或 `<目录名>.md`

**实测（从二进制里读出的发现逻辑）**：

```js
scan("{*.md,**/SKILL.md}", { cwd: <skill root>, ... })
// 然后过滤：
if (!files.includes("SKILL.md") && !files.includes(`${name}.md`)) return []   // ← 丢弃
```

- skill 的**根目录**：`$HOME/.config/opencode/skill/` 与 `skills/` **两个都被扫**（实测）
- 一个目录要成为 skill，里面必须有 **`SKILL.md`** 或 **`<目录名>.md`**
- skill 的**名字**取自：文件名（去掉 `.md`）；若文件名就是 `SKILL.md`，则取**目录名**

**踩过**：REEVE 的审查规则一开始放在 `skills/review/README.md` —— **既不是 `SKILL.md`
也不是 `review.md`，所以它根本没被当成 skill**。agent 只能靠 `read` 硬读那个文件路径，
skill 列表里没有它。**改成 `skills/review/SKILL.md` 才被发现。**

**frontmatter**（参照上游 OCR 的 `SKILL.md`，它是在跑的 skill）：至少要有 `name` 与 `description`，
`description` 要写清**什么时候用**。其余字段（`license` / `metadata` / `compatibility`）自由。

**注意**：同目录下的其他 `.md`（REEVE 的 7 份 rubric）**不会**各自变成 skill
——`**/SKILL.md` 只匹配嵌套的 `SKILL.md`，`*.md` 只匹配 skill 根目录那一层。
它们就是 skill 自带的**参考资料**，靠 `read` 取用。

### 16.2 ⚠️ `settings.apiKey` 的两种语法**不通用**

| 位置 | 正确写法 | 实测 |
|---|---|---|
| **opencode** 的 `providers.<id>.settings.apiKey` | **`{env:VAR}`** | ✅ 生效（`debug config` 里打码成 `***`） |
| **Bifrost** 的 `providers.<id>.keys[].value` | **`env.VAR`** | ✅ 生效（Bifrost 自己的语法，官方文档确认） |

**踩过**：把 opencode 侧也写成 `"apiKey": "env.REEVE_TEST_KEY"` → **不报配置错**，
而是把**字面串当密钥发出去**，服务端回 `Invalid token`。
—— 又一个**静默失败**：配置合法、能加载、只是认证必然失败。

**判据**：改完配置跑一次 `opencode debug config`，`apiKey` 应该显示成 `***`；
如果显示成 `env.XXX` 原文，就是写错了。


