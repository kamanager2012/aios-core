import { describe, it, expect } from "vitest";
import { inferApproval, checkApproval } from "../../governor/approval.js";
import type { Plan } from "../../kernel/schema/index.js";

const basePlan: Plan = {
  task: "test", scope: ["src/**"], risk: "low", files: ["src/a.ts"],
  steps: [{ order: 1, action: "edit", target: "src/a.ts" }],
  tests: [], rollback: "git revert", approval: "AUTO", createdAt: "", frozen: false,
};

describe("inferApproval", () => {
  it("returns AUTO for low risk small changes", () => {
    expect(inferApproval(basePlan)).toBe("AUTO");
  });

  it("returns MANUAL for medium risk", () => {
    expect(inferApproval({ ...basePlan, risk: "medium" })).toBe("MANUAL");
  });

  it("returns MANUAL for high risk", () => {
    expect(inferApproval({ ...basePlan, risk: "high" })).toBe("MANUAL");
  });

  it("returns MANUAL for config files", () => {
    expect(inferApproval({ ...basePlan, files: ["package.json"] })).toBe("MANUAL");
  });

  it("returns MANUAL for delete actions", () => {
    expect(inferApproval({ ...basePlan, steps: [{ order: 1, action: "delete", target: "src/a.ts" }] })).toBe("MANUAL");
  });
});

describe("checkApproval", () => {
  it("AUTO plans pass immediately", async () => {
    const result = await checkApproval({ ...basePlan, approval: "AUTO" });
    expect(result.ok).toBe(true);
  });

  it("MANUAL plans require askHuman", async () => {
    const result = await checkApproval({ ...basePlan, approval: "MANUAL" });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("no askHuman");
  });

  it("MANUAL plans pass when human confirms", async () => {
    const result = await checkApproval(
      { ...basePlan, approval: "MANUAL" },
      async () => true,
    );
    expect(result.ok).toBe(true);
  });

  it("MANUAL plans fail when human denies", async () => {
    const result = await checkApproval(
      { ...basePlan, approval: "MANUAL" },
      async () => false,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("denied");
  });
});
