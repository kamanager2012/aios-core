// Governance P0 — approval override, command gate, tier promotion.
// These tests bind the runtime to governor signals that were previously
// dead code (effectiveApproval / validateCommand / isMassDelete /
// commandTargetsDeniedPath / usesElevatedCommand) and to SPEC tier rules.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, checkPlanCommands, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import type { Plan, ProjectState, ExecutionTier } from "../../kernel/schema/index.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let memory: MemoryStore;
let seq = 0;
const NOW = () => "2026-06-14T00:00:00Z";
const newId = () => `id-${++seq}`;
const fakeState: ProjectState = { goal: "build", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() };

function basePlan(over: Partial<Plan> = {}): Plan {
  return {
    task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"],
    steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
    tests: [], rollback: "git revert", approval: "AUTO",
    createdAt: NOW(), frozen: true, ...over,
  };
}

function makeDeps(plan: Plan, opts?: { tier?: ExecutionTier; askHuman?: (p: Plan) => Promise<boolean>; policy?: any }): RuntimeDeps {
  const rollback = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
  const audit = new AuditLog({ memory, now: NOW, newId });
  return {
    planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }),
    executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
    verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
    scope: new ScopeValidator(opts?.policy ? { policy: opts.policy } : undefined),
    memory, rollback, audit,
    ...(opts?.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts?.askHuman ? { askHuman: opts.askHuman } : {}),
    now: NOW, newId,
    readProjectState: async () => fakeState,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "gov-p0-"));
  memory = new MemoryStore({ root: tmpDir });
  seq = 0;
});
afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

describe("B1: protected path forces MANUAL (model cannot self-approve)", () => {
  // Note: .env is already rejected earlier by validatePlan (deniedPaths **/.env),
  // so we use .claude/settings.json — passes scope but is protected for approval.
  it("rolls back AUTO plan touching protected path when human denies", async () => {
    const deps = makeDeps(basePlan({ files: [".claude/settings.json"] }), { askHuman: async () => false });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("denied");
    expect(state.transitions.map((t) => t.to)).not.toContain("EXECUTE");
  });
  it("proceeds when human approves forced MANUAL protected plan", async () => {
    const deps = makeDeps(basePlan({ files: [".claude/settings.json"] }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("COMMIT");
    expect(state.transitions.map((t) => t.to)).toContain("EXECUTE");
  });
  it("rolls back when no askHuman is provided for forced MANUAL", async () => {
    const deps = makeDeps(basePlan({ files: [".claude/settings.json"] }));
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("denied");
  });
});

describe("B2: plan command gate", () => {
  it("blocks rm -rf step at PLAN before EXECUTE", async () => {
    const deps = makeDeps(basePlan({ steps: [{ order: 1, action: "rm -rf /", target: "" }] }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("mass-delete");
    expect(state.transitions.map((t) => t.to)).not.toContain("EXECUTE");
  });
  it("blocks echo to /etc/passwd write target", async () => {
    const deps = makeDeps(basePlan({ steps: [{ order: 1, action: "echo x > /etc/passwd", target: "" }] }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("write target denied");
  });
  it("blocks find -delete", async () => {
    const deps = makeDeps(basePlan({ steps: [{ order: 1, action: "find . -delete", target: "" }] }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("mass-delete");
  });
  it("blocks sudo step as not-allowed command", async () => {
    const deps = makeDeps(basePlan({ steps: [{ order: 1, action: "sudo reboot", target: "" }] }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("not allowed");
  });
  it("blocks dangerous rollback string", async () => {
    const deps = makeDeps(basePlan({ rollback: "rm -rf /" }), { askHuman: async () => true });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
  });
  it("allows generic edit steps and git revert rollback", () => {
    const scope = new ScopeValidator();
    const check = checkPlanCommands(scope, basePlan());
    expect(check.ok).toBe(true);
    expect(check.elevated).toBe(false);
  });
  it("forces MANUAL for elevated commands when policy marks them", async () => {
    const policy = { allowedPaths: ["**/*"], deniedPaths: [] as string[], allowedCommands: ["echo", "node", "git"], deniedCommands: [], deniedFileTypes: [], elevatedCommands: ["node"] };
    const deps = makeDeps(basePlan({ steps: [{ order: 1, action: "node -e eval(1)", target: "" }] }), { askHuman: async () => false, policy });
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.reason).toContain("denied");
  });
});

describe("B5: tier promotion", () => {
  it("tier 0/1 would-commit without memory promotion", async () => {
    for (const tier of [0, 1] as ExecutionTier[]) {
      const deps = makeDeps(basePlan(), { tier });
      const state = await runTask({ goal: `g-${tier}`, project: "p" }, deps);
      expect(state.decision).toBe("COMMIT");
      expect(state.memoryCommitted).toBe(false);
      expect(state.reason).toContain(`tier ${tier}`);
    }
    expect(memory.count().tasks).toBe(0);
    expect(memory.count().decisions).toBe(0);
  });
  it("tier 2 and undefined (default) promote memory", async () => {
    const deps2 = makeDeps(basePlan(), { tier: 2 });
    const s2 = await runTask({ goal: "g2", project: "p" }, deps2);
    expect(s2.decision).toBe("COMMIT");
    expect(s2.memoryCommitted).toBe(true);
    const depsD = makeDeps(basePlan());
    const sD = await runTask({ goal: "gD", project: "p" }, depsD);
    expect(sD.memoryCommitted).toBe(true);
    expect(memory.count().tasks).toBe(2);
  });
});
