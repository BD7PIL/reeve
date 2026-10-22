## What does this change?

<!-- One paragraph: the failure or gap, and how this closes it. -->

## Checklist

- [ ] `npm --prefix plugin test` passes (Node 22 and 24).
- [ ] `node scripts/check-plugin-pack.mjs` passes.
- [ ] `node extensions/reeve/check.mjs` and the extension build pass; the
      committed `panel/` matches `src/`.
- [ ] No `agents.*.model` / `plugins` write was added to the plugin.
- [ ] No second write path was added to the extension.
- [ ] No `oh-my-openagent` code or prompt literal was introduced.
- [ ] Docs updated where they would otherwise become false.

## Related issues

<!-- Fixes #… -->
