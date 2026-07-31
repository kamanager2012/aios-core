# AIOS Core

> Project Agent Runtime — keeping an AI agent developing a project steadily, long-term.

> **Part of the [Agent Governance Stack](https://github.com/kamanager2012/agent-constraint-system)** — the execution-kernel layer above
> [ACS](https://github.com/kamanager2012/agent-constraint-system) (command-level execution gate) and
> [governor-core](https://github.com/kamanager2012/governor-core) (call-level policy engine).

AIOS Core is a **single-agent software engineering execution kernel** that uses
project state to drive an agent's development behavior.

Not an operating system. Not a platform. Not a multi-agent orchestrator.

## Core Idea

```
Plan first. Approve next. Then execute. Finally verify and persist.
```

- **Project-state-driven** — the agent is driven by project facts and decisions, not by context
- **Single agent** — only one executing entity at any time
- **Rollback-capable** — every write operation ships with a rollback path
- **Project memory is the core** — persists project facts and decisions; no chats, no model thoughts, no vectors

## Architecture

```
aios-core/
├── kernel/       # Execution kernel: planner + executor + verifier + reconciler + runtime + schema
├── memory/       # Project memory: current/ tasks/ decisions/ architecture/ incidents/ staging/
├── governor/     # Governance guardrails: scope + approval + rollback + audit
├── cli/          # Entry points: aios run | plan | status | context | replay
└── tests/        # 244 tests (25 files) + shadow/ real-I/O E2E
```

### State machine

```
IDLE → PLAN → EXECUTE → VERIFY → COMMIT → DONE
                                     │
                                     │ failure
                                     ▼
                                 ROLLBACK → DONE
```

### Core modules

| Module | Responsibility |
|--------|----------------|
| `kernel/runtime.ts` | Sole state-machine driver (SSOT) |
| `kernel/planner.ts` | Task understanding + plan generation |
| `kernel/executor.ts` | Edit code, run commands, produce diffs |
| `kernel/verifier.ts` | Verify execution results |
| `kernel/reconciler.ts` | Pure-function decision exit (no model calls, no IO) |
| `kernel/invariant.ts` | State invariant checks |
| `kernel/failure.ts` | Failure classification (transient/deterministic/permission/corruption/resource) |
| `kernel/statehash.ts` | Execution fingerprint + hash chain (verifiable determinism) |
| `governor/scope.ts` | Path/command/file-type allow & deny lists |
| `governor/approval.ts` | AUTO/MANUAL two-level approval |
| `governor/rollback.ts` | git restore / git revert / snapshot rollback |
| `governor/audit.ts` | Append-only audit log |
| `governor/limits.ts` | Termination conditions (maxTurns, maxContext, maxRetries) |
| `memory/index.ts` | Project memory store (append-only + overridable `current`) |
| `memory/context.ts` | Context window management |

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

# Step by step (only plan/run implemented; execute/verify/commit not yet)
aios plan "fix login bug" --project myapp

# View status
aios status

# Replay
aios replay --last
aios replay --task task_042
```

## Tests

```bash
npm test          # 244 tests (25 files)
npm run typecheck # TypeScript type check
```

## Project memory

Only COMMIT writes formal memory:

| Directory | Mutability | Write timing |
|-----------|-----------|--------------|
| `current/` | **the only overridable one** | state progression |
| `decisions/` | append-only | decision made |
| `tasks/` | append-only | task completed |
| `incidents/` | append-only | failure postmortem |

## Design constraints

- The reconciler is the **sole** decision exit — pure function, no model calls, no IO
- Governor is a guardrail, not an engine — it blocks what should not be done, but does not drive what should
- staging/snapshot isolate in-flight state; only COMMIT promotes to formal memory
- 50-task shadow tests verify determinism: same input → same output

## What it does not do

❌ Multi-agent / Mesh / workflow orchestration
❌ Vector DB / knowledge graph / personality memory
❌ Budget / cost tracking / economy systems
❌ Auto-evolution / cloud scheduling

It only does: project memory, execution, governance, recovery.

## License

MIT — see [LICENSE](LICENSE).

---

[中文文档](./README.zh-CN.md)
