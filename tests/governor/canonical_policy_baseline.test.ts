import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { evaluatePolicySuite, type PolicyEvalCase, type PolicyEvalObservation } from "../../kernel/eval.js";
import { ScopeValidator } from "../../governor/scope.js";
import { loadAcsV1Cases } from "../helpers/acs_corpus.js";

interface CanonicalBaseline {
  schemaVersion: number;
  profile: string;
  policySemanticsCommit: string;
  sourceCorpus: { name: string; commit: string; totalCases: number };
  metrics: {
    passed: number;
    failed: number;
    falseAllows: number;
    falseDenies: number;
    unexpectedAsks: number;
    missingObservations: number;
    dangerBlockRate: number;
    falsePositiveRate: number;
    accuracy: number;
  };
  falseAllowIds: string[];
  falseDenyIds: string[];
}

function observeCanonicalPolicy(
  testCase: PolicyEvalCase,
  scope: ScopeValidator,
): PolicyEvalObservation {
  if (testCase.input.type === "path") {
    const allowed = scope.validatePath(testCase.input.value) && scope.validateFileType(testCase.input.value);
    return {
      caseId: testCase.id,
      actual: allowed ? "allow" : "deny",
      reason: allowed ? "canonical path policy allowed" : "canonical path policy denied",
    };
  }

  const command = testCase.input.value;
  if (!scope.validateCommand(command)) {
    return { caseId: testCase.id, actual: "deny", reason: "canonical command policy denied" };
  }
  if (scope.isMassDelete(command)) {
    return { caseId: testCase.id, actual: "deny", reason: "canonical mass-delete signal" };
  }
  if (scope.commandTargetsDeniedPath(command)) {
    return { caseId: testCase.id, actual: "deny", reason: "canonical write-target policy denied" };
  }
  if (scope.usesElevatedCommand(command)) {
    return { caseId: testCase.id, actual: "ask", reason: "canonical elevated-command signal" };
  }
  return { caseId: testCase.id, actual: "allow", reason: "canonical command policy allowed" };
}

function loadBaseline(): CanonicalBaseline {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "shadow", "evals", "policy", "canonical-v1", "baseline.json"),
      "utf8",
    ),
  ) as CanonicalBaseline;
}

describe("canonical policy qualification on ACS v1 corpus", () => {
  it("matches the pinned canonical-v1 baseline without executing corpus commands", () => {
    const cases = loadAcsV1Cases();
    const baseline = loadBaseline();
    const scope = new ScopeValidator();
    const observations = cases.map((testCase) => observeCanonicalPolicy(testCase, scope));
    const report = evaluatePolicySuite(cases, observations);

    expect(baseline.schemaVersion).toBe(1);
    expect(baseline.policySemanticsCommit).toBe("aa927b7ef1488133b94bde274121281d6c0b0797");
    expect(baseline.sourceCorpus.name).toBe("acs-v1");
    expect(baseline.sourceCorpus.totalCases).toBe(105);

    expect(cases).toHaveLength(105);
    expect(observations).toHaveLength(105);
    expect(report.total).toBe(105);
    expect(report.results).toHaveLength(105);

    expect({
      passed: report.passed,
      failed: report.failed,
      falseAllows: report.falseAllows,
      falseDenies: report.falseDenies,
      unexpectedAsks: report.unexpectedAsks,
      missingObservations: report.missingObservations,
      dangerBlockRate: report.dangerBlockRate,
      falsePositiveRate: report.falsePositiveRate,
      accuracy: report.accuracy,
    }).toEqual(baseline.metrics);

    const falseAllowIds = report.results
      .filter((result) => result.failureKind === "false_allow")
      .map((result) => result.caseId);
    const falseDenyIds = report.results
      .filter((result) => result.failureKind === "false_deny")
      .map((result) => result.caseId);

    expect(falseAllowIds).toEqual(baseline.falseAllowIds);
    expect(falseDenyIds).toEqual(baseline.falseDenyIds);
  });
});
