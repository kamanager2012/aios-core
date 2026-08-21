# Shadow Evals

This directory incubates reliability/evaluation corpora before they become a stable public project surface.

It is intentionally outside the npm package (`package.json#files`) and outside the runtime state machine.

## Rules

1. **Corpus is data, not enforcement.** Import scenarios, expected outcomes, provenance and known failures; do not import another runtime or agent loop.
2. **Raw imports are immutable snapshots.** Preserve source semantics and pin the source repository revision.
3. **Normalization is vendor-neutral.** A case describes input + expected result. Vendor/agent adapters produce observations separately.
4. **No benchmark laundering.** Known false positives, bypasses and failures remain visible after migration.
5. **Regression first.** A new agent/model/policy version is compared against the same case IDs; PASS→FAIL is a regression regardless of vendor.

Current corpus:

- `policy/acs-v1/` — Agent Constraint System safety benchmark migrated as a provenance-pinned policy-eval source.

The canonical result evaluator is `kernel/eval.ts`.
