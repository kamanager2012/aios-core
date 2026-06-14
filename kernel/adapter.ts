// AIOS Core — Execution Adapter.
//
// Industrial redesign: IO is isolated behind adapters.
// Each ExecutionTier gets a different adapter implementation.
//
// Tier 0: dry-run — no IO, pure simulation
// Tier 1: shadow — real IO, no commit (staging only)
// Tier 2: production — full commit
//
// The adapter provides all IO-bound operations that kernel functions need.
// Kernel functions never touch IO directly — they only call adapter methods.

import type { Plan, ExecutionTier } from "./schema/index.js";
import type { PlannerFn, PlannerAdapter } from "./planner.js";
import type { ExecutorFn, ExecutorAdapter } from "./executor.js";
import type { VerifierFn, VerifierAdapter } from "./verifier.js";
import { createPlanner } from "./planner.js";
import { createExecutor } from "./executor.js";
import { createVerifier } from "./verifier.js";

// ── Unified adapter interface ──────────────────────────────────────────────

export interface RuntimeAdapter {
  tier: ExecutionTier;
  planner: PlannerFn;
  executor: ExecutorFn;
  verifier: VerifierFn;
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  now: () => string;
  newId: () => string;
}

// ── Adapter factory ────────────────────────────────────────────────────────

export interface AdapterConfig {
  tier: ExecutionTier;
  now: () => string;
  newId: () => string;
  // Planner IO
  readProjectState: (project: string) => Promise<import("./schema/index.js").ProjectState>;
  modelCall: (prompt: string) => Promise<string>;
  // Executor IO
  applyPatch: (plan: Plan, stagingPath: string) => Promise<string>;
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  // Verifier IO
  runBuild: () => Promise<{ ok: boolean; log: string }>;
  runTest: () => Promise<{ ok: boolean; passed: number; failed: number; log: string }>;
  runLint: () => Promise<{ ok: boolean; log: string }>;
  runE2E: () => Promise<{ ok: boolean; log: string }>;
  autoFix?: () => Promise<boolean>;
}

export function createAdapter(config: AdapterConfig): RuntimeAdapter {
  const plannerAdapter: PlannerAdapter = {
    readProjectState: config.readProjectState,
    modelCall: config.modelCall,
    now: config.now,
  };

  const executorAdapter: ExecutorAdapter = {
    applyPatch: config.applyPatch,
    runCommand: config.runCommand,
    now: config.now,
    newId: config.newId,
  };

  const verifierAdapter: VerifierAdapter = {
    runBuild: config.runBuild,
    runTest: config.runTest,
    runLint: config.runLint,
    runE2E: config.runE2E,
    now: config.now,
    newId: config.newId,
  };

  return {
    tier: config.tier,
    planner: createPlanner(plannerAdapter),
    executor: createExecutor(executorAdapter),
    verifier: createVerifier(verifierAdapter),
    runCommand: config.runCommand,
    now: config.now,
    newId: config.newId,
  };
}

// ── Tier 0: Dry-run adapter (pure simulation, no IO) ──────────────────────

export function createDryRunAdapter(overrides?: Partial<AdapterConfig>): RuntimeAdapter {
  return createAdapter({
    tier: 0,
    now: () => new Date().toISOString(),
    newId: (() => { let n = 0; return () => `dry-${++n}`; })(),
    readProjectState: async () => ({
      goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: new Date().toISOString(),
    }),
    modelCall: async () => "task: dry-run\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO",
    applyPatch: async () => "",
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    runBuild: async () => ({ ok: true, log: "" }),
    runTest: async () => ({ ok: true, passed: 0, failed: 0, log: "" }),
    runLint: async () => ({ ok: true, log: "" }),
    runE2E: async () => ({ ok: true, log: "" }),
    ...overrides,
  });
}
