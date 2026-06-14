#!/usr/bin/env node
// AIOS Core — CLI entry point.
//
// Industrial redesign: uses function-based kernel interface.
// All IO goes through adapter layer.
//
// Usage:
//   aios run "fix login bug" --project myapp  (full pipeline)
//   aios plan "fix login bug" --project myapp
//   aios status
//   aios context
//   aios replay [--task <id>]
//   aios replay --last

import { runTask, type RuntimeDeps } from "../kernel/runtime.js";
import { createPlanner } from "../kernel/planner.js";
import { createExecutor } from "../kernel/executor.js";
import { createVerifier } from "../kernel/verifier.js";
import { ScopeValidator } from "../governor/scope.js";
import { Rollback } from "../governor/rollback.js";
import { AuditLog } from "../governor/audit.js";
import { MemoryStore } from "../memory/index.js";
import { buildContext } from "../memory/context.js";
import { DEFAULT_LIMITS } from "../governor/limits.js";
import { replayAll, replayTask, findNearestSnapshot } from "../kernel/replay.js";
import { checkDivergence, computeFullFingerprint } from "../kernel/statehash.js";
import type { TaskRequest, ProjectState, ExecutionTier } from "../kernel/schema/index.js";
import type { AuditEntry } from "../governor/audit.js";

const AIOS_ROOT = process.env.AIOS_ROOT ?? process.cwd();
const MEMORY_ROOT = process.env.AIOS_MEMORY ?? `${AIOS_ROOT}/.aios`;

function now() { return new Date().toISOString(); }
let seq = 0;
function newId() { return `id-${++seq}`; }

function parseArgs(argv: string[]): { command: string; goal: string; project: string; autoApprove: boolean; tier: ExecutionTier; taskId: string; last: boolean } {
  const args = argv.slice(2);
  const command = args[0] ?? "status";
  let goal = "";
  let project = process.cwd();
  let autoApprove = false;
  let tier: ExecutionTier = 2;
  let taskId = "";
  let last = false;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--project" && args[i + 1]) { project = args[++i]!; }
    else if (args[i] === "--auto-approve") { autoApprove = true; }
    else if (args[i] === "--tier" && args[i + 1]) { tier = parseInt(args[++i]!) as ExecutionTier; }
    else if (args[i] === "--task" && args[i + 1]) { taskId = args[++i]!; }
    else if (args[i] === "--last") { last = true; }
    else if (!args[i]?.startsWith("--")) { goal = args[i]!; }
  }

  return { command, goal, project, autoApprove, tier, taskId, last };
}

async function readProjectState(project: string): Promise<ProjectState> {
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(`${MEMORY_ROOT}/current/project_state.json`, "utf8");
    return JSON.parse(raw) as ProjectState;
  } catch {
    return { goal: "", active_task: null, branch: "main", phase: "IDLE", last_change: now(), project };
  }
}

function makeRuntimeDeps(memory: MemoryStore, goal: string, autoApprove: boolean, tier: ExecutionTier): RuntimeDeps {
  const audit = new AuditLog({ memory, now, newId });
  const rollback = new Rollback({
    runCommand: async (cmd) => {
      try {
        const { execSync } = await import("node:child_process");
        const stdout = execSync(cmd, { encoding: "utf8", cwd: AIOS_ROOT });
        return { ok: true, stdout, stderr: "" };
      } catch (e: any) {
        return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
      }
    },
    memory,
    now,
  });

  const planner = createPlanner({
    readProjectState: async () => readProjectState("aios-core"),
    modelCall: async (_prompt: string) => {
      console.error("[aios] modelCall not configured — running in shadow mode");
      return `task: ${goal}\nrisk: low\nscope: src/**\nfiles: []\napproval: AUTO`;
    },
    now,
  });

  const executor = createExecutor({
    applyPatch: async () => "",
    runCommand: async () => ({ ok: true, stdout: "", stderr: "" }),
    now,
    newId,
  });

  const verifier = createVerifier({
    runBuild: async () => ({ ok: true, log: "" }),
    runTest: async () => ({ ok: true, passed: 5, failed: 0, log: "" }),
    runLint: async () => ({ ok: true, log: "" }),
    runE2E: async () => ({ ok: true, log: "" }),
    now,
    newId,
  });

  return {
    planner,
    executor,
    verifier,
    scope: new ScopeValidator(),
    memory,
    rollback,
    audit,
    tier,
    now,
    newId,
    readProjectState: async () => readProjectState("aios-core"),
    ...(autoApprove ? { askHuman: async () => true } : {}),
  };
}

async function loadAuditEntries(memory: MemoryStore): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const auditDir = path.join(MEMORY_ROOT, "current", "audit");
    const files = await fs.readdir(auditDir);
    for (const f of files.sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(auditDir, f), "utf8");
        entries.push(JSON.parse(raw));
      } catch {}
    }
  } catch {}
  return entries;
}

async function main(): Promise<void> {
  const { command, goal, project, autoApprove, tier, taskId, last } = parseArgs(process.argv);
  const memory = new MemoryStore({ root: MEMORY_ROOT });

  switch (command) {
    case "plan":
    case "run": {
      if (!goal) {
        console.error("Usage: aios plan|run <goal> --project <name> [--tier 0|1|2] [--auto-approve]");
        process.exit(1);
      }
      const request: TaskRequest = { goal, project };
      const deps = makeRuntimeDeps(memory, goal, autoApprove, tier);
      const state = await runTask(request, deps);
      console.log(JSON.stringify({
        taskId: state.taskId,
        decision: state.decision,
        terminal: state.terminal,
        reason: state.reason,
        transitions: state.transitions,
        memoryCommitted: state.memoryCommitted,
        memoryRolledBack: state.memoryRolledBack,
        totalRetries: state.totalRetries,
        totalAutoFixAttempts: state.totalAutoFixAttempts,
        failureCategory: state.failureRecord?.category ?? null,
        fingerprint: state.lastFingerprint ?? null,
      }, null, 2));
      break;
    }

    case "status": {
      const projectState = await readProjectState(project);
      console.log(JSON.stringify(projectState, null, 2));
      break;
    }

    case "context": {
      const ctx = await buildContext(memory, null);
      console.log(JSON.stringify(ctx, null, 2));
      break;
    }

    case "replay": {
      const entries = await loadAuditEntries(memory);
      if (entries.length === 0) {
        console.error("No audit entries found");
        process.exit(1);
      }

      if (last || taskId) {
        // Replay specific task
        const filtered = taskId
          ? entries.filter((e) => e.taskId === taskId)
          : entries.filter((e) => e.taskId === entries[entries.length - 1]!.taskId);
        const trajectory = replayTask(filtered.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
        console.log(JSON.stringify(trajectory, null, 2));
      } else {
        // Replay all tasks
        const trajectories = replayAll(entries);
        // Divergence check: compute fingerprint of live entries vs replay
        const liveFp = await computeFullFingerprint(entries);
        const replayEntries = trajectories.flatMap((t) => t.points.map((p) => ({
          seq: p.seq, at: p.at, taskId: p.taskId, phase: p.phase as string,
          fromPhase: p.transition?.from, toPhase: p.transition?.to,
        } as AuditEntry)));
        const divergence = liveFp
          ? await checkDivergence(entries, replayEntries, liveFp.seq)
          : { diverged: false, message: "no entries" };
        console.log(JSON.stringify({
          trajectories,
          divergence,
          fingerprint: liveFp?.hash ?? null,
        }, null, 2));
      }
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Commands: plan, run, status, context, replay");
      process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
