# Security policy

## Scope

REEVE has two parts with different trust boundaries:

- **`plugin/`** runs inside the opencode v2 engine process. It registers tools
  and hooks, reads the engine config, `~/.reeve/`, and the GATE config
  (`~/.config/opencode/reeve/fallback.jsonc`), writes the orchestration ledger
  and the GATE request ledger (`~/.reeve/gate.jsonl` — which holds key *names*,
  never key values), and opens exactly one listener: the loopback GATE endpoint
  the engine talks to. Its admin routes (`/gate/session*`) are loopback-only.
  Provider API keys stay in the engine's own `auth.json`; REEVE reads them for
  the configured providers and never copies them anywhere.
- **`extensions/reeve/`** is an openchamber guest panel. It runs in a sandboxed
  frame with the host's `readFile` / `writeFile` bridge and writes exactly one
  path, the GATE fallback config. It never starts sessions, prompts, or edits
  the engine config.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability
reporting on the repository (`Security` tab → `Report a vulnerability`) or
contact the maintainer (`@BD7PIL`) directly. Include:

- affected version (`plugin/package.json` or the extension tag),
- the smallest configuration and steps that reproduce it,
- what an attacker gains (config write, tool execution, credential exposure),
- whether the engine config, the ledger, or the GATE config is affected.

You can expect an acknowledgement within a few days. Confirmed issues are
fixed in a patch release and credited unless you ask otherwise.

## Hard rules for contributors

- The plugin must never write `agents.*.model` or the `plugins` array. Model
  ownership belongs to the user / openchamber.
- The extension has exactly one write path: `chainPathFor(…)`. `check.mjs`
  enforces this statically; do not weaken the gate.
- No secret may be written into a tracked file. Provider keys belong in the
  engine's own credential store.
- **No code or prompt literal from `oh-my-openagent` may ever be introduced**
  (SUL-1.0, non-relicensable). Ideas may be re-expressed; text may not be
  copied. See `NOTICE.md` and `docs/PLAN.md`.
- Remote/CI runs must not contact a real provider; all tests are offline.
