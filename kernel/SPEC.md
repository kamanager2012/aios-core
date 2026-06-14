# AIOS Core — Formal Execution Model v1.0

## State Derivation Spec

The core invariant of the system:

```
state = f(audit_log[0..n])
```

For any point `n` in the audit log, the complete runtime state can be
deterministically reconstructed by replaying entries 0..n.

### State Derivation Rules

| Audit Entry Phase | State Mutation |
|---|---|
| PLAN | `state.plan = entry.plan; state.plan.frozen = true` |
| EXECUTE | `state.execResult = entry.execResult` |
| VERIFY | `state.verifyReport = entry.verifyReport` |
| COMMIT | `state.decision = "COMMIT"; state.memoryCommitted = true` |
| ROLLBACK | `state.decision = "ROLLBACK"; state.memoryRolledBack = true` |
| DONE | `state.terminal = true` |

### Invariants (must hold at every transition)

1. **COMMIT_AFTER_VERIFY_PASS** — COMMIT requires verifyReport.status = "pass"
2. **ROLLBACK_CLEARS_STAGING** — ROLLBACK sets memoryRolledBack = true
3. **DECISION_FROM_RECONCILER** — Terminal decisions come from reconciler (except scope/approval rejections)
4. **TERMINAL_NO_FURTHER_TRANSITIONS** — Terminal states don't have non-terminal transitions after them
5. **PLAN_FROZEN_AFTER_PLAN** — Plan is frozen before EXECUTE
6. **EXECUTE_REQUIRES_PLAN** — EXECUTE requires plan != null

### Hash Chain

Each audit entry produces a chained fingerprint:

```
fp[0] = H("genesis" | canonical(entry[0]))
fp[n] = H(fp[n-1].hash | canonical(entry[n]))
```

Chain verification: recompute each fp[n] and verify prevHash linkage.

### Failure Classification

Every failure is classified into one of 7 categories:

| Category | Recoverable | Max Retries | Example |
|---|---|---|---|
| transient | yes | 3 | ETIMEDOUT, rate limit |
| deterministic | no | 0 | build failure, logic bug |
| permission | no | 0 | scope rejection, approval denied |
| corruption | no | 0 | checksum mismatch, invariant violation |
| partial_success | yes | 1 | some tests pass, some fail |
| resource | no | 0 | limits exceeded |
| unknown | no | 0 | unclassified |

Recovery decision: `shouldRetry(failure, attempts) = failure.recoverable && attempts < failure.maxRetries`

### Execution Tiers

| Tier | Name | IO Permitted | Commit |
|---|---|---|---|
| 0 | dry-run | none | no |
| 1 | shadow | read + staging | no |
| 2 | production | full | yes |

### Schema Versioning

Every audit entry carries `_v` field (current: 1).
Backward compatibility: replay engine auto-upgrades entries via `upgradeEntry()`.
Forward compatibility: entries with `_v > CURRENT_SCHEMA_VERSION` are rejected.
