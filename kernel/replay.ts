// AIOS Core — Audit Replay.
//
// Reconstructs complete RuntimeState trajectory from audit log.
// Deterministic replay: same audit entries → same state trajectory.

import type { Phase, Decision, Plan, ExecutionResult, VerificationReport } from "./schema/index.js";
import type { PhaseTransition } from "./runtime.js";
import type { AuditEntry } from "../governor/audit.js";
import { upgradeEntry, validateEntryVersion, CURRENT_SCHEMA_VERSION, type VersionedEntry } from "./schema_version.js";

// ── Replayed state at a single point in time ───────────────────────────────

export interface ReplayPoint {
  seq: number;
  at: string;
  taskId: string;
  phase: Phase | "IDLE";
  transition?: { from: Phase | "IDLE"; to: Phase; note?: string };
  plan?: Plan;
  execResult?: ExecutionResult;
  verifyReport?: VerificationReport;
  decision?: Decision;
  snapshotId?: string;
  limitsUsed?: { turns: number; context: number; retries: number };
  attempt?: number;
  autoFixAttempts?: number;
}

// ── Replayed trajectory for a task ─────────────────────────────────────────

export interface ReplayTrajectory {
  taskId: string;
  points: ReplayPoint[];
  transitions: PhaseTransition[];
  finalPhase: Phase | "IDLE";
  finalDecision: Decision | null;
  terminal: boolean;
  totalRetries: number;
  totalAutoFixAttempts: number;
  committed: boolean;
  rolledBack: boolean;
  reason: string;
}

// ── Replay from audit entries ──────────────────────────────────────────────

export function replayTask(rawEntries: AuditEntry[]): ReplayTrajectory {
  const upgraded = rawEntries.map((e) => {
    const v = validateEntryVersion(e as unknown as VersionedEntry);
    if (!v.valid) {
      throw new Error(`Cannot replay entry with future schema version ${v.version} (current: ${CURRENT_SCHEMA_VERSION})`);
    }
    return v.needsMigration ? (upgradeEntry(e as unknown as VersionedEntry) as unknown as AuditEntry) : e;
  });
  const entries_ = upgraded;
  if (entries_.length === 0) {
    return {
      taskId: "",
      points: [],
      transitions: [],
      finalPhase: "IDLE",
      finalDecision: null,
      terminal: false,
      totalRetries: 0,
      totalAutoFixAttempts: 0,
      committed: false,
      rolledBack: false,
      reason: "",
    };
  }

  const taskId = entries_[0]!.taskId;
  const points: ReplayPoint[] = [];
  const transitions: PhaseTransition[] = [];
  let finalPhase: Phase | "IDLE" = "IDLE";
  let finalDecision: Decision | null = null;
  let terminal = false;
  let committed = false;
  let rolledBack = false;
  let reason = "";
  let totalRetries = 0;
  let totalAutoFixAttempts = 0;

  for (const entry of entries_) {
    const point: ReplayPoint = {
      seq: entry.seq ?? 0,
      at: entry.at,
      taskId: entry.taskId,
      phase: (entry.toPhase ?? entry.phase) as Phase | "IDLE",
    };

    if (entry.plan) point.plan = entry.plan;
    if (entry.execResult) point.execResult = entry.execResult;
    if (entry.verifyReport) point.verifyReport = entry.verifyReport;
    if (entry.decision) point.decision = entry.decision;
    if (entry.snapshotId) point.snapshotId = entry.snapshotId;
    if (entry.limitsUsed) point.limitsUsed = entry.limitsUsed;
    if (entry.attempt) point.attempt = entry.attempt;
    if (entry.autoFixAttempts) point.autoFixAttempts = entry.autoFixAttempts;

    if (entry.fromPhase && entry.toPhase) {
      point.transition = { from: entry.fromPhase, to: entry.toPhase };
      const t: PhaseTransition = {
        from: entry.fromPhase,
        to: entry.toPhase,
        taskId: entry.taskId,
      };
      transitions.push(t);
    }

    if (entry.attempt && entry.attempt > 1) {
      totalRetries += entry.attempt - 1;
    }
    if (entry.autoFixAttempts) {
      totalAutoFixAttempts = Math.max(totalAutoFixAttempts, entry.autoFixAttempts);
    }

    finalPhase = point.phase;
    if (entry.decision) finalDecision = entry.decision;
    if (entry.phase === "COMMIT") committed = true;
    if (entry.phase === "ROLLBACK") rolledBack = true;
    if (entry.phase === "DONE" || entry.phase === "COMMIT" || entry.phase === "ROLLBACK") terminal = true;
    if (entry.result) reason = entry.result;

    points.push(point);
  }

  return {
    taskId,
    points,
    transitions,
    finalPhase,
    finalDecision,
    terminal,
    totalRetries,
    totalAutoFixAttempts,
    committed,
    rolledBack,
    reason,
  };
}

// ── Replay multiple tasks from full audit log ──────────────────────────────

export function replayAll(entries: AuditEntry[]): ReplayTrajectory[] {
  const byTask = new Map<string, AuditEntry[]>();
  for (const entry of entries) {
    const existing = byTask.get(entry.taskId) ?? [];
    existing.push(entry);
    byTask.set(entry.taskId, existing);
  }

  return Array.from(byTask.entries())
    .map(([_, taskEntries]) => replayTask(taskEntries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))));
}

// ── Query: find nearest snapshot before a given seq ────────────────────────

export function findNearestSnapshot(
  entries: AuditEntry[],
  beforeSeq: number,
): string | undefined {
  let nearest: string | undefined;
  let nearestSeq = 0;

  for (const entry of entries) {
    if (entry.snapshotId && (entry.seq ?? 0) <= beforeSeq && (entry.seq ?? 0) > nearestSeq) {
      nearest = entry.snapshotId;
      nearestSeq = entry.seq ?? 0;
    }
  }

  return nearest;
}

// ── Query: reconstruct state at a given point ──────────────────────────────

export function stateAtPoint(
  entries: AuditEntry[],
  seq: number,
): ReplayPoint | undefined {
  const entry = entries.find((e) => e.seq === seq);
  if (!entry) return undefined;

  const point: ReplayPoint = {
    seq: entry.seq ?? 0,
    at: entry.at,
    taskId: entry.taskId,
    phase: (entry.toPhase ?? entry.phase) as Phase | "IDLE",
  };

  if (entry.fromPhase && entry.toPhase) {
    point.transition = { from: entry.fromPhase, to: entry.toPhase };
  }
  if (entry.plan) point.plan = entry.plan;
  if (entry.execResult) point.execResult = entry.execResult;
  if (entry.verifyReport) point.verifyReport = entry.verifyReport;
  if (entry.decision) point.decision = entry.decision;
  if (entry.snapshotId) point.snapshotId = entry.snapshotId;
  if (entry.limitsUsed) point.limitsUsed = entry.limitsUsed;
  if (entry.attempt) point.attempt = entry.attempt;
  if (entry.autoFixAttempts) point.autoFixAttempts = entry.autoFixAttempts;

  return point;
}
