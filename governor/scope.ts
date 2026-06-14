// AIOS Core — Scope validator.
// Per Charter §7: path allow/deny + command allow/deny + file type restrictions.
// Governor does NOT contain business logic.

import type { Plan } from "../kernel/schema/index.js";

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

export class ScopeValidator {
  constructor(public readonly policy: ScopePolicy = DEFAULT_POLICY) {}

  validatePlan(plan: Plan): boolean {
    return plan.files.every((f) => this.validatePath(f) && this.validateFileType(f));
  }

  validatePath(path: string): boolean {
    if (this.matchesAny(path, this.policy.deniedPaths)) return false;
    if (this.policy.allowedPaths.length === 0) return false;
    return this.matchesAny(path, this.policy.allowedPaths);
  }

  validateCommand(cmd: string): boolean {
    // Shell control operators (|, &&, ||, ;) allow command chaining.
    // We must validate each segment independently to prevent bypasses like "git; rm -rf /".
    const DANGEROUS_SEPARATORS = /[\|;&]/;
    if (DANGEROUS_SEPARATORS.test(cmd)) {
      // Split on control operators and validate each segment
      const segments = cmd.split(DANGEROUS_SEPARATORS).map((s) => s.trim()).filter((s) => s.length > 0);
      return segments.every((seg) => this.validateSingleCommand(seg));
    }
    return this.validateSingleCommand(cmd.trim());
  }

  private validateSingleCommand(cmd: string): boolean {
    // Strip environment variable assignments (e.g. "FOO=bar git push")
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
