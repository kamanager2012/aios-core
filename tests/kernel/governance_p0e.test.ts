// Final hardening: maxRetries guard, multi-process seq contention, capture lstat/timeout.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { Rollback } from "../../governor/rollback.js";
import { AuditLog } from "../../governor/audit.js";
import { MemoryStore } from "../../memory/index.js";
import { mkdtempSync, symlinkSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";

const NOW = () => "2026-06-14T00:00:00Z";
let seq = 0;
const newId = () => `id-${++seq}`;
const fakeState: ProjectState = { goal: "g", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() };
const plan: Plan = { task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }], tests: [], rollback: "git revert", approval: "AUTO", createdAt: NOW(), frozen: true };

describe("maxRetries guard", () => {
  let tmpDir: string; let memory: MemoryStore;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "retry-")); memory = new MemoryStore({ root: tmpDir }); seq = 0; });
  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("rejects maxRetries=0 and negative instead of crashing on execResult!", async () => {
    const deps: RuntimeDeps = { planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }), executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }), verifier: async () => ({ planId: "p", status: "pass", testsRun: 0, testsPassed: 0, testsFailed: 0, logSummary: "", autoFixAttempts: 0 }), scope: new ScopeValidator(), memory, rollback: new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW }), audit: new AuditLog({ memory, now: NOW, newId }), now: NOW, newId, maxRetries: 0, readProjectState: async () => fakeState };
    await expect(runTask({ goal: "g", project: "p" }, deps)).rejects.toThrow(/maxRetries must be an integer >= 1/);
    const deps2: RuntimeDeps = { ...deps, maxRetries: -1 };
    await expect(runTask({ goal: "g", project: "p" }, deps2)).rejects.toThrow(/maxRetries/);
  });
});

describe("audit seq contention (multi-process resync)", () => {
  it("two logs sharing one dir do not overwrite each other on seq 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-seq-"));
    const m1 = new MemoryStore({ root: dir });
    const m2 = new MemoryStore({ root: dir });
    const a1 = new AuditLog({ memory: m1, now: NOW, newId });
    const a2 = new AuditLog({ memory: m2, now: NOW, newId });
    // Pre-create entry_000001 by a1; a2 (which recovered 0 at construction) must retry past it.
    await a1.append({ at: NOW(), taskId: "t1", phase: "PLAN" });
    // Force a2's counter back to 0 to simulate the race window: it recovers then appends.
    (a2 as any)._seq = 0;
    await a2.append({ at: NOW(), taskId: "t2", phase: "PLAN" });
    expect(existsSync(join(dir, "current", "audit", "entry_000001.json"))).toBe(true);
    expect(existsSync(join(dir, "current", "audit", "entry_000002.json"))).toBe(true);
    const e1 = JSON.parse(readFileSync(join(dir, "current", "audit", "entry_000001.json"), "utf8"));
    expect(e1.taskId).toBe("t1");
    const both = [JSON.parse(readFileSync(join(dir, "current", "audit", "entry_000001.json"), "utf8")), JSON.parse(readFileSync(join(dir, "current", "audit", "entry_000002.json"), "utf8"))];
    expect(new Set(both.map((e: any) => e.taskId))).toEqual(new Set(["t1", "t2"]));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});
