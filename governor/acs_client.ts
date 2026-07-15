// AIOS Core — ACS Client.
// Reads ACS runtime state from JSON files (no subprocess calls).
//
// Per Charter §9 Stage 1: read-only. This client reads:
//   - ACTIVE_TASK.json  → scope dirs
//   - VIOLATIONS.json   → violation events + scores
//   - LOCKED            → lock status
//
// No subprocess calls. No writes to ACS state.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const RUNTIME_DIR = process.env.ACS_RUNTIME_DIR ?? `${process.env.HOME}/.claude/runtime`;

// ── Types ──────────────────────────────────────────────────────────────────

export interface AcsStatus {
  task: string;
  dirs: string[];
  shadow: boolean;
  proposal: boolean;
  violations: { window: number; windowMax: number; total: number; totalMax: number };
  locked: boolean;
}

export interface AcsViolationEvent {
  timestamp: string;
  score: number;
  reason: string;
  category: string;
}

// ── Client ─────────────────────────────────────────────────────────────────

export class AcsClient {
  private readonly runtimeDir: string;

  constructor(runtimeDir?: string) {
    this.runtimeDir = runtimeDir ?? RUNTIME_DIR;
  }

  /** Get current ACS status by reading runtime files. */
  status(): AcsStatus {
    const locked = existsSync(path.join(this.runtimeDir, "LOCKED"));
    const task = this.readActiveTask();
    const violations = this.readViolations();
    return {
      task: task.taskId ?? "unknown",
      dirs: task.dirs ?? [],
      shadow: task.shadow ?? false,
      proposal: task.proposal ?? false,
      violations: {
        window: violations.windowScore ?? 0,
        windowMax: 80,
        total: violations.totalScore ?? 0,
        totalMax: 150,
      },
      locked,
    };
  }

  /** Check if ACS is currently locked. */
  isLocked(): boolean {
    return existsSync(path.join(this.runtimeDir, "LOCKED"));
  }

  /** Get current ACS scope (allowed directories). */
  getScope(): string[] {
    const task = this.readActiveTask();
    return task.dirs ?? [];
  }

  /** Check if a path is within ACS scope. */
  isPathInScope(filePath: string): boolean {
    const dirs = this.getScope();
    if (dirs.length === 0) return false;
    return dirs.some((dir) => filePath.startsWith(dir));
  }

  /** Get violation events. */
  getViolations(): AcsViolationEvent[] {
    const data = this.readViolations();
    return Array.isArray(data.events) ? data.events : [];
  }

  /** Check if ACS runtime directory exists (i.e., ACS is installed). */
  isAvailable(): boolean {
    return existsSync(this.runtimeDir);
  }

  // ── Internal ───────────────────────────────────────────────────────────

  private readActiveTask(): { taskId?: string; dirs?: string[]; shadow?: boolean; proposal?: boolean } {
    try {
      const raw = readFileSync(path.join(this.runtimeDir, "ACTIVE_TASK.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  private readViolations(): { events?: AcsViolationEvent[]; windowScore?: number; totalScore?: number } {
    try {
      const raw = readFileSync(path.join(this.runtimeDir, "VIOLATIONS.json"), "utf-8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
}
