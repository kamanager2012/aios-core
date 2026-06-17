// AIOS Core — ACS Client.
// Bridge to Agent Constraint System (acs_lite.py).
// Provides: scope loading, violation tracking, lock status, integrity verification.
//
// Communication: subprocess calls to `python3 ~/.claude/hooks/acs_lite.py`.
// This is a read-only client — it does NOT modify ACS state.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ACS_PATH = process.env.ACS_PATH ?? `${process.env.HOME}/.claude/hooks/acs_lite.py`;
const PYTHON = process.env.ACS_PYTHON ?? "python3";

// ── ACS Status ─────────────────────────────────────────────────────────────

export interface AcsStatus {
  task: string;
  dirs: string[];
  shadow: boolean;
  proposal: boolean;
  violations: { window: number; windowMax: number; total: number; totalMax: number };
  locked: boolean;
}

// ── ACS Violation Event ────────────────────────────────────────────────────

export interface AcsViolationEvent {
  timestamp: string;
  score: number;
  reason: string;
  category: string;
}

// ── ACS Integrity ──────────────────────────────────────────────────────────

export interface AcsIntegrityResult {
  ok: boolean;
  chainLength: number;
  tampered: string[];
}

// ── Client ─────────────────────────────────────────────────────────────────

export class AcsClient {
  constructor(
    private readonly acsPath: string = ACS_PATH,
    private readonly python: string = PYTHON,
  ) {}

  /** Get current ACS status. */
  async status(): Promise<AcsStatus> {
    const { stdout } = await this.run(["status"]);
    return this.parseStatus(stdout);
  }

  /** Check if ACS is currently locked. */
  async isLocked(): Promise<boolean> {
    try {
      const status = await this.status();
      return status.locked;
    } catch {
      // If ACS is unreachable, treat as locked (fail-safe).
      return true;
    }
  }

  /** Get current ACS scope (allowed directories). */
  async getScope(): Promise<string[]> {
    try {
      const status = await this.status();
      return status.dirs;
    } catch {
      return [];
    }
  }

  /** Check if a path is within ACS scope. */
  async isPathInScope(path: string): Promise<boolean> {
    const dirs = await this.getScope();
    if (dirs.length === 0) return false;
    return dirs.some((dir) => path.startsWith(dir));
  }

  /** Verify ACS integrity chain. */
  async integrityCheck(): Promise<AcsIntegrityResult> {
    try {
      const { stdout } = await this.run(["integrity-check"]);
      const ok = stdout.includes("integrity: ok") || stdout.includes("valid");
      return { ok, chainLength: 0, tampered: ok ? [] : ["integrity check failed"] };
    } catch {
      return { ok: false, chainLength: 0, tampered: ["ACS unreachable"] };
    }
  }

  /** Get violation events from the violations file. */
  async getViolations(): Promise<AcsViolationEvent[]> {
    try {
      const { readFileSync } = await import("node:fs");
      const path = await import("node:path");
      const violationsPath = path.join(
        process.env.HOME ?? "/home",
        ".claude/runtime/VIOLATIONS.json",
      );
      const raw = readFileSync(violationsPath, "utf-8");
      const data = JSON.parse(raw);
      return Array.isArray(data.events) ? data.events : [];
    } catch {
      return [];
    }
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private async run(args: string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(this.python, [this.acsPath, ...args], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  }

  private parseStatus(raw: string): AcsStatus {
    const task = this.extractField(raw, "task") ?? "unknown";
    const dirsMatch = raw.match(/dirs:\s*\[([^\]]*)\]/);
    const dirs = dirsMatch
      ? dirsMatch[1]!.split(",").map((s) => s.trim().replace(/['"]/g, "")).filter((s) => s.length > 0)
      : [];
    const shadow = raw.includes("shadow: True");
    const proposal = raw.includes("proposal: True");
    const locked = raw.includes("locked: YES");
    const violations = this.parseViolations(raw);
    return { task, dirs, shadow, proposal, violations, locked };
  }

  private parseViolations(raw: string): AcsStatus["violations"] {
    const vm = raw.match(/violations:\s*window=(\d+)\/(\d+)\s+total=(\d+)\/(\d+)/);
    return {
      window: vm ? parseInt(vm[1]!) : 0,
      windowMax: vm ? parseInt(vm[2]!) : 80,
      total: vm ? parseInt(vm[3]!) : 0,
      totalMax: vm ? parseInt(vm[4]!) : 150,
    };
  }

  private extractField(raw: string, name: string): string | undefined {
    const m = raw.match(new RegExp(`${name}:\\s*(\\S+)`));
    return m?.[1];
  }
}
