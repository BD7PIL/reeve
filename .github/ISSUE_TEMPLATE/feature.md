---
name: Feature request
about: Propose a change to REEVE
labels: enhancement
---

## The problem

<!-- What fails or costs you time today? Concrete sessions/examples help. -->

## Proposed behaviour

<!-- What should happen instead. If it changes a boundary (config writes,
agent model ownership, the extension's single write path), say so explicitly. -->

## Boundary check

- [ ] This does not require the plugin to write `agents.*.model` or the
      `plugins` array.
- [ ] This does not add a second write path to the extension.
- [ ] This introduces no code or prompt literal from `oh-my-openagent`
      (SUL-1.0).
- [ ] This can be tested offline, without a real provider.

## Alternatives considered

<!-- Including "do nothing" and why that is insufficient. -->
