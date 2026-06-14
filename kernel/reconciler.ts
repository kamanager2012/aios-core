// AIOS Core — Reconciler (pure reducer).
//
// Industrial redesign: reconciler is a pure function.
// No side effects. No ID generation. No IO.
// Input → Output. Runtime applies the decision.
//
// Per Charter §6: this is the ONLY place that may AUTHORIZE a memory write.
// But it does not PERFORM the write. Runtime does.
// Per discipline: the Reconciler MUST NOT call any model.
// It is a pure deterministic function of its inputs.

import type { Plan, ExecutionResult, VerificationReport, ProjectState, Decision, MemoryUpdate } from "./schema/index.js";

// ── Input ──────────────────────────────────────────────────────────────────

export interface ReconciliationInput {
  plan: Plan;
  executeResult: ExecutionResult;
  verifyReport: VerificationReport;
  projectState: ProjectState;
  now: string;
}

// ── Output ─────────────────────────────────────────────────────────────────

export interface ReconciliationOutput {
  decision: Decision;
  memoryUpdate: MemoryUpdate;
  reason: string;
}

// ── Pure reducer ───────────────────────────────────────────────────────────
// No class. No state. No ID generation.
// IDs are filled in by runtime when applying the decision.

export function reconcile(input: ReconciliationInput): ReconciliationOutput {
  // Executor failed → ROLLBACK
  if (input.executeResult.status === "failed") {
    const taskId = input.projectState.active_task;
    return {
      decision: "ROLLBACK",
      memoryUpdate: {
        appendIncident: {
          taskId,
          reason: `executor failed: ${input.executeResult.error ?? "unknown"}`,
          at: input.now,
        },
      },
      reason: `executor reported failure: ${input.executeResult.error ?? "unknown"}`,
    };
  }

  // Verify passed → COMMIT
  if (input.verifyReport.status === "pass") {
    const taskId = input.projectState.active_task;
    return {
      decision: "COMMIT",
      memoryUpdate: {
        current: { phase: "DONE", active_task: null, last_change: input.now },
        appendTask: {
          taskId,
          status: "completed",
          decision: "COMMIT",
          at: input.now,
        },
        appendDecision: {
          decision: "COMMIT",
          reason: "verify passed",
          at: input.now,
        },
      },
      reason: "verify passed; promote staging to formal memory",
    };
  }

  // Verify failed → ROLLBACK
  const incidentTaskId = input.projectState.active_task;
  return {
    decision: "ROLLBACK",
    memoryUpdate: {
      appendIncident: {
        taskId: incidentTaskId,
        reason: `verify failed: ${input.verifyReport.logSummary.slice(0, 200)}`,
        at: input.now,
      },
    },
    reason: `verify failed (${input.verifyReport.testsFailed} tests failed); rolling back`,
  };
}
