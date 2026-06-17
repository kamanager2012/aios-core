import { describe, it, expect } from "vitest";
import { ScopeValidator, DEFAULT_POLICY } from "../../governor/scope.js";

describe("ScopeValidator", () => {
  it("allows files under allowed paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("src/foo.ts")).toBe(true);
    expect(sv.validatePath("lib/bar.js")).toBe(true);
  });

  it("denies files under denied paths", () => {
    const sv = new ScopeValidator();
    expect(sv.validatePath("/etc/passwd")).toBe(false);
    expect(sv.validatePath(".env")).toBe(false);
    expect(sv.validatePath("secrets/key.pem")).toBe(false);
    expect(sv.validatePath("/usr/bin/bash")).toBe(false);
  });

  it("denies denied file types", () => {
    const sv = new ScopeValidator();
    expect(sv.validateFileType("cert.pem")).toBe(false);
    expect(sv.validateFileType("server.key")).toBe(false);
    expect(sv.validateFileType("src/app.ts")).toBe(true);
  });

  it("validates plan — all files must pass", () => {
    const sv = new ScopeValidator();
    const goodPlan = { files: ["src/a.ts", "src/b.ts"], scope: ["src/**"], risk: "low" as const, task: "t", steps: [], tests: [], rollback: "", approval: "AUTO" as const, createdAt: "", frozen: false };
    expect(sv.validatePlan(goodPlan as any)).toBe(true);

    const badPlan = { files: ["src/a.ts", "/etc/passwd"], scope: ["src/**"], risk: "low" as const, task: "t", steps: [], tests: [], rollback: "", approval: "AUTO" as const, createdAt: "", frozen: false };
    expect(sv.validatePlan(badPlan as any)).toBe(false);
  });

  it("allows commands in allowed list", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git status")).toBe(true);
    expect(sv.validateCommand("node build.js")).toBe(true);
  });

  it("denies dangerous commands", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("rm -rf /")).toBe(false);
    expect(sv.validateCommand("sudo apt install")).toBe(false);
  });

  it("rejects command chaining with dangerous second command", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git; rm -rf /")).toBe(false);
    expect(sv.validateCommand("git status && sudo reboot")).toBe(false);
    expect(sv.validateCommand("echo hi | rm -rf /")).toBe(false);
  });

  it("allows safe chained commands", () => {
    const sv = new ScopeValidator();
    expect(sv.validateCommand("git status && git log")).toBe(true);
    expect(sv.validateCommand("tsc && vitest")).toBe(true);
  });

  it("supports custom policies", () => {
    const sv = new ScopeValidator({
      policy: {
        allowedPaths: ["src/**"],
        deniedPaths: ["src/secret/**"],
        allowedCommands: ["node"],
        deniedCommands: [],
        deniedFileTypes: [],
      },
    });
    expect(sv.validatePath("src/app.ts")).toBe(true);
    expect(sv.validatePath("src/secret/vault.ts")).toBe(false);
    expect(sv.validatePath("lib/out.ts")).toBe(false);
    expect(sv.validateCommand("git")).toBe(false);
    expect(sv.validateCommand("node")).toBe(true);
  });
});
