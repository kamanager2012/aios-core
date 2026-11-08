// Release + residual hardening: Codex redaction, ACS segment boundary,
// package publishability (build/exports).

import { describe, it, expect } from "vitest";
import { parseCodexExecJsonl, redactSecrets } from "../../cli/codex.js";
import { AcsClient } from "../../governor/acs_client.js";
import { AcsBridge } from "../../governor/acs_bridge.js";
import { ScopeValidator } from "../../governor/scope.js";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

function toJsonl(events: unknown[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("Codex redaction", () => {
  it("redacts Bearer, sk-, and flag secrets", () => {
    expect(redactSecrets('curl -H "Authorization: Bearer sk-1234567890abcdefghij1234" https://x')).toContain("Bearer [REDACTED]");
    expect(redactSecrets("sk-1234567890abcdefghij1234")).toBe("[REDACTED]");
    expect(redactSecrets("tool --password hunter2")).not.toContain("hunter2");
    expect(redactSecrets("https://user:pass123@example.com")).toContain("://[REDACTED]@");
    expect(redactSecrets("AKIA1234567890ABCDEF")).toBe("[REDACTED]");
    expect(redactSecrets("npm test")).toBe("npm test");
  });
  it("redacts persisted command + agent text even without include flags", () => {
    const obs = parseCodexExecJsonl(toJsonl([
      { type: "item.completed", item: { id: "c1", type: "command_execution", command: 'curl -H "Authorization: Bearer sk-1234567890abcdefghij1234" https://x', aggregated_output: "ok", status: "completed" } },
      { type: "item.completed", item: { id: "m1", type: "agent_message", text: "token is sk-1234567890abcdefghij1234" } },
      { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } },
    ]));
    expect(obs.commands[0]?.command).not.toContain("sk-1234567890");
    expect(obs.commands[0]?.command).toContain("[REDACTED]");
    expect(obs.agentMessages[0]?.text).not.toContain("sk-1234567890");
    expect(obs.commands[0]?.aggregatedOutput).toBeUndefined();
  });
});

describe("ACS segment boundary", () => {
  it("blocks prefix siblings and empty-dir allow-all", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-seg-"));
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task_id: "t", allowed_dirs: ["/proj/src"] }));
    const client = new AcsClient(dir);
    expect(client.isPathInScope("/proj/src")).toBe(true);
    expect(client.isPathInScope("/proj/src/a.ts")).toBe(true);
    expect(client.isPathInScope("/proj/src_evil/a.ts")).toBe(false);
    expect(client.isPathInScope("/proj/src2/a.ts")).toBe(false);
    const bridge = new AcsBridge(new AcsClient(dir));
    const out = bridge.preflight({ task: "t", scope: [], risk: "low", files: ["/proj/src_evil/a.ts"], steps: [], tests: [], rollback: "", approval: "AUTO", createdAt: "", frozen: true } as any);
    expect(out.ok).toBe(false);
  });
  it("validatePlanWithAcs uses segment boundary too", () => {
    // Scope files are project-relative, so use relative dirs here.
    const acs = { isLocked: () => false, getScope: () => ["proj/src"] };
    const sv = new ScopeValidator({ acs });
    const good = sv.validatePlanWithAcs({ files: ["proj/src/a.ts"] } as any);
    const bad = sv.validatePlanWithAcs({ files: ["proj/src_evil/a.ts"] } as any);
    expect(good.ok).toBe(true);
    expect(bad.ok).toBe(false);
  });
  it("empty-string dir never matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-empty-"));
    writeFileSync(join(dir, "ACTIVE_TASK.json"), JSON.stringify({ task_id: "t", allowed_dirs: [""] }));
    const client = new AcsClient(dir);
    expect(client.isPathInScope("/anything")).toBe(false);
    expect(client.isPathInScope("/proj/src/a.ts")).toBe(false);
  });
});

describe("Package publishability", () => {
  it("package.json points at dist build output, not .ts sources", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.main).toBe("dist/kernel/runtime.js");
    expect(pkg.bin.aios).toBe("dist/cli/aios.js");
    expect(pkg.exports["."]?.default).toBe("./dist/kernel/runtime.js");
    expect(pkg.files).toContain("dist/");
    expect(pkg.engines?.node).toBe(">=20");
    expect(existsSync("tsconfig.build.json")).toBe(true);
    expect(existsSync("pnpm-lock.yaml")).toBe(false);
    expect(existsSync("pnpm-workspace.yaml")).toBe(false);
  });
  it("built dist is importable (skip if dist not built)", () => {
    if (!existsSync("dist/kernel/runtime.js")) return;
    execSync('node -e \'import("./dist/kernel/runtime.js").then(m=>{if(!m.runTask)process.exit(1)})\'', { stdio: "inherit" });
  });
});
