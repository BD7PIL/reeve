# Changelog

Newest first. Versions follow the plugin package (`plugin/package.json`); the
panel extension has its own tags (`reeve-<version>`).

## 0.1.13 — 2026-10-22

**Five tiers, image routing, image-only free pool.** The plugin now registers
`reeve/flash`, `reeve/standard`, `reeve/pro`, `reeve/manual`, and
`reeve/multimodal`; all declare image input. GATE detects image parts in the
request body and routes `reasoning` image requests to the `vision` chain for
that request only — the session model and composer selection do not change.
`reeve/manual` is a single-target chain for foreman (no automatic fallback).
The free pool now requires image-capable models (`free.require_image` +
`free.image_models`), so text-only free models such as `big-pickle` never enter
the pool. Added a hidden `looker` subagent on `reeve/multimodal` for images/PDFs
on disk; pasted images are handled by the GATE route. Chains: standard cost-first
(zhipu → lmuai → @free → deepseek), reasoning reliability-first (zhipu → deepseek
→ lmuai → @free), free-first (@free → zhipu → lmuai → deepseek), manual
(zhipu glm-5.3-flash only), vision (same as standard). xxyapi-deepseek, nvidia,
xiaomi, and alibaba-cn are removed from the production fallback config.

## 0.1.12 — 2026-10-22

**Fix the deployable artifact: `provision.json` still pinned 0.1.10.** The
0.1.11 npm package carried the four-tier code but its `provision.json` still said
`0.1.10`, so `ocrc remote apply --with-components` installed the old component.
`provision.json` is now 0.1.12, and `plugin/test/unit.mjs` asserts its version and
`enginePlugin.spec` match `package.json` so this cannot drift silently again.

## 0.1.11 — 2026-10-22

**Four tiers with cost-appropriate agent allocation; chain names are strategies.**
The plugin now registers `reeve/flash`, `reeve/coding`, `reeve/pro`, and
`reeve/multimodal`. The fallback chains were renamed from legacy `tier1`/`tier2a`
to `reasoning` / `coding` / `free-first` / `vision` / `fallback`. Bundled agents
now split work by cost: planner/advisor/critic use `reeve/pro` (strong reasoning),
foreman/executor/reviewer use `reeve/coding` (mid-tier), and scout/librarian use
`reeve/flash` (free-first). The top-level default model is `reeve/coding`, so bare
runs and the composer no longer fall into the strongest reasoning chain. The
bundled fallback config and the user config are updated together; engine configs
must remove per-agent `model` overrides so the plugin's allocation applies.

## 0.1.10 — 2026-10-22

**Fix: the panel's "已生效" waited on the 60-second stats cadence.** The
snapshot's gate section was only refreshed by the stats loop (60s), so a
real-host save (GATE hot-reloaded in ~1s) showed "没生效" after the panel's 30s
timeout — the preview harness' echoed write hid it. A lightweight gate-state
refresh now polls the in-process snapshot (or loopback `/gate/version` for a
reused GATE) every 2s and flushes the snapshot only when the signature changes.
The new real-host safe save test (`scripts/host-audit.mjs --save`) caught this:
backup → add a temp chain in the panel → save → assert GATE `chain_targets`
changed → restore in `finally` with a sha256 check.

## 0.1.9 — 2026-10-22

**Fix: OpenRouter/NVIDIA providers pointed at a doubled "/v1".** Their base URLs
already end in `/v1`, but the provider blocks did not set `path`, so GATE called
`https://openrouter.ai/api/v1/v1/chat/completions` (404). The bundled default now
sets `"path": "/chat/completions"` for both; the user config was updated in the
same commit. Ops: the extension is 0.1.4 (306px host-sidebar layout: secondary row
meta is hidden so the `@free` title/badge stay one line).

## 0.1.8 — 2026-10-22

**Fix: a 400 from zen meaning "model unavailable" is now a failover, not a caller error.**
Zen answers unknown free models with HTTP 400 + `Model is unavailable.`; the
classifier treated any 400 as non-retryable, so a dead free candidate aborted the
request instead of falling through to paid. The always-retry patterns now cover
`Model is unavailable` / `model does not exist` (and the ALWAYS table is a
`[regex, reason]` pair list so inserting a rule cannot shift the reasons).
The real-host acceptance step ② is honest about the passthrough shape gate:
a non-engine caller gets 403 from the free tier, so ② now asserts the free lane
was attempted and the chain fell through to paid; the engine-side free success is
proven by ③f.

## 0.1.7 — 2026-10-22

**GATE grows a native free lane (`@free`) and 9router is retired.** Chains can
now write `@free`; GATE expands it at request time into the currently
discoverable, non-cooling, keyed free candidates. The chain file no longer
stores a list that rots, and there is no sidecar daemon to keep alive.

- **Free lane** (`plugin/src/gate/free.js`): discovery from the public
  OpenCode Zen list (`-free`/`big-pickle`, minus `deepseek-v4-flash-free`) and
  the OpenRouter catalog (`:free`), plus a static whitelist for NVIDIA (its
  free tier is account quota, not a model marker). TTL cache; a failed refresh
  keeps the last good list and reports the error. Expansion order: `prefer`
  (full ref or bare model id) → provider/discovery order; `deny` never
  expands. Free attempts are capped at `min(free.max, max_fallback_attempts-1)`
  so a paid fallback always gets one slot (default 3 free + 1 paid). Failed
  free models cool down globally (3 consecutive failures → 600s); when every
  free candidate is cooling/unkeyed/unavailable the request goes straight to
  paid. Dynamic chains do not use the index-based sticky pointer; per-ref
  cooldowns carry the state instead.
- **`/gate/free`** exposes the runtime picture (providers, discovery errors,
  current expansion, cooldowns) and the plugin projects it into the snapshot;
  `GET /v1/models` now includes discovered free models so the panel's picker
  can pin them. `/gate/version` carries the `free` config block for the
  panel's applied check.
- **9router retired**: provider/targets removed from the shared fallback
  config, `setup-9router.mjs` deleted, autostart removed on both machines,
  acceptance steps rewritten around the direct free lane. MiMo Code Free
  (`mmf/mimo-auto`) was the one zero-config provider that came with 9router;
  it is intentionally dropped.
- **Panel** (`extensions/reeve` 0.1.3): a 免费车道 card (enable, slot count
  with the budget rule, discovery providers + key/readiness, prefer/deny,
  NVIDIA whitelist, refresh/failure knobs, live expansion), `@free` rendered
  as an automatic row in chains, and the applied check now compares
  `chain_targets` + `policy` + `free` against what was saved (the old
  name-only check reported "applied" even when candidate edits never reached
  GATE). Fixes from the multimodal review: light-mode selected-row contrast,
  shared right edge for controls, narrow-viewport stacking, dark input
  surfaces, ledger row affordances/hairlines, per-section dirty markers,
  free-lane error banner, snapshot/config error recovery.
- **Verification**: 15 free-lane tests, 26 gate tests (new concurrency cases:
  40 parallel requests, one-advance dedupe, abort isolation), a two-round
  soak script (`scripts/soak-gate.mjs`: no second-round heap growth), an
  isolated-engine lifecycle acceptance (`scripts/accept-lifecycle.mjs`:
  workspace eviction no longer closes GATE), a 39-item UI audit with
  programmatic assertions (console/overflow/tokens/contrast/a11y) wired into
  CI with headless Chrome, and a daily upstream-catalog sentinel.
- **Docs**: `docs/FREE-LANE.md`, `docs/GATE.md` rewritten for 0.1.7,
  rollback manual updated with the 9router removal steps.

## 0.1.6 — 2026-10-22

**Fix: the proxy no longer disappears with the workspace that started it.** GATE
is an engine-level service, but it used to be closed by the plugin instance that
started it. The engine loads plugins **per workspace** and evicts idle locations
(`location services evicted`); on both machines that silently took port 18080
down while the engine kept running, so any *other* live workspace would get
connection-refused from then on (its plugin instance had reused the GATE and
never re-probed — permanent until an engine restart). Unloading now calls
`detach()`: the listener and the config watcher stay, already-idle keep-alive
sockets are swept, and the listening handle is `unref`ed so one-shot processes
(`opencode run`) still exit at once — a child-process regression test pins both
halves. `dispose()` remains the explicit stop used by tests and upgrades.

**Fix: the reported plugin version could lie.** `PLUGIN_VERSION` was a hand-copied
constant next to `package.json`'s `version`; 0.1.5 shipped with the constant still
saying `0.1.4`, so both ends' snapshots (and the panel's version reading) reported
the old number. The constant is now **derived from `package.json`** at load time,
with a unit test that fails if the two ever diverge again.

## 0.1.5 — 2026-10-22

**Bifrost retired; the proxy layer is now GATE only — plain JS inside the
plugin (no binary, no separate service, no platform pins).** One delivery:
retire + native proxy + panel UI.

- **Removed**: `src/proxy.js` (Bifrost pins/fetch/spawn/converge/supervise),
  `src/chain.js` (chain file ↔ `routing_rules`), `default-chain.json`,
  `proxy/` (Bifrost app config), `scripts/bifrost-sync-config.sh`,
  `scripts/served-model.*`, and their tests. `provision.json` loses the
  `bifrost` artifact and its `verify` entry (`host.os` gains `win32`: no
  platform binary any more).
- **Stats** now read the GATE ledger (`~/.reeve/gate.jsonl`, JSONL, one row per
  attempt) instead of `/api/logs`: request/attempt two-level rollups, fallback
  hops, per-chain/per-provider/per-model attribution. Ledger rows gained `req`
  (call id) and `n` (attempt ordinal) so fallback depth is visible.
- **GATE reuse**: the engine loads plugins per workspace, so one machine can
  have several plugin instances. `probeGate` checks `/gate/version` first —
  healthy GATE is reused (`reused: true`) instead of racing for the port and
  reporting a false "not ready"; only the instance that started it disposes it.
  `/gate/version` now carries the full runtime picture (`chain_targets`,
  `agents`, `chain_for_model`, `default_chain`, `policy`, `port`).
- **Panel** (`extensions/reeve` 0.1.2): the chain editor now edits the GATE
  config (`~/.config/opencode/reeve/fallback.jsonc`) — per-chain candidate
  order, agent→chain mapping, policy, add/remove chain — and **only rewrites
  the sections it changed**, keeping hand-written comments and layout
  (`fallback-edit.js`, unit-tested; write-time self-check refuses bad JSON).
  Stats tab shows GATE attribution. New `preview/` harness renders the real
  panel against a fake host (read = real snapshot/config, write = memory by
  default) for local visual review.
- **Tests**: `test/wiring.mjs` (gate really starts / snapshot gate section /
  stats read the ledger / busy port reported / reuse / ≤5s hot reload),
  `test/runtime.mjs` (terminal-state attribution incl. wall-clock `timedOut`,
  tool-result paths, endpoint bootstrap, hydrate truncation), `test/guard.mjs`
  (static guard against Bifrost coming back), rewritten `test/stats.mjs`, plus
  classify/lanes edge cases. Coverage ratchets up: global 95.7/79.5/96.5.
- `scripts/accept-gate.sh`: real-host acceptance ①–⑨ (9router health → direct
  free call → GATE surface → engine through GATE → fault-injection downgrade →
  per-session stickiness → cooldown bookkeeping → ≤5s hot reload → paid direct
  call → **Bifrost process count = 0**). `scripts/setup-9router.mjs` installs/
  supervises 9router (pinned) **without any console window** (Windows: hidden
  spawn + logon VBS; Linux: `--unit-print`).

## 0.1.4 — 2026-10-21

- The self-hosted proxy is now **per platform**: `BIFROST_PINS` carries
  `linux-x64` (values unchanged) and `win32-x64` (Bifrost 2.3.0, downloaded and
  started live on a Windows dev machine — `/api/version` 200). `proxyPaths` /
  `ensureBinary` / `startOwnedProxy` thread the platform pin; an unpinned
  platform makes the proxy layer report itself unavailable instead of
  installing a foreign binary.
- New tests: platform pin selection and shape, pin pass-through into `spawn`
  and the binary filename, a `startOwnedProxy` smoke test (launch / reuse /
  unsupported-platform degradation), and a drift guard binding
  `provision.json`'s Bifrost artifact — plus `version`, `enginePlugin.spec` and
  `constants.js`'s `PLUGIN_VERSION` — to the package version.
- Fix: `dispose` threw whenever the chain-watch / supervisor timers were armed
  (`clearInterval` returns `undefined`, so `.catch` on it failed) — cleanup is
  best-effort per entry now, so one failing cleanup no longer skips the rest.
- Coverage ratchet in the same commit: `startOwnedProxy` now actually runs in
  tests (it previously never did, so v8 did not count its branches at all), and
  the newly-honest denominator is covered to 89% branches — the floors move to
  95/89/93 for `plugin/src/proxy.js` and 89/78/89 globally.
- No behaviour change on Linux: pin values, paths and spawn arguments are
  byte-for-byte identical to 0.1.3.

## 0.1.3 — 2026-10-20

- Open-source hygiene: English `README.md` (the Chinese original is
  `README.zh-CN.md`), `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  this changelog, issue/PR templates and Dependabot.
- Biome lint-only gate (`npm run lint`) in CI; formatting is not enforced.
- No runtime behaviour change: the plugin, agents, skills and extension are the
  same code as 0.1.2.

## 0.1.2 — 2026-10-20

- `plugin/provision.json`: the installation contract read by ocrc — plugin
  spec and directory fallback, Bifrost artifact (v2.3.0, sha256, destination),
  extension zip, and post-install verification.
- Public tree export and the `reeve-0.1.1` / `reeve-latest` extension release
  (`reeve.zip` plus the `reeve` branch for self-updating installs).
- Docs scrubbed for the public tree; any `omo` prompt literal replaced by a
  paraphrase.

## 0.1.1 — 2026-10-19

- First CI-published release with npm Trusted Publishing (OIDC) and SLSA
  provenance.
- Plugin tests grew to 135; the engine config sample gained a validation gate;
  the extension build is checked byte-for-byte against `src/`.

## 0.1.0 — 2026-10-18

- First publish (manual, bootstrap of the Trusted Publisher): plugin, agents,
  review skill, ledger/ledger gates, Bifrost proxy chain, openchamber console.
