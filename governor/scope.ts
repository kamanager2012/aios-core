// AIOS Core — Scope validator.
// Per Charter §7: path allow/deny + command allow/deny + file type restrictions.
// Governor does NOT contain business logic.
//
// v1.1: ACS-aware. When an AcsClient is provided, scope is loaded from ACS
// runtime config (ACTIVE_TASK.json) and violations are checked before validation.
// Without AcsClient, falls back to DEFAULT_POLICY (backwards compatible).
// AcsClient is synchronous (reads JSON files, no subprocess).

import type { Plan } from "../kernel/schema/index.js";
import type { AcsClient } from "./acs_client.js";

export interface ScopePolicy {
  allowedPaths: string[];
  deniedPaths: string[];
  allowedCommands: string[];
  deniedCommands: string[];
  deniedFileTypes: string[];
}

export const DEFAULT_POLICY: ScopePolicy = {
  allowedPaths: ["**/*"],
  deniedPaths: [".aios/**", "**/.env", "**/secrets/**", "/etc/**", "/usr/**", "/var/**"],
  allowedCommands: [
    "echo", "git", "node", "pnpm", "npm", "vitest", "tsc",
    "cat", "ls", "pwd", "head", "tail", "wc", "find", "grep",
    "sed", "awk", "mkdir", "cp", "mv", "diff", "patch",
    "python3", "cargo", "go", "make",
  ],
  deniedCommands: ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="],
  deniedFileTypes: [".pem", ".key", ".p12", ".keystore", ".jks"],
};

// ACS-denied paths (protected zones that ACS enforces at hook level).
export const ACS_DENIED_PATHS = [
  ".claude/audit/",
  ".claude/hooks/",
  ".claude/settings.json",
  ".claude/settings.local.json",
];

export interface ScopeValidatorDeps {
  acs?: AcsClient;
  policy?: ScopePolicy;
}

export class ScopeValidator {
  public readonly policy: ScopePolicy;
  private readonly acs: AcsClient | null;

  constructor(deps?: ScopeValidatorDeps) {
    this.policy = deps?.policy ?? DEFAULT_POLICY;
    this.acs = deps?.acs ?? null;
  }

  /** Check if ACS is locked. If locked, all writes are denied. */
  isAcsLocked(): boolean {
    if (!this.acs) return false;
    return this.acs.isLocked();
  }

  /** Get ACS-enforced allowed directories. */
  getAcsScope(): string[] {
    if (!this.acs) return this.policy.allowedPaths;
    return this.acs.getScope();
  }

  /** Validate a plan against both local policy and ACS scope. */
  validatePlanWithAcs(plan: Plan): { ok: boolean; reason?: string } {
    // 1. ACS lock check
    if (this.isAcsLocked()) {
      return { ok: false, reason: "ACS is locked — all writes denied" };
    }

    // 2. Local policy check (synchronous)
    if (!this.validatePlan(plan)) {
      return { ok: false, reason: "plan violates local scope policy" };
    }

    // 3. ACS scope check
    if (this.acs) {
      const acsScope = this.getAcsScope();
      for (const file of plan.files) {
        const inAcsScope = acsScope.some((dir) => file.startsWith(dir));
        if (!inAcsScope) {
          return { ok: false, reason: `ACS scope violation: ${file} not in ACS allowed directories` };
        }
      }

      // 4. ACS protected paths
      for (const file of plan.files) {
        const isProtected = ACS_DENIED_PATHS.some((p) => file.includes(p));
        if (isProtected) {
          return { ok: false, reason: `ACS protected path: ${file}` };
        }
      }
    }

    return { ok: true };
  }

  validatePlan(plan: Plan): boolean {
    return plan.files.every((f) => this.validatePath(f) && this.validateFileType(f));
  }

  validatePath(path: string): boolean {
    if (this.matchesAny(path, this.policy.deniedPaths)) return false;
    if (ACS_DENIED_PATHS.some((p) => path.includes(p))) return false;
    if (this.policy.allowedPaths.length === 0) return false;
    return this.matchesAny(path, this.policy.allowedPaths);
  }

  validateCommand(cmd: string): boolean {
    const DANGEROUS_SEPARATORS = /[\|;&]/;
    if (DANGEROUS_SEPARATORS.test(cmd)) {
      const segments = cmd.split(DANGEROUS_SEPARATORS).map((s) => s.trim()).filter((s) => s.length > 0);
      return segments.every((seg) => this.validateSingleCommand(seg));
    }
    return this.validateSingleCommand(cmd.trim());
  }

  private validateSingleCommand(cmd: string): boolean {
    const stripped = cmd.replace(/^\s*(\w+=\S+\s*)+/, "").trim();
    const head = stripped.split(/\s+/)[0] ?? "";
    if (this.matchesAny(head, this.policy.deniedCommands)) return false;
    if (this.policy.allowedCommands.length === 0) return false;
    return this.matchesAny(head, this.policy.allowedCommands);
  }

  validateFileType(path: string): boolean {
    if (this.policy.deniedFileTypes.length === 0) return true;
    return !this.policy.deniedFileTypes.some((ext) => path.endsWith(ext));
  }

  private matchesAny(value: string, patterns: string[]): boolean {
    return patterns.some((p) => this.matchGlob(value, p));
  }

  private matchGlob(value: string, pattern: string): boolean {
    if (pattern === "**" || pattern === "**/*") return true;
    let regexStr = "";
    let i = 0;
    while (i < pattern.length) {
      const c = pattern[i]!;
      if (c === "*" && pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") { regexStr += "(?:.*\\/)?"; i += 3; }
        else { regexStr += ".*"; i += 2; }
      } else if (c === "*") { regexStr += "[^\\/]*"; i += 1; }
      else if (".+^${}()|[]\\".includes(c)) { regexStr += "\\" + c; i += 1; }
      else { regexStr += c; i += 1; }
    }
    return new RegExp("^" + regexStr + "$").test(value);
  }
}
