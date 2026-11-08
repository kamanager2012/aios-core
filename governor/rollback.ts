// AIOS Core — Rollback.
// Per Charter §7: independent module, not embedded in executor.
// All rollback operations go through this single entry point.
// Supports: git restore, git revert, snapshot restore, undo.

import type { MemoryStore } from "../memory/index.js";

export interface RollbackDeps {
  runCommand: (cmd: string) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  /** Optional argv runner (execFile, no shell). Preferred over runCommand. */
  runCommandFile?: (cmd: string, args: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  memory: MemoryStore;
  now: () => string;
}

// Paths/refs that go into a shell string must be boring. Reject anything
// with whitespace or shell metacharacters even before choosing a runner.
function isSafeRestorePath(p: string): boolean {
  if (!p || p.includes("\0") || /\s/.test(p)) return false;
  if (/[;|&$><`'"\\*?\[\]{}()!#~]/.test(p)) return false;
  if (p === "." || p === ".." || p.startsWith("../") || p.startsWith("/")) return false;
  // Allow alphanumerics, dot, slash, dash, underscore, @, +, colon.
  return /^[A-Za-z0-9_.\/@+:-]+$/.test(p);
}

function isSafeCommitHash(h: string): boolean {
  return /^[0-9a-fA-F]{4,40}$/.test(h);
}

export interface RollbackResult {
  ok: boolean;
  method: "restore" | "revert" | "snapshot" | "undo" | "none";
  reason: string;
}

export class Rollback {
  // Snapshot IDs persisted to memory so they survive process restarts.
  // The in-memory list is reloaded from disk on first use.
  private _snapshotStack: string[] | null = null;

  constructor(private deps: RollbackDeps) {}

  private async loadSnapshotStack(): Promise<string[]> {
    if (this._snapshotStack !== null) return this._snapshotStack;
    const stack: string[] = [];
    try {
      const raw = await this.deps.memory.readCurrent("_rollback_snapshots.json");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const item of parsed) stack.push(String(item));
        }
      }
    } catch {}
    this._snapshotStack = stack;
    return stack;
  }

  private async saveSnapshotStack(): Promise<void> {
    if (this._snapshotStack === null) return;
    await this.deps.memory.writeToCurrent("_rollback_snapshots.json", JSON.stringify(this._snapshotStack));
  }

 /** Take a snapshot of current memory state. Returns snapshot ID. */
 async snapshot(): Promise<string> {
   const tag = `rb_${Date.now()}`;
   const { id } = await this.deps.memory.snapshotCurrent(tag, this.deps.now);
   const stack = await this.loadSnapshotStack();
   stack.push(id);
   await this.saveSnapshotStack();
   return id;
 }

  /** Restore working tree — ONLY the given paths, never the whole tree.
   *
   *  A bare `git restore .` would revert the entire working tree to HEAD
   *  and destroy unrelated uncommitted user work, including on rollback
   *  paths that never executed anything (scope/approval rejection). Paths
   *  are therefore mandatory; when called without paths (legacy callers) or
   *  with an empty list, this is a SAFE NO-OP — nothing is restored, nothing
   *  is destroyed. Callers that have not executed any writes should use
   *  none() explicitly for the same effect. */
  async restore(paths?: string[]): Promise<RollbackResult> {
    if (!paths || paths.length === 0) {
      return { ok: true, method: "none", reason: "nothing to restore (no paths provided)" };
    }
    for (const p of paths) {
      if (!isSafeRestorePath(p)) {
        return { ok: false, method: "restore", reason: `unsafe path rejected: ${String(p).slice(0, 80)}` };
      }
    }
    // `--` guards against paths beginning with "-" being parsed as flags.
    const target = paths.join(" ");
    const r = this.deps.runCommandFile
      ? await this.deps.runCommandFile("git", ["restore", "--", ...paths])
      : await this.deps.runCommand(`git restore -- ${target}`);
    return { ok: r.ok, method: "restore", reason: r.ok ? `restored ${target}` : `restore failed: ${r.stderr}` };
  }

  /** Revert a specific commit (git revert). */
  async revert(commitHash: string): Promise<RollbackResult> {
    if (!isSafeCommitHash(commitHash)) {
      return { ok: false, method: "revert", reason: `unsafe commit hash rejected: ${String(commitHash).slice(0, 80)}` };
    }
    const r = this.deps.runCommandFile
      ? await this.deps.runCommandFile("git", ["revert", "--no-edit", commitHash])
      : await this.deps.runCommand(`git revert --no-edit ${commitHash}`);
    return { ok: r.ok, method: "revert", reason: r.ok ? `reverted ${commitHash}` : `revert failed: ${r.stderr}` };
  }

 /** Restore from a named snapshot. The snapshot contains a JSON dump of current/ state,
  *  which we write back to current/ (not a git checkout — snapshots are memory-level). */
 async fromSnapshot(snapshotId: string): Promise<RollbackResult> {
   try {
     const raw = await this.deps.memory.readSnapshot(snapshotId);
     if (!raw) return { ok: false, method: "snapshot", reason: `snapshot ${snapshotId} not found` };
      const snapshot = JSON.parse(raw);
      if (snapshot.current && typeof snapshot.current === "object") {
        for (const [key, value] of Object.entries(snapshot.current)) {
          // New snapshots mark non-JSON files as { __raw: text } to avoid
          // double-encoding. Legacy snapshots stored raw text as a string.
          const isRawMarker = value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value as object).length === 1 && "__raw" in (value as Record<string, unknown>);
          if (isRawMarker) {
            await this.deps.memory.writeToCurrent(key, String((value as Record<string, unknown>).__raw));
          } else if (typeof value === "string") {
            // Legacy raw text: write verbatim (old code JSON.stringify'd it).
            await this.deps.memory.writeToCurrent(key, value);
          } else {
            await this.deps.memory.writeToCurrent(key, JSON.stringify(value, null, 2));
          }
        }
      }
      return { ok: true, method: "snapshot", reason: `restored from snapshot ${snapshotId}` };
    } catch (err) {
      return { ok: false, method: "snapshot", reason: `snapshot restore failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Undo the last snapshot (pop from stack and restore). */
  async undo(): Promise<RollbackResult> {
    const stack = await this.loadSnapshotStack();
    const lastId = stack.pop();
    if (!lastId) return { ok: false, method: "undo", reason: "no snapshot to undo" };
    await this.saveSnapshotStack();
    return this.fromSnapshot(lastId);
  }

  /** No-op rollback when there is nothing to restore (e.g. scope rejection before execution). */
  none(reason: string): RollbackResult {
    return { ok: true, method: "none", reason };
  }
}
