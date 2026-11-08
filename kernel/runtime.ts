// AIOS Core — Runtime loop (SSOT).
//
// Runtime is the ONLY state machine driver.
// Invariant checks run at every state transition after state is mutated.
// Violations are fatal in strict mode (default).

import type {
  Plan, TaskRequest, ExecutionResult, VerificationReport,
  ProjectState, Phase, Decision, MemoryUpdate, ExecutionTier,
  FailureRecord,
  RuntimeState, PhaseTransition, 
} from "./schema/index.js";
import type { ReconciliationInput, ReconciliationOutput } from "./reconciler.js";
import { reconcile } from "./reconciler.js";
import type { PlannerFn } from "./planner.js";
import type { ExecutorFn } from "./executor.js";
import type { VerifierFn } from "./verifier.js";
import { ScopeValidator } from "../governor/scope.js";
import { effectiveApproval } from "../governor/approval.js";
import { checkLimits, DEFAULT_LIMITS, type Limits } from "../governor/limits.js";
import type { MemoryStore } from "../memory/index.js";
import { Rollback } from "../governor/rollback.js";
import { AuditLog } from "../governor/audit.js";
import { checkInvariants, type InvariantViolation } from "./invariant.js";
import type { AuditEntry } from "../governor/audit.js";
import { classifyFailure, shouldRetry } from "./failure.js";
import { computeFingerprint, HashChain, verifyChain } from "./statehash.js";

// Re-export types moved to schema for backward compatibility
export type { RuntimeState, PhaseTransition, InvariantViolation } from "./schema/index.js";


export interface RuntimeDeps {
  planner: PlannerFn;
  executor: ExecutorFn;
  verifier: VerifierFn;
  scope: ScopeValidator;
  memory: MemoryStore;
  rollback: Rollback;
  audit: AuditLog;
  limits?: Limits;
  tier?: ExecutionTier;
  now: () => string;
  newId: () => string;
  askHuman?: (plan: Plan) => Promise<boolean>;
  readProjectState: (project: string) => Promise<ProjectState>;
  maxRetries?: number;
  maxAutoFix?: number;
  autoFixFn?: () => Promise<boolean>;
  strictInvariants?: boolean;
  hashChain?: HashChain;
  strictHashChain?: boolean;
}





async function auditAppend(deps: RuntimeDeps, entry: AuditEntry): Promise<void> {
  await deps.audit.append(entry);
  if (deps.hashChain) {
    const latest = deps.audit.all()[deps.audit.all().length - 1];
    if (latest) {
      const fp = await deps.hashChain.append(latest);

      // Runtime gate: verify chain integrity after each append
      // In strict mode (default), a broken chain is fatal
      if (deps.strictHashChain !== false) {
        const chain = deps.hashChain.getChain();
        const allEntries = deps.audit.all();
        const verification = await verifyChain(chain, allEntries);
        if (!verification.valid) {
          throw new Error(`Hash chain verification failed at seq=${fp.seq}: ${verification.message}`);
        }
      }
    }
  }
}

async function guardInvariants(
  state: RuntimeState,
  transition: PhaseTransition | undefined,
  deps: RuntimeDeps,
): Promise<void> {
  const result = checkInvariants(state, transition);
  if (result.ok) return;

  state.invariantViolations.push(...result.violations);

  for (const v of result.violations) {
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "INVARIANT_VIOLATION",
      execution: `${v.invariant}: ${v.message}`,
    });
  }

  if (deps.strictInvariants !== false) {
    throw new Error(`Invariant violation: ${result.violations[0]!.invariant} — ${result.violations[0]!.message}`);
  }
}

// ── Plan command gate (B2) ────────────────────────────────────────────
// Plans carry free-text steps + a rollback string (copied verbatim from
// model output). Runtime must run the same 4 signals the policy eval
// harness combines (see tests/governor/canonical_policy_hardening.test.ts):
// validateCommand / isMassDelete / commandTargetsDeniedPath /
// usesElevatedCommand. Generic non-shell steps ("edit src/a.ts") are
// deliberately skipped so existing plans are not treated as shell.

function collectPlanCommands(plan: Plan): string[] {
  const cmds: string[] = [];
  if (plan.rollback?.trim()) cmds.push(plan.rollback);
  for (const step of plan.steps) {
    if (step.action?.trim()) cmds.push(step.action);
    if (step.action?.trim() && step.target?.trim()) cmds.push(`${step.action} ${step.target}`);
    if (step.target?.trim() && step.target.trim() !== step.action?.trim()) cmds.push(step.target);
  }
  return cmds;
}

function isShellLike(scope: ScopeValidator, candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!trimmed) return false;
  if (/[;|&$><`\n\r]/.test(trimmed)) return true;
  if (scope.isMassDelete(trimmed)) return true;
  const head = trimmed.split(/\s+/)[0] ?? "";
  if (!head) return false;
  const dangerous = new Set([
    "rm", "sudo", "shred", "find", "dd", "sh", "bash", "zsh", "curl", "wget",
    "shutdown", "reboot", "mkfs", "chmod", "chown",
  ]);
  if (dangerous.has(head)) return true;
  if (scope.policy.allowedCommands.some((p) => head === p || p === head)) return true;
  if (scope.policy.deniedCommands.some((p) => p.split(/\s+/)[0] === head)) return true;
  if ((scope.policy.elevatedCommands ?? []).some((p) => head === p)) return true;
  return false;
}

function isPathLikeTarget(target: string): boolean {
  const t = target.trim();
  if (!t || /\s/.test(t)) return false;
  if (t.startsWith("(") || t.startsWith("/staging")) return false;
  if (/[;|&$><`\n\r]/.test(t)) return false;
  // Plain relative paths (with or without extension) vs verbs like "edit".
  return t.includes("/") || /\.[a-z0-9]{1,10}$/i.test(t);
}

export interface PlanCommandCheck {
  ok: boolean;
  reason?: string;
  elevated: boolean;
}

export function checkPlanCommands(scope: ScopeValidator, plan: Plan): PlanCommandCheck {
  let elevated = false;
  for (const candidate of collectPlanCommands(plan)) {
    if (!isShellLike(scope, candidate)) continue;
    if (scope.isMassDelete(candidate)) {
      return { ok: false, reason: `mass-delete command blocked: ${candidate.slice(0, 120)}`, elevated };
    }
    if (scope.commandTargetsDeniedPath(candidate)) {
      return { ok: false, reason: `command write target denied: ${candidate.slice(0, 120)}`, elevated };
    }
    if (!scope.validateCommand(candidate)) {
      return { ok: false, reason: `command not allowed by scope policy: ${candidate.slice(0, 120)}`, elevated };
    }
    if (scope.usesElevatedCommand(candidate)) elevated = true;
  }
  for (const step of plan.steps) {
    const t = (step.target ?? "").trim();
    if (isPathLikeTarget(t) && !scope.validatePath(t)) {
      return { ok: false, reason: `step target denied by scope policy: ${t.slice(0, 120)}`, elevated };
    }
  }
  return { ok: true, elevated };
}

function planFiles(state: RuntimeState): string[] {
  return state.plan?.files ?? [];
}

export async function runTask(
  request: TaskRequest,
  deps: RuntimeDeps,
): Promise<RuntimeState> {
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const maxRetries = deps.maxRetries ?? DEFAULT_LIMITS.maxRetries;
  if (!Number.isInteger(maxRetries) || maxRetries < 1) {
    throw new Error(`maxRetries must be an integer >= 1 (got ${String(maxRetries)})`);
  }
  const maxAutoFix = deps.maxAutoFix ?? 3;
  if (!Number.isInteger(maxAutoFix) || maxAutoFix < 0) {
    throw new Error(`maxAutoFix must be an integer >= 0 (got ${String(maxAutoFix)})`);
  }

  const state: RuntimeState = {
    taskId: deps.newId(),
    request,
    transitions: [],
    plan: null,
    execResult: null,
    verifyReport: null,
    decision: null,
    memoryUpdate: null,
    memoryCommitted: false,
    memoryRolledBack: false,
    terminal: false,
    reason: "",
    limitsUsed: { turns: 0, context: 0, retries: 0 },
    totalRetries: 0,
    totalAutoFixAttempts: 0,
    invariantViolations: [],
    failureRecord: null,
    hashChainLength: 0,
  };

  const projectState = await deps.readProjectState(request.project);

  // ── IDLE → PLAN ──────────────────────────────────────────────────────
  const t1: PhaseTransition = { from: "IDLE", to: "PLAN", taskId: state.taskId };
  state.transitions.push(t1);
  state.plan = await deps.planner(request);
  state.plan.frozen = true;
  state.limitsUsed.turns++;
  state.limitsUsed.context += estimateContext(request, projectState);
  await guardInvariants(state, t1, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "PLAN",
    fromPhase: "IDLE", toPhase: "PLAN",
    input: request.goal, plan: state.plan,
    limitsUsed: { ...state.limitsUsed },
  });

  const limitCheck = checkLimits(limits, state.limitsUsed);
  if (!limitCheck.ok) {
    state.terminal = true;
    state.reason = limitCheck.reason ?? "limits exceeded";
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "IDLE",
      result: "limits exceeded", limitsUsed: { ...state.limitsUsed },
    });
    return state;
  }

  // ── Scope check ──────────────────────────────────────────────────────
  if (!deps.scope.validatePlan(state.plan)) {
    state.decision = "ROLLBACK";
    state.terminal = true;
    state.reason = "plan rejected by scope";
    state.failureRecord = classifyFailure({
      phase: "PLAN", scopeRejected: true, taskId: state.taskId, at: deps.now(),
    });
    const ts: PhaseTransition = { from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "scope rejected" };
    state.transitions.push(ts);
    state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
    await applyRollback(state, deps, "plan rejected by scope");
    await guardInvariants(state, ts, deps);
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
      fromPhase: "PLAN", toPhase: "ROLLBACK",
      decision: "ROLLBACK", result: "scope rejected",
    });
    return state;
  }

  // ── Plan command gate (steps/rollback vs scope) ─────────────────────
  const commandCheck = checkPlanCommands(deps.scope, state.plan);
  if (!commandCheck.ok) {
    state.decision = "ROLLBACK";
    state.terminal = true;
    state.reason = commandCheck.reason ?? "plan command rejected by scope";
    state.failureRecord = classifyFailure({
      phase: "PLAN", scopeRejected: true, taskId: state.taskId, at: deps.now(),
    });
    const ts: PhaseTransition = { from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: state.reason };
    state.transitions.push(ts);
    state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
    await applyRollback(state, deps, state.reason);
    await guardInvariants(state, ts, deps);
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
      fromPhase: "PLAN", toPhase: "ROLLBACK",
      decision: "ROLLBACK", result: state.reason,
    });
    return state;
  }

  // ── Approval gate ────────────────────────────────────────────────────
  // Protected-path plans are forced to MANUAL even when the model wrote
  // AUTO (effectiveApproval). Elevated commands likewise force MANUAL.
  const effectiveLevel = commandCheck.elevated
    ? "MANUAL" as const
    : effectiveApproval(state.plan);
  if (effectiveLevel === "MANUAL") {
    const humanOk = await deps.askHuman?.(state.plan);
    if (humanOk !== true) {
      state.decision = "ROLLBACK";
      state.terminal = true;
      state.reason = "manual approval denied";
      state.failureRecord = classifyFailure({
        phase: "PLAN", approvalDenied: true, taskId: state.taskId, at: deps.now(),
      });
      state.transitions.push({ from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "approval denied" });
      state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
      await applyRollback(state, deps, "manual approval denied");
      await guardInvariants(state, { from: "PLAN", to: "ROLLBACK", taskId: state.taskId, note: "approval denied" }, deps);
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
        fromPhase: "PLAN", toPhase: "ROLLBACK",
        decision: "ROLLBACK", result: "manual approval denied",
      });
      return state;
    }
  }

  // ── PLAN → EXECUTE ──────────────────────────────────────────────────
  const t2: PhaseTransition = { from: "PLAN", to: "EXECUTE", taskId: state.taskId };
  state.transitions.push(t2);
  await guardInvariants(state, t2, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
    fromPhase: "PLAN", toPhase: "EXECUTE", plan: state.plan,
  });

  let execResult: ExecutionResult;
  let attempt = 0;

  while (attempt < maxRetries) {
    attempt++;
    execResult = await deps.executor(state.plan, "/staging");
    execResult.attempt = attempt;
    if (execResult.status === "succeeded") break;

    // Classify failure to determine recovery strategy
    const failure = classifyFailure({
      phase: "EXECUTE",
      ...(execResult.error ? { error: execResult.error } : {}),
      execFailed: true,
      taskId: state.taskId,
      at: deps.now(),
    });
    state.failureRecord = failure;

    if (!shouldRetry(failure, attempt - 1)) {
      // Non-recoverable failure — stop retrying
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
        execution: `attempt ${attempt} failed (${failure.category}, not recoverable): ${execResult.error}`,
        execResult, attempt, limitsUsed: { ...state.limitsUsed },
      });
      break;
    }

    state.totalRetries++;
    state.limitsUsed.retries++;
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
      execution: `attempt ${attempt} failed (${failure.category}, retrying): ${execResult.error}`,
      execResult, attempt, limitsUsed: { ...state.limitsUsed },
    });

    const limitCheckExec = checkLimits(limits, state.limitsUsed);
    if (!limitCheckExec.ok) {
      state.terminal = true;
      state.reason = limitCheckExec.reason ?? "limits exceeded during execution";
      state.failureRecord = classifyFailure({
        phase: "EXECUTE", limitsExceeded: true, taskId: state.taskId, at: deps.now(),
      });
      await auditAppend(deps, {
        at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
        fromPhase: "EXECUTE", toPhase: "ROLLBACK",
        result: "limits exceeded during execution",
        execResult, limitsUsed: { ...state.limitsUsed },
      });
      await deps.rollback.restore(planFiles(state));
      await deps.memory.clearStagingTask(state.taskId);
      state.memoryRolledBack = true;
      state.execResult = execResult;
      return state;
    }
  }

  state.execResult = execResult!;
  state.limitsUsed.turns++;
  await deps.memory.writeToStaging(`${state.taskId}/diff`, state.execResult.diff);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "EXECUTE",
    execution: `completed after ${attempt} attempt(s)`,
    execResult: state.execResult, attempt, limitsUsed: { ...state.limitsUsed },
  });

  // ── EXECUTE → VERIFY ────────────────────────────────────────────────
  const t3: PhaseTransition = { from: "EXECUTE", to: "VERIFY", taskId: state.taskId };
  state.transitions.push(t3);

  if (state.execResult.status === "failed") {
    state.verifyReport = {
      planId: state.execResult.planId, status: "fail",
      testsRun: 0, testsPassed: 0, testsFailed: 0,
      logSummary: "executor reported failure", autoFixAttempts: 0,
    };
  } else {
    let verifyReport = await deps.verifier(state.execResult);
    let autoFixAttempts = 0;
    while (verifyReport.status === "fail" && autoFixAttempts < maxAutoFix && deps.autoFixFn) {
      const fixed = await deps.autoFixFn();
      autoFixAttempts++;
      state.totalAutoFixAttempts++;
      if (!fixed) break;
      verifyReport = await deps.verifier(state.execResult);
      verifyReport.autoFixAttempts = autoFixAttempts;
    }
    state.verifyReport = verifyReport;
  }

  state.limitsUsed.turns++;
  await guardInvariants(state, t3, deps);
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "VERIFY",
    fromPhase: "EXECUTE", toPhase: "VERIFY",
    execution: `pass=${state.verifyReport.testsPassed} fail=${state.verifyReport.testsFailed}`,
    verifyReport: state.verifyReport, autoFixAttempts: state.totalAutoFixAttempts,
    limitsUsed: { ...state.limitsUsed },
  });

  // ── VERIFY → COMMIT or ROLLBACK ──────────────────────────────────────
  const reconInput: ReconciliationInput = {
    plan: state.plan, executeResult: state.execResult,
    verifyReport: state.verifyReport, projectState, now: deps.now(),
  };
  const recon = reconcile(reconInput);
  state.decision = recon.decision;
  state.memoryUpdate = recon.memoryUpdate;
  state.reason = recon.reason;

  if (recon.decision === "COMMIT") {
    await applyCommit(state, deps, projectState, recon);
  } else {
    await applyRollbackFromReconciler(state, deps, recon);
  }

  // Compute final state fingerprint from hash chain
  if (deps.hashChain) {
    const latest = deps.hashChain.latest();
    if (latest) {
      state.lastFingerprint = latest.hash;
      state.hashChainLength = deps.hashChain.count();
    }
  } else {
    const allEntries = deps.audit.all();
    const fp = await computeFingerprint(allEntries, allEntries.length);
    if (fp) state.lastFingerprint = fp.hash;
  }

  return state;
}

async function applyCommit(
  state: RuntimeState,
  deps: RuntimeDeps,
  projectState: ProjectState,
  recon: ReconciliationOutput,
): Promise<void> {
  const t: PhaseTransition = { from: "VERIFY", to: "COMMIT", taskId: state.taskId };
  state.transitions.push(t);

  // Tier 0/1: reconciler COMMIT is a would-commit. Never promote memory.
  // Undefined tier defaults to 2 (production) for backward compatibility.
  const tier = deps.tier ?? 2;
  if (tier < 2) {
    state.memoryCommitted = false;
    state.reason = `${recon.reason} (tier ${tier}: memory not promoted)`;
    await guardInvariants(state, t, deps);
    state.transitions.push({ from: "COMMIT", to: "DONE", taskId: state.taskId });
    state.terminal = true;
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "COMMIT",
      fromPhase: "VERIFY", toPhase: "COMMIT",
      decision: "COMMIT", result: `tier ${tier} would-commit (memory not promoted)`,
      limitsUsed: { ...state.limitsUsed },
    });
    return;
  }

  // Atomic promotion: any throw mid-promote becomes a ROLLBACK with
  // file restore + snapshot restore attempt, never half-promoted memory.
  let commitResult: { promoted: string[]; snapshotId: string } | null = null;
  try {
    commitResult = await deps.memory.commitStaging(state.taskId, deps.now);
    state.memoryCommitted = true;

    const taskUpdate = recon.memoryUpdate.appendTask;
    const decisionUpdate = recon.memoryUpdate.appendDecision;

    if (taskUpdate) {
      await deps.memory.appendTask({
        taskId: taskUpdate.taskId ?? state.taskId,
        status: taskUpdate.status, decision: taskUpdate.decision, at: taskUpdate.at,
      });
    }
    if (decisionUpdate) {
      await deps.memory.appendDecision({
        id: decisionUpdate.id ?? deps.newId(),
        decision: decisionUpdate.decision, reason: decisionUpdate.reason, at: decisionUpdate.at,
      });
    }
    if (recon.memoryUpdate.current) {
      await deps.memory.writeToCurrent("project_state.json", JSON.stringify({
        ...projectState, ...recon.memoryUpdate.current,
      }, null, 2));
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.memoryCommitted = false;
    state.decision = "ROLLBACK";
    state.reason = `commit failed: ${msg}`;
    if (commitResult?.snapshotId) {
      try { await deps.rollback.fromSnapshot(commitResult.snapshotId); } catch {}
    }
    try { await deps.rollback.restore(planFiles(state)); } catch {}
    try { await deps.memory.clearStagingTask(state.taskId); } catch {}
    state.memoryRolledBack = true;
    try {
      await deps.memory.appendIncident({ id: deps.newId(), taskId: state.taskId, reason: state.reason, at: deps.now() });
    } catch {}
    state.transitions.push({ from: "COMMIT", to: "ROLLBACK", taskId: state.taskId, note: state.reason });
    state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
    state.terminal = true;
    await auditAppend(deps, {
      at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
      fromPhase: "VERIFY", toPhase: "ROLLBACK",
      decision: "ROLLBACK", result: state.reason, limitsUsed: { ...state.limitsUsed },
    });
    return;
  }

  await guardInvariants(state, t, deps);

  state.transitions.push({ from: "COMMIT", to: "DONE", taskId: state.taskId });
  state.terminal = true;
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "COMMIT",
    fromPhase: "VERIFY", toPhase: "COMMIT",
    decision: "COMMIT", result: "committed",
    snapshotId: commitResult!.snapshotId, limitsUsed: { ...state.limitsUsed },
  });
}

async function applyRollback(
  state: RuntimeState,
  deps: RuntimeDeps,
  reason: string,
): Promise<void> {
  await deps.rollback.restore(planFiles(state));
  await deps.memory.clearStagingTask(state.taskId);
  state.memoryRolledBack = true;
  await deps.memory.appendIncident({ id: deps.newId(), taskId: state.taskId, reason, at: deps.now() });
}

async function applyRollbackFromReconciler(
  state: RuntimeState,
  deps: RuntimeDeps,
  recon: ReconciliationOutput,
): Promise<void> {
  state.failureRecord = classifyFailure({
    phase: "VERIFY",
    error: recon.reason,
    execFailed: state.execResult?.status === "failed",
    verifyFailed: state.verifyReport?.status === "fail",
    taskId: state.taskId,
    at: deps.now(),
  });
  const t: PhaseTransition = { from: "VERIFY", to: "ROLLBACK", taskId: state.taskId, note: recon.reason };
  state.transitions.push(t);

  await deps.rollback.restore(planFiles(state));
  await deps.memory.clearStagingTask(state.taskId);
  state.memoryRolledBack = true;

  const incidentUpdate = recon.memoryUpdate.appendIncident;
  if (incidentUpdate) {
    await deps.memory.appendIncident({
      id: incidentUpdate.id ?? deps.newId(),
      taskId: incidentUpdate.taskId ?? state.taskId,
      reason: incidentUpdate.reason, at: incidentUpdate.at,
    });
  }

  await guardInvariants(state, t, deps);

  state.transitions.push({ from: "ROLLBACK", to: "DONE", taskId: state.taskId });
  state.terminal = true;
  await auditAppend(deps, {
    at: deps.now(), taskId: state.taskId, phase: "ROLLBACK",
    fromPhase: "VERIFY", toPhase: "ROLLBACK",
    decision: "ROLLBACK", result: recon.reason, limitsUsed: { ...state.limitsUsed },
  });
}

function estimateContext(req: TaskRequest, state: ProjectState): number {
  return (req.goal.length + (req.context?.length ?? 0) + 200) * 4;
}
