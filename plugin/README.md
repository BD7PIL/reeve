# `@bd7pil/reeve` — REEVE orchestration for OpenCode v2

This package is the whole REEVE system for OpenCode v2: agent definitions, the
review skill, the child-task ledger with concurrency gates, wall-clock
supervision and cross-restart reconciliation, and the in-process **GATE** proxy
layer (routing, fallback chains, free lane, ledger, model catalog, stats).

There is **no binary and no separate service**. GATE is plain JavaScript inside
the plugin; Bifrost and 9router are retired.

## Requirements

- Node.js >= 22
- OpenCode v2 (tested 2.0.32 and 2.1.3)
- Provider credentials in `~/.local/share/opencode/auth.json`
- Optional panel: OpenChamber >= 2.3.3, extension `reeve` from
  `https://github.com/BD7PIL/reeve#reeve` or the `reeve-latest` zip

## Install

In `~/.config/opencode/opencode.jsonc`:

```jsonc
{
  "model": "reeve/standard",
  "plugins": ["@bd7pil/reeve"]
}
```

The plugin registers five tiers and all agents. On first start it adds
`providers.reeve` pointing at GATE (`http://127.0.0.1:18080/v1`) if missing; the
write is additive and backed up. If 8080 is occupied, pin the port explicitly:

```jsonc
{
  "model": "reeve/standard",
  "plugins": [
    { "package": "@bd7pil/reeve", "options": { "gate": { "enabled": true, "port": 18080 } } }
  ],
  "providers": {
    "reeve": {
      "package": "@ai-sdk/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:18080/v1" }
    }
  }
}
```

`model` is not optional: without it a bare `opencode run` or a fresh composer
session can use the engine default and bypass GATE.

## Tiers and agents

| Tier | Chain | Agents |
|---|---|---|
| `reeve/pro` | `reasoning` | planner, advisor, critic |
| `reeve/standard` | `standard` | executor, reviewer |
| `reeve/flash` | `free-first` | scout, librarian |
| `reeve/multimodal` | `vision` | looker (hidden, read-only, files on disk) |

`foreman` is the visible primary orchestrator; it follows the session's model
selection. 0.2.0 removed the `reeve/manual` single-target tier — pick a model
directly in the composer when you want a specific one.

All tiers declare image input. A text-first `reasoning` request containing an
image is routed to the `vision` chain for that request only; the session model
does not change. Pasted images are handled at GATE; `looker` reads file paths.

## GATE

- Chains and providers: `~/.config/opencode/reeve/fallback.jsonc` (panel-editable)
- Free lane: discovers OpenCode Zen / OpenRouter models; `free.require_image`
  filters by `modalities.input` from models.dev (6h TTL, last-good cache); if
  metadata is unavailable it falls back to paid rather than using text-only
  free models.
- Ledgers: `~/.reeve/ledger.json` (panel snapshot) and `~/.reeve/gate.jsonl`
  (request ledger, no keys).

## What the plugin adds to v2

| Gap | How it is filled |
|---|---|
| no child-task status | `reeve_task_status` (read-only) |
| silent child death | terminal gate + grace window |
| no periodic reconciliation | `session.hook("prompt")` |
| no concurrency cap | admission gate (`limits`) |
| no wall-clock timeout | supervisor with exactly-once interrupt |
| hidden subagents missing from the tool roster | roster injected into the `subagent` description |

It never writes `agents.*.model`; that key belongs to OpenChamber.

## Options

```jsonc
{
  "plugins": [
    {
      "package": "@bd7pil/reeve",
      "options": {
        "wallClockMs": 1800000,
        "abortGraceMs": 10000,
        "retentionDays": 30,
        "limits": { "default": 8, "providers": {}, "models": {} },
        "snapshotPath": "~/.reeve/ledger.json",
        "gate": { "enabled": true, "port": 18080 }
      }
    }
  ]
}
```

- `limits.default`: 0 means unlimited; an explicit value is recommended.
- `snapshotPath`: read-only projection for the panel; writing it is optional.
- `gate.enabled: false` disables the proxy layer (you then own the endpoint).

## Tests

From the repository root:

```bash
npm --prefix plugin test
npm run test:coverage
```

The suite covers routing, attempts/cooldown, error classification, free-lane
discovery/expansion, config hot reload, image routing, concurrency, ledger,
reconciliation, snapshot, stats, endpoint bootstrap, and the extension bridge.
CI runs it on Ubuntu 22/24 and Windows 24.

## License

MIT. See `LICENSE` in this package and the repository's `NOTICE.md` for
third-party material. No `oh-my-openagent` (SUL-1.0) code or prompt literal is
included.
