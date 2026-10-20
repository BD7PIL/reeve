# Changelog

Newest first. Versions follow the plugin package (`plugin/package.json`); the
panel extension has its own tags (`reeve-<version>`).

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
