// M hardening regression: scope quoted/interpreter, MemoryStore traversal+total,
// snapshot roundtrip, canonicalJson determinism, CLI chain+consistency.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ScopeValidator } from "../../governor/scope.js";
import { MemoryStore } from "../../memory/index.js";
import { Rollback } from "../../governor/rollback.js";
import { canonicalJson, HashChain, verifyChain } from "../../kernel/statehash.js";
import { runTask, type RuntimeDeps } from "../../kernel/runtime.js";
import { AuditLog } from "../../governor/audit.js";
import { replayAll } from "../../kernel/replay.js";
import { makeRuntimeDeps, checkReplayConsistency } from "../../cli/aios.js";
import { createFallbackProvider } from "../../kernel/model.js";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, ProjectState } from "../../kernel/schema/index.js";

const NOW = () => "2026-06-14T00:00:00Z";
let seq = 0;
const newId = () => `id-${++seq}`;
const fakeState: ProjectState = { goal: "g", active_task: null, branch: "main", phase: "IDLE", last_change: NOW() };

describe("M1 scope quoted-flag + interpreter inline", () => {
  const sv = new ScopeValidator();
  it("denies quoted flags that shell still parses as flags", () => {
    expect(sv.validateCommand('python3 "-c" "evil"')).toBe(false);
    expect(sv.validateCommand('git push "--force" origin')).toBe(false);
    expect(sv.validateCommand('git reset "--hard" HEAD')).toBe(false);
    expect(sv.validateCommand('git clean "-fdx"')).toBe(false);
    expect(sv.validateCommand('node "-e" "evil"')).toBe(false);
  });
  it("still allows quoted dangerous-looking literals to echo", () => {
    expect(sv.validateCommand('echo "rm -rf /"')).toBe(true);
    expect(sv.validateCommand("echo 'sudo reboot'")).toBe(true);
  });
  it("denies interpreter inline execution", () => {
    expect(sv.validateCommand('node -e "eval(1)"')).toBe(false);
    expect(sv.validateCommand("node --eval \"eval(1)\"")).toBe(false);
    expect(sv.validateCommand("python3 -m pip install evil")).toBe(false);
    expect(sv.validateCommand("npm exec -- evil")).toBe(false);
    expect(sv.validateCommand("node build.js")).toBe(true);
    expect(sv.validateCommand("npm install react")).toBe(true);
  });
  it("trims before filetype check", () => {
    expect(sv.validateFileType("cert.pem ")).toBe(false);
    expect(sv.validateFileType("  CERT.PEM  ")).toBe(false);
    expect(sv.validatePlan({ files: ["cert.pem "] } as any)).toBe(false);
  });
});

describe("M2 MemoryStore traversal + maxTotal", () => {
  let tmpDir: string;
  let memory: MemoryStore;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "mem-m-")); memory = new MemoryStore({ root: tmpDir }); seq = 0; });
  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("rejects path traversal and absolute paths", async () => {
    await expect(memory.writeToCurrent("../evil.json", "x")).rejects.toThrow(/relative|must not contain/);
    await expect(memory.writeToStaging("../evil.txt", "x")).rejects.toThrow(/relative|must not contain/);
    await expect(memory.readCurrent("../secret.json")).rejects.toThrow(/relative|must not contain/);
    await expect(memory.listCurrent("../")).rejects.toThrow(/relative|must not contain/);
    await expect(memory.writeToCurrent("/etc/passwd", "x")).rejects.toThrow(/relative/);
  });
  it("allows nested audit paths", async () => {
    await memory.writeToCurrent("audit/entry_000001.json", '{"seq":1}');
    expect(await memory.readCurrent("audit/entry_000001.json")).toBe('{"seq":1}');
    expect(await memory.listCurrent("audit")).toContain("entry_000001.json");
  });
  it("enforces maxTotalBytes across writes", async () => {
    const tight = new MemoryStore({ root: tmpDir, maxFileBytes: 10_000, maxTotalBytes: 150 });
    await tight.writeToCurrent("a.txt", "x".repeat(100));
    await expect(tight.writeToCurrent("b.txt", "y".repeat(100))).rejects.toThrow(/maxTotalBytes/);
    await expect(tight.appendTask({ taskId: "T-1", status: "s", decision: "COMMIT", at: NOW() })).rejects.toThrow(/maxTotalBytes/);
  });
});

describe("M3 snapshot roundtrip (no double-encode)", () => {
  let tmpDir: string;
  let memory: MemoryStore;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "snap-m-")); memory = new MemoryStore({ root: tmpDir }); seq = 0; });
  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("restores raw (non-JSON) files verbatim including nested", async () => {
    await memory.writeToCurrent("notes.txt", "hello world");
    await memory.writeToCurrent("project_state.json", '{"goal":"keep"}');
    await memory.writeToCurrent("audit/entry_000001.json", '{"seq":1}');
    const { id } = await memory.snapshotCurrent("task-1", NOW);
    // Corrupt current
    await memory.writeToCurrent("notes.txt", "changed");
    await memory.writeToCurrent("project_state.json", '{"goal":"changed"}');
    const rb = new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW });
    const res = await rb.fromSnapshot(id);
    expect(res.ok).toBe(true);
    expect(await memory.readCurrent("notes.txt")).toBe("hello world");
    expect(await memory.readCurrent("project_state.json")).toBe('{\n  "goal": "keep"\n}');
    // JSON files are re-serialized pretty-printed (semantically equal).
    expect(await memory.readCurrent("audit/entry_000001.json")).toBe('{\n  "seq": 1\n}');
  });
});

describe("M4 canonicalJson determinism", () => {
  it("uses codepoint sort, omits undefined, maps non-finite to null", () => {
    // Keys sorted by codepoint: _v (95) < at (97) < seq (115)
    const s = canonicalJson({ seq: 1, _v: 1, at: "x" } as any);
    expect(s).toBe('{"_v":1,"at":"x","seq":1}');
    expect(canonicalJson({ a: undefined, b: 1 } as any)).toBe('{"b":1}');
    expect(canonicalJson({ a: NaN } as any)).toBe('{"a":null}');
    expect(canonicalJson({ a: Infinity } as any)).toBe('{"a":null}');
    // Determinism across runs
    expect(canonicalJson({ b: 2, a: 1 } as any)).toBe(canonicalJson({ a: 1, b: 2 } as any));
  });
});

describe("M5 CLI hashChain + consistency", () => {
  let tmpDir: string;
  let memory: MemoryStore;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "cli-m-")); memory = new MemoryStore({ root: tmpDir }); seq = 0; });
  afterEach(async () => { try { await rm(tmpDir, { recursive: true, force: true }); } catch {} });

  it("makeRuntimeDeps injects a working hashChain", async () => {
    const provider = createFallbackProvider();
    const deps = makeRuntimeDeps(memory, false, 2, provider);
    expect(deps.hashChain).toBeInstanceOf(HashChain);
    // runTask still commits with chain verified strict
    const plan: Plan = { task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }], tests: [], rollback: "git revert", approval: "AUTO", createdAt: NOW(), frozen: true };
    const deps2: RuntimeDeps = { ...deps, planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }), executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }), verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }), scope: new ScopeValidator(), readProjectState: async () => fakeState };
    const state = await runTask({ goal: "g", project: "p" }, deps2);
    expect(state.decision).toBe("COMMIT");
    expect(state.lastFingerprint).toBeTruthy();
    const check = await verifyChain(deps2.hashChain!.getChain(), deps2.audit.all());
    expect(check.valid).toBe(true);
  });
  it("checkReplayConsistency passes on real replay and flags tampered decision", async () => {
    const plan: Plan = { task: "t", scope: ["src/**"], risk: "low", files: ["src/a.ts"], steps: [{ order: 1, action: "edit", target: "src/a.ts" }], tests: [], rollback: "git revert", approval: "AUTO", createdAt: NOW(), frozen: true };
    const audit = new AuditLog({ memory, now: NOW, newId });
    const deps: RuntimeDeps = { planner: async () => ({ ...plan, createdAt: NOW(), frozen: true }), executor: async () => ({ planId: newId(), diff: "d", stagingPath: "/staging", status: "succeeded", startedAt: NOW(), attempt: 1 }), verifier: async () => ({ planId: "p", status: "pass", testsRun: 5, testsPassed: 5, testsFailed: 0, logSummary: "ok", autoFixAttempts: 0 }), scope: new ScopeValidator(), memory, rollback: new Rollback({ runCommand: async () => ({ ok: true, stdout: "", stderr: "" }), memory, now: NOW }), audit, now: NOW, newId, readProjectState: async () => fakeState };
    const state = await runTask({ goal: "g", project: "p" }, deps);
    const entries = audit.all();
    const trajs = replayAll(entries);
    expect(checkReplayConsistency(entries, trajs, state.lastFingerprint ? entries.length : 0).diverged).toBe(false);
    const tampered = [{ ...trajs[0]!, finalDecision: "ROLLBACK" as const }];
    expect(checkReplayConsistency(entries, tampered, 0).diverged).toBe(true);
  });
});
