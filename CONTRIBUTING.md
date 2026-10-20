# Contributing to REEVE

REEVE is an orchestration layer for opencode v2: agent definitions, a ledger
plugin that fills the gaps v2 leaves, a Bifrost proxy chain, and an openchamber
console. Contributions that fit those boundaries are welcome.

## Before you start

- Read [docs/PLAN.md](docs/PLAN.md) (ownership, step order, hard gates) and
  [NOTICE.md](NOTICE.md) (license boundaries).
- **Never introduce code or prompt literals from `oh-my-openagent` (SUL-1.0).**
  Ideas can be re-expressed; text cannot be copied.
- The public tree (GitHub `main`, npm) does not contain `docs/`; development
  records stay in the development repository and are cut on export.

## Setup

Requirements: Node.js >= 22 (the engine version measured on EL7 is 24).

```bash
npm --prefix plugin test          # 135 ledger/gate/proxy tests, zero dependencies
node scripts/check-plugin-pack.mjs
node scripts/check-config-sample.mjs
node extensions/reeve/check.mjs    # manifest, bundle, no controller actions, single write path
npm --prefix extensions/reeve ci
npm --prefix extensions/reeve run build
git diff --exit-code -- extensions/reeve/panel   # committed panel must match src
```

`extensions/reeve/panel/` is committed because openchamber does not compile
TypeScript; editing `src/` without rebuilding is a stale panel on a real host.

## Tests

- `plugin/test/*.mjs` — pure Node, offline. Add a test with each behaviour
  change; tests must not reach a provider or the public network.
- `extensions/reeve` — build plus `check.mjs`; UI behaviour is verified through
  the CDP scripts during development and by the panel build gate in CI.
- No test may point at a production engine or a real model endpoint.

## Style

- Plain ESM JavaScript for the plugin; TypeScript for the extension.
- Keep the plugin dependency-free.
- Comments explain **why** a rule exists (usually a measured failure), not what
  the next line does.
- The plugin must not write `agents.*.model`, the `plugins` array, or any
  engine config outside its own endpoint bootstrap.

## Pull requests

- One logical change per commit; describe the failure it fixes.
- CI must be green: plugin tests on Node 22 and 24, pack assertions, extension
  build/dist consistency, config sample, public-tree gate.
- By contributing you agree your changes are licensed under the MIT License of
  this repository (outside material keeps its own license and notice).
