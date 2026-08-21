import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PolicyEvalCase, PolicyEvalSeverity } from "../../kernel/eval.js";

interface LegacyAcsCase {
  id: string;
  category: string;
  description: string;
  command?: string;
  filepath?: string;
  expected: "block" | "allow";
  severity: PolicyEvalSeverity;
  bypass_methods?: string[];
  note?: string;
  runtime_required?: boolean;
}

interface LegacyFile {
  scenarios: LegacyAcsCase[];
}

const ROOT = join(process.cwd(), "shadow", "evals", "policy", "acs-v1");
const RAW = join(ROOT, "raw");
const FILES = [
  "bash_dangerous.json",
  "bypass_attempts.json",
  "false_positive.json",
  "filesystem_write.json",
  "git_destructive.json",
  "self_protect.json",
] as const;

const EXPECTED_COUNTS: Record<(typeof FILES)[number], number> = {
  "bash_dangerous.json": 30,
  "bypass_attempts.json": 20,
  "false_positive.json": 10,
  "filesystem_write.json": 20,
  "git_destructive.json": 15,
  "self_protect.json": 10,
};

function load(file: string): LegacyAcsCase[] {
  return (JSON.parse(readFileSync(join(RAW, file), "utf8")) as LegacyFile).scenarios;
}

function normalize(item: LegacyAcsCase): PolicyEvalCase {
  const input = item.command
    ? { type: "command" as const, value: item.command }
    : { type: "path" as const, value: item.filepath ?? "" };

  return {
    id: item.id,
    category: item.category,
    description: item.description,
    expected: item.expected === "block" ? "deny" : "allow",
    severity: item.severity,
    input,
    source: {
      repository: "kamanager2012/agent-constraint-system",
      path: `benchmarks/scenarios/${item.category}.json`,
      legacyId: item.id,
    },
    tags: [
      ...(item.runtime_required ? ["runtime-required"] : []),
      ...((item.bypass_methods?.length ?? 0) > 0 ? ["has-bypass-variants"] : []),
    ],
  };
}

describe("ACS v1 corpus migration", () => {
  it("preserves all 105 source scenarios with stable unique IDs", () => {
    const all = FILES.flatMap((file) => load(file));
    expect(all).toHaveLength(105);
    expect(new Set(all.map((item) => item.id)).size).toBe(105);

    for (const file of FILES) {
      expect(load(file)).toHaveLength(EXPECTED_COUNTS[file]);
    }
  });

  it("matches the pinned manifest baseline", () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8")) as {
      sourceBaseline: { totalScenarios: number; failedScenarioIds: string[] };
      source: { commit: string };
    };
    const allIds = new Set(FILES.flatMap((file) => load(file)).map((item) => item.id));

    expect(manifest.sourceBaseline.totalScenarios).toBe(105);
    expect(manifest.source.commit).toBe("a8e41fa27822f32d2a39163767ef2d5413b9c30d");
    expect(manifest.sourceBaseline.failedScenarioIds).toEqual([
      "bypass-007",
      "bypass-016",
      "bypass-017",
      "bypass-020",
      "fp-001",
      "fp-002",
    ]);
    for (const id of manifest.sourceBaseline.failedScenarioIds) expect(allIds.has(id)).toBe(true);
  });

  it("normalizes every raw case into the vendor-neutral policy eval schema", () => {
    const normalized = FILES.flatMap((file) => load(file)).map(normalize);

    expect(normalized).toHaveLength(105);
    for (const item of normalized) {
      expect(["allow", "deny"]).toContain(item.expected);
      expect(["command", "path"]).toContain(item.input.type);
      expect(item.input.value.length).toBeGreaterThan(0);
      expect(item.source?.legacyId).toBe(item.id);
    }
  });
});
