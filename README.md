# AIOS Core

> Agent Reliability Kernel — task contracts, evidence gates, deterministic verification, replay, and rollback for coding agents.

AIOS Core is being converged from the former three-layer **Agent Governance Stack** into one canonical reliability project. The goal is not to build another agent loop, sandbox, or model router. The goal is to verify whether an agent actually completed a software-engineering task under explicit acceptance conditions, and to make regressions measurable across agent/model versions.

Project overview: [Kama Projects](https://kamanager2012.github.io/).

## Core idea

```text
Task Contract
    ↓
PLAN → EXECUTE → VERIFY
                  ↓
             Evidence Gate
              ↙        ↘
          COMMIT      ROLLBACK
              ↓
        Replay / Regression
```

A stronger model does not remove the need for verification. It changes what should be verified. AIOS therefore focuses on **task outcome evidence**, not on replacing native agent security controls.

## Reliability contract

A contract defines the minimum evidence required before a task can be accepted:

```ts
const contract = {
  version: 1,
  requiredEvidence: ["test", "build", "diff"],
  acceptance: {
    minTestsPassed: 20,
  },
};
```

The verifier emits structured evidence for build, tests, lint, E2E and diff. The reliability gate produces one of three verdicts:

- `PASS` — all required evidence exists and satisfies the contract.
- `FAIL` — required evidence exists but fails acceptance.
- `INCOMPLETE` — required evidence is missing; the task must not be treated as complete.

Legacy tasks without a contract retain the existing verify-pass behavior.

## Architecture

```text
aios-core/
├── kernel/
│   ├── runtime.ts       # sole state-machine driver (SSOT)
│   ├── planner.ts       # task → frozen plan
│   ├── executor.ts      # execution adapter boundary
│   ├── verifier.ts      # structured verification evidence
│   ├── reliability.ts   # evidence gate + regression comparison (pure)
│   ├── reconciler.ts    # sole deterministic COMMIT/ROLLBACK decision exit
│   ├── replay.ts        # deterministic audit replay
│   ├── invariant.ts     # state invariants
│   ├── failure.ts       # failure taxonomy
│   └── statehash.ts     # execution fingerprint + hash chain
├── governor/            # scope, approval, rollback, audit, limits
├── memory/              # project-state memory and staging
├── cli/
└── tests/
```

### Frozen state machine

```text
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                         │
                         └──────→ ROLLBACK → DONE
```

The reliability work does **not** add states to this machine. Evidence is evaluated inside the existing VERIFY → decision boundary.

## Regression comparison

`kernel/reliability.ts` also compares reliability runs by `taskId` across agent/model versions and reports:

- regressions (`PASS → INCOMPLETE/FAIL`, `INCOMPLETE → FAIL`)
- improvements (`FAIL/INCOMPLETE → PASS`, `FAIL → INCOMPLETE`)
- unchanged tasks
- tasks missing from the candidate run
- tasks newly added to the candidate run

This is the foundation for project-specific **Agent CI** rather than another generic benchmark leaderboard.

## Convergence of the former stack

The existing repositories are not being mechanically copied into this repository.

| Existing project | What should survive here |
|---|---|
| `agent-constraint-system` | benchmark scenarios, known bypasses/false positives, constraint taxonomy, adapter evidence |
| `governor-core` | canonical policy semantics, validation/normalization, audit semantics |
| `aios-core` | execution state machine, verification, invariants, failure recovery, replay, rollback, project-state memory |

Native Codex/Claude/Gemini/other runtime security features should be used where available instead of rebuilding a second sandbox or permission engine.

## Install

```bash
git clone https://github.com/kamanager2012/aios-core.git
cd aios-core
npm install
```

## Usage

```bash
# Full pipeline
aios run "fix login bug" --project myapp

# Plan
aios plan "fix login bug" --project myapp

# Status
aios status

# Replay
aios replay --last
aios replay --task task_042
```

The CLI remains backward compatible; task-contract wiring is currently exposed at the kernel API level while CLI ergonomics are refined.

## Checks

```bash
npm run check
```

`check` runs the architecture guard, TypeScript type checking, and the full Vitest suite.

## Design constraints

- Runtime is the only state-machine driver.
- Reconciler is the sole decision exit and remains a pure function with no model calls or IO.
- A task contract may make acceptance stricter; it may never bypass existing verification failures.
- Missing required evidence is not success.
- Project memory stores project facts/decisions, not chats, model thoughts, or vector memory.
- Staging/snapshot isolate in-flight state; only COMMIT promotes state.
- Audit/replay remain deterministic and independently verifiable.

## Non-goals

AIOS Core does **not** aim to become:

- a new general-purpose agent loop
- a multi-agent mesh/orchestrator
- a replacement sandbox or network isolation layer
- a model router
- a vector-memory/personality system
- a cloud scheduler or autonomous economy

The target is narrower: **reliable execution acceptance and regression evidence for real coding-agent work.**

## License

MIT — see [LICENSE](LICENSE).

---

[中文文档](./README.zh-CN.md)
