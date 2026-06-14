// AIOS Core — Approval.
// Per Charter §3 + §7: AUTO/MANUAL two-level approval.
// Approval is a Plan property, not a state.
// AUTO: low risk, small changes → runtime proceeds without human.
// MANUAL: config, delete, migration, high risk → runtime pauses for human.

import type { Plan, Approval } from "../kernel/schema/index.js";

export function inferApproval(plan: Plan): Approval {
  if (plan.risk === "high") return "MANUAL";
  if (plan.risk === "medium") return "MANUAL";
  if (plan.files.some((f) => isConfigFile(f) || isDestructiveAction(plan))) return "MANUAL";
  return "AUTO";
}

function isConfigFile(path: string): boolean {
  const configPatterns = ["package.json", "tsconfig", ".eslintrc", "vitest.config", "docker-compose", "Dockerfile", ".github"];
  return configPatterns.some((p) => path.includes(p));
}

function isDestructiveAction(plan: Plan): boolean {
  return plan.steps.some((s) => s.action === "delete" || s.action === "migrate");
}

/** Check if a plan requires human approval and the human has confirmed. */
export async function checkApproval(
  plan: Plan,
  askHuman?: (plan: Plan) => Promise<boolean>,
): Promise<{ ok: boolean; reason?: string }> {
  if (plan.approval === "AUTO") return { ok: true };
  // MANUAL
  if (!askHuman) return { ok: false, reason: "manual approval required but no askHuman provided" };
  const confirmed = await askHuman(plan);
  if (!confirmed) return { ok: false, reason: "manual approval denied" };
  return { ok: true };
}
