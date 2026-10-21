# Changelog

Newest first. Versions follow the plugin package (`plugin/package.json`); the
panel extension has its own tags (`reeve-<version>`).

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
