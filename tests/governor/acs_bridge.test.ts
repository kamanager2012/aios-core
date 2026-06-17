import { describe, it, expect, vi } from "vitest";
import { AcsClient } from "../../governor/acs_client.js";
import { AcsBridge } from "../../governor/acs_bridge.js";
import { ScopeValidator, ACS_DENIED_PATHS } from "../../governor/scope.js";
import { inferApproval, checkApprovalWithAcs } from "../../governor/approval.js";
import type { Plan } from "../../kernel/schema/index.js";

// ── Mock AcsClient ─────────────────────────────────────────────────────────

function createMockClient(overrides?: Partial<AcsClient>): AcsClient {
  return {
    status: overrides?.status ?? (async () => ({
      task: "test", dirs: ["src/"], shadow: false, proposal: false,
      violations: { window: 0, windowMax: 80, total: 0, totalMax: 150 },
      locked: false,
    })),
    isLocked: overrides?.isLocked ?? (async () => false),
    getScope: overrides?.getScope ?? (async () => ["src/"]),
    isPathInScope: overrides?.isPathInScope ?? (async (p: string) => p.startsWith("src/")),
    integrityCheck: overrides?.integrityCheck ?? (async () => ({ ok: true, chainLength: 5, tampered: [] })),
    getViolations: overrides?.getViolations ?? (async () => []),
  } as unknown as AcsClient;
}

function makePlan(overrides?: Partial<Plan>): Plan {
  return {
    task: "test task",
    scope: ["src/**"],
    risk: "low",
    files: ["src/a.ts"],
    steps: [{ order: 1, action: "fix", target: "src/a.ts" }],
    tests: [],
    rollback: "git revert",
    approval: "AUTO",
    createdAt: "2026-01-01T00:00:00Z",
    frozen: true,
    ...overrides,
  };
}

// ── AcsClient ──────────────────────────────────────────────────────────────

describe("AcsClient", () => {
  it("reports locked status", async () => {
    const client = createMockClient({ isLocked: async () => true });
    expect(await client.isLocked()).toBe(true);
  });

  it("reports unlocked status", async () => {
    const client = createMockClient({ isLocked: async () => false });
    expect(await client.isLocked()).toBe(false);
  });

  it("returns scope directories", async () => {
    const client = createMockClient({ getScope: async () => ["src/", "lib/"] });
    const scope = await client.getScope();
    expect(scope).toEqual(["src/", "lib/"]);
  });

  it("checks if path is in scope", async () => {
    const client = createMockClient();
    expect(await client.isPathInScope("src/foo.ts")).toBe(true);
    expect(await client.isPathInScope("etc/passwd")).toBe(false);
  });
});

// ── AcsBridge ──────────────────────────────────────────────────────────────

describe("AcsBridge", () => {
  it("preflight passes for valid plan in scope", async () => {
    const bridge = new AcsBridge(createMockClient());
    const result = await bridge.preflight(makePlan());
    expect(result.ok).toBe(true);
  });

  it("preflight fails when ACS is locked", async () => {
    const bridge = new AcsBridge(createMockClient({ isLocked: async () => true }));
    const result = await bridge.preflight(makePlan());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS is locked");
  });

  it("preflight fails for files out of ACS scope", async () => {
    const bridge = new AcsBridge(createMockClient({ getScope: async () => ["lib/"] }));
    const result = await bridge.preflight(makePlan({ files: ["src/a.ts"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS scope violation");
  });

  it("preflight fails for ACS protected paths", async () => {
    const bridge = new AcsBridge(createMockClient());
    const result = await bridge.preflight(makePlan({ files: [".claude/hooks/acs_lite.py"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS protected");
  });

  it("preflight fails when violation pressure is high", async () => {
    const bridge = new AcsBridge(createMockClient({
      status: async () => ({
        task: "test", dirs: ["src/"], shadow: false, proposal: false,
        violations: { window: 70, windowMax: 80, total: 50, totalMax: 150 },
        locked: false,
      }),
    }));
    const result = await bridge.preflight(makePlan());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("violation pressure");
  });

  it("reports status", async () => {
    const bridge = new AcsBridge(createMockClient());
    const status = await bridge.status();
    expect(status.locked).toBe(false);
    expect(status.scope).toEqual(["src/"]);
  });
});

// ── ScopeValidator with ACS ─────────────────────────────────────────────────

describe("ScopeValidator ACS integration", () => {
  it("denies ACS protected paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath(".claude/audit/entry.json")).toBe(false);
    expect(sv.validatePath(".claude/hooks/acs_lite.py")).toBe(false);
    expect(sv.validatePath(".claude/settings.json")).toBe(false);
  });

  it("validatePlanWithAcs passes for in-scope plan", async () => {
    const sv = new ScopeValidator({ acs: createMockClient() });
    const result = await sv.validatePlanWithAcs(makePlan());
    expect(result.ok).toBe(true);
  });

  it("validatePlanWithAcs fails when ACS is locked", async () => {
    const sv = new ScopeValidator({ acs: createMockClient({ isLocked: async () => true }) });
    const result = await sv.validatePlanWithAcs(makePlan());
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS is locked");
  });

  it("validatePlanWithAcs fails for out-of-scope files", async () => {
    const sv = new ScopeValidator({ acs: createMockClient({ getScope: async () => ["lib/"] }) });
    const result = await sv.validatePlanWithAcs(makePlan({ files: ["src/a.ts"] }));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("ACS scope violation");
  });
});

// ── Approval with ACS ───────────────────────────────────────────────────────

describe("Approval ACS integration", () => {
  it("auto-approves low risk plan when ACS is not locked", async () => {
    const result = await checkApprovalWithAcs(makePlan(), createMockClient());
    expect(result.approved).toBe(true);
    expect(result.level).toBe("AUTO");
  });

  it("rejects when ACS is locked", async () => {
    const result = await checkApprovalWithAcs(makePlan(), createMockClient({ isLocked: async () => true }));
    expect(result.approved).toBe(false);
    expect(result.acsLocked).toBe(true);
  });

  it("overrides AUTO to MANUAL for protected paths", async () => {
    const result = await checkApprovalWithAcs(
      makePlan({ approval: "AUTO", files: [".env"] }),
      createMockClient(),
    );
    expect(result.approved).toBe(false);
    expect(result.level).toBe("MANUAL");
  });

  it("still infers MANUAL for high risk plans", () => {
    expect(inferApproval(makePlan({ risk: "high" }))).toBe("MANUAL");
    expect(inferApproval(makePlan({ risk: "medium" }))).toBe("MANUAL");
    expect(inferApproval(makePlan({ risk: "low" }))).toBe("AUTO");
  });
});
