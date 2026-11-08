// AIOS Core — Memory store with cold/hot/warm layering.
//
// Per Charter §4:
//   Current (hot) — current facts, only COMMIT can write, only dir that can be overwritten
//   Decisions (warm) — why, append-only
//   Tasks/Architecture/Incidents (cold) — what happened, append-only
//   Staging — executor scratch, cleared after commit/rollback
//   Snapshots — taken before each COMMIT promote

import { mkdir, writeFile, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { stat } from "node:fs/promises";

export interface MemoryTaskRecord {
  taskId: string;
  status: string;
  decision: string;
  at: string;
  [key: string]: unknown;
}

export interface MemoryDecisionRecord {
  id: string;
  decision: string;
  reason: string;
  at: string;
  [key: string]: unknown;
}

export interface MemoryIncidentRecord {
  id: string;
  taskId: string;
  reason: string;
  at: string;
  [key: string]: unknown;
}

export interface MemoryConfig {
  root: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

const DEFAULT_MAX_FILE = 1_000_000;
const DEFAULT_MAX_TOTAL = 10_000_000;

export class MemoryStore {
  private counters = { task: 0, decision: 0, incident: 0, snapshot: 0 };
  private readonly maxFile: number;
  private readonly maxTotal: number;
  private index = {
    tasks: new Map<string, MemoryTaskRecord>(),
    decisions: new Map<string, MemoryDecisionRecord>(),
    incidents: new Map<string, MemoryIncidentRecord>(),
  };

  constructor(private config: MemoryConfig) {
    this.maxFile = config.maxFileBytes ?? DEFAULT_MAX_FILE;
    this.maxTotal = config.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
    // Recover counters and index from disk on startup.
    // Prevents file name collisions and stale data after process restart.
    this._initFromDisk().catch(() => {});
  }

  private subdir(name: string): string { return join(this.config.root, name); }
  private async ensureDir(path: string): Promise<void> { await mkdir(path, { recursive: true }); }

  private assertSafeRelativePath(path: string): void {
    if (!path || path.includes("\0")) {
      throw new Error(`invalid memory path: ${String(path).slice(0, 80)}`);
    }
    const normalized = path.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.startsWith("//") || /^[A-Za-z]:/.test(normalized)) {
      throw new Error(`memory path must be relative: ${String(path).slice(0, 80)}`);
    }
    if (normalized.split("/").includes("..")) {
      throw new Error(`memory path must not contain ..: ${String(path).slice(0, 80)}`);
    }
  }

  private async totalSizeBytes(): Promise<number> {
    let total = 0;
    const walk = async (dir: string): Promise<void> => {
      let entries: import("node:fs").Dirent[] = [];
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) {
          try { const st = await stat(full); total += st.size; } catch {}
        }
      }
    };
    await walk(this.config.root);
    return total;
  }

  private async enforceLimits(content: string): Promise<void> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxFile) {
      throw new Error(`memory file exceeds maxFileBytes (${bytes} > ${this.maxFile})`);
    }
    const currentTotal = await this.totalSizeBytes();
    if (currentTotal + bytes > this.maxTotal) {
      throw new Error(`memory exceeds maxTotalBytes (${currentTotal + bytes} > ${this.maxTotal})`);
    }
  }

  private enforceFileLimit(content: string): void {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxFile) {
      throw new Error(`memory file exceeds maxFileBytes (${bytes} > ${this.maxFile})`);
    }
  }

  async writeToStaging(path: string, content: string): Promise<void> {
    this.assertSafeRelativePath(path);
    await this.enforceLimits(content);
    const full = join(this.subdir("staging"), path);
    await this.ensureDir(dirname(full));
    await writeFile(full, content, "utf8");
  }

  async clearStaging(): Promise<void> {
    try { await rm(this.subdir("staging"), { recursive: true, force: true }); } catch {}
  }

  /** Clear only this task's staging subtree. Other tasks' staging is untouched. */
  async clearStagingTask(taskId: string): Promise<void> {
    if (!taskId || taskId.includes("\0") || taskId.includes("..") || taskId.startsWith("/") || taskId.includes("\\")) {
      throw new Error(`invalid taskId for clearStagingTask: ${String(taskId).slice(0, 80)}`);
    }
    try { await rm(join(this.subdir("staging"), taskId), { recursive: true, force: true }); } catch {}
  }

  async writeToCurrent(path: string, content: string): Promise<void> {
    this.assertSafeRelativePath(path);
    await this.enforceLimits(content);
    const full = join(this.subdir("current"), path);
    await this.ensureDir(dirname(full));
    await writeFile(full, content, "utf8");
  }

  /** Exclusive create (fails if exists) — for multi-process seq allocation. */
  async writeToCurrentExclusive(path: string, content: string): Promise<void> {
    this.assertSafeRelativePath(path);
    await this.enforceLimits(content);
    const full = join(this.subdir("current"), path);
    await this.ensureDir(dirname(full));
    await writeFile(full, content, { encoding: "utf8", flag: "wx" });
  }

  /** List files in `current/` or a subdirectory. Missing dirs return []. */
  async listCurrent(relativeDir = ""): Promise<string[]> {
    if (relativeDir) this.assertSafeRelativePath(relativeDir);
    try {
      return await readdir(join(this.subdir("current"), relativeDir));
    } catch {
      return [];
    }
  }

  async readCurrent(path: string): Promise<string | undefined> {
    this.assertSafeRelativePath(path);
    try { return await readFile(join(this.subdir("current"), path), "utf8"); } catch { return undefined; }
  }

  async readSnapshot(snapshotId: string): Promise<string | undefined> {
    try { return await readFile(join(this.subdir("snapshots"), `${snapshotId}.json`), "utf8"); } catch { return undefined; }
  }

  async commitStaging(taskId: string, now: () => string): Promise<{ promoted: string[]; snapshotId: string }> {
    const stagingDir = this.subdir("staging");
    const currentDir = this.subdir("current");
    await this.ensureDir(currentDir);
    const snapshot = await this.snapshotCurrent(taskId, now);
    const promoted: string[] = [];
    const taskDir = join(stagingDir, taskId);
    let taskDirExists = false;
    try {
      const st = await stat(taskDir);
      taskDirExists = st.isDirectory();
    } catch {}
    if (taskDirExists) {
      // Per-task promotion: only this task's subtree. Other tasks keep staging.
      await this.promoteRecursive(taskDir, currentDir, "", promoted);
      await this.clearStagingTask(taskId);
    } else {
      // Legacy fallback: files staged without a task prefix (older callers/tests).
      await this.promoteRecursive(stagingDir, currentDir, "", promoted);
      await this.clearStaging();
    }
    return { promoted, snapshotId: snapshot.id };
  }

  /** Recursively promote files from staging to current, preserving directory structure. */
  private async promoteRecursive(srcDir: string, destDir: string, prefix: string, promoted: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(srcDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const relPath = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await this.promoteRecursive(join(srcDir, e.name), join(destDir, e.name), relPath, promoted);
      } else if (e.isFile()) {
        await this.ensureDir(dirname(join(destDir, e.name)));
        await rename(join(srcDir, e.name), join(destDir, e.name));
        promoted.push(relPath);
      }
    }
  }

  /** Recursively collect files under current/ (relative path -> raw text). */
  private async collectCurrentRecursive(base: string, out: Map<string, string>): Promise<void> {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = await readdir(base, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(base, e.name);
      const rel = join(base, e.name).slice(this.subdir("current").length).replace(/^\/+/, "");
      if (e.isDirectory()) await this.collectCurrentRecursive(full, out);
      else if (e.isFile()) {
        try {
          const v = await readFile(full, "utf8");
          out.set(rel, v);
        } catch {}
      }
    }
  }

  async snapshotCurrent(taskId: string, now: () => string): Promise<{ id: string }> {
    this.counters.snapshot++;
    const id = `snap_${String(this.counters.snapshot).padStart(4, "0")}`;
    const current: Record<string, unknown> = {};
    const rawFiles = new Map<string, string>();
    try {
      await this.collectCurrentRecursive(this.subdir("current"), rawFiles);
      for (const [rel, v] of rawFiles) {
        try { current[rel] = JSON.parse(v); } catch { current[rel] = { __raw: v }; }
      }
    } catch {
      console.warn(`[memory] snapshotCurrent: current/ dir not available for task ${taskId}`);
    }
    const path = join(this.subdir("snapshots"), `${id}.json`);
    const payload = JSON.stringify({ id, taskId, at: now(), current }, null, 2);
    this.enforceFileLimit(payload);
    await this.ensureDir(dirname(path));
    await writeFile(path, payload, "utf8");
    return { id };
  }

  async appendTask(record: MemoryTaskRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2);
    await this.enforceLimits(content);
    this.counters.task++;
    const path = join(this.subdir("tasks"), `task_${String(this.counters.task).padStart(4, "0")}.json`);
    await this.ensureDir(dirname(path));
    await writeFile(path, content, "utf8");
    this.index.tasks.set(record.taskId, record);
  }

  async appendDecision(record: MemoryDecisionRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2);
    await this.enforceLimits(content);
    this.counters.decision++;
    const path = join(this.subdir("decisions"), `decision_${String(this.counters.decision).padStart(4, "0")}.json`);
    await this.ensureDir(dirname(path));
    await writeFile(path, content, "utf8");
    this.index.decisions.set(record.id, record);
  }

  async appendIncident(record: MemoryIncidentRecord): Promise<void> {
    const content = JSON.stringify(record, null, 2);
    await this.enforceLimits(content);
    this.counters.incident++;
    const path = join(this.subdir("incidents"), `incident_${String(this.counters.incident).padStart(4, "0")}.json`);
    await this.ensureDir(dirname(path));
    await writeFile(path, content, "utf8");
    this.index.incidents.set(record.id, record);
  }

  /** Reload index from disk files for a given collection. */
  private async refreshIndex(collection: "tasks" | "decisions" | "incidents"): Promise<void> {
    const dir = this.subdir(collection);
    try {
      const files = await readdir(dir);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        try {
          const raw = await readFile(join(dir, f), "utf8");
          const record = JSON.parse(raw);
          const key = record.taskId ?? record.id;
          if (key) this.index[collection].set(key, record);
        } catch {}
      }
    } catch {}
  }

  recentTasks(n: number): MemoryTaskRecord[] {
    return Array.from(this.index.tasks.values())
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .slice(0, n);
  }

  recentDecisions(n: number): MemoryDecisionRecord[] {
    return Array.from(this.index.decisions.values())
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      .slice(0, n);
  }

  count(): { tasks: number; decisions: number; incidents: number; snapshots: number } {
    return { tasks: this.counters.task, decisions: this.counters.decision, incidents: this.counters.incident, snapshots: this.counters.snapshot };
  }

  // ── Startup recovery ───────────────────────────────────────────────────
  // Scan disk files to recover counters and rebuild index.
  // Called automatically in constructor (fire-and-forget).

  private async _initFromDisk(): Promise<void> {
    await Promise.all([
      this._recoverCounter("tasks", "task"),
      this._recoverCounter("decisions", "decision"),
      this._recoverCounter("incidents", "incident"),
      this._recoverCounter("snapshots", "snapshot"),
    ]);
    await Promise.all([
      this.refreshIndex("tasks"),
      this.refreshIndex("decisions"),
      this.refreshIndex("incidents"),
    ]);
  }

  private async _recoverCounter(
    collection: string,
    counter: "task" | "decision" | "incident" | "snapshot",
  ): Promise<void> {
    const dir = this.subdir(collection);
    try {
      const files = await readdir(dir);
      let maxNum = 0;
      for (const f of files) {
        const m = f.match(/(\d+)\.json$/);
        if (m) maxNum = Math.max(maxNum, parseInt(m[1]!, 10));
      }
      if (maxNum > this.counters[counter]) {
        this.counters[counter] = maxNum;
      }
    } catch {
      // Directory doesn't exist yet - counter stays at 0
    }
  }
}
