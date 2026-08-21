import { describe, expect, it } from "vitest";
import { evaluatePolicySuite, type PolicyEvalCase, type PolicyEvalObservation } from "../../kernel/eval.js";
import { ScopeValidator } from "../../governor/scope.js";
import { loadAcsV1Cases } from "../helpers/acs_corpus.js";

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

describe("canonical policy qualification on ACS v1 corpus", () => {
  it("evaluates all 105 provenance-pinned cases without executing them", () => {
    const cases = loadAcsV1Cases();
    const scope = new ScopeValidator();
    const observations = cases.map((testCase) => observeCanonicalPolicy(testCase, scope));
    const report = evaluatePolicySuite(cases, observations);

    expect(cases).toHaveLength(105);
    expect(observations).toHaveLength(105);
    expect(report.total).toBe(105);
    expect(report.results).toHaveLength(105);
    expect(report.missingObservations).toBe(0);
    expect(report.unexpectedAsks).toBe(0);

    // Diagnostic only in this first qualification pass. The next commit pins
    // these metrics and failure IDs as the canonical-v1 regression baseline.
    console.log("CANONICAL_POLICY_BASELINE", JSON.stringify({
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      falseAllows: report.falseAllows,
      falseDenies: report.falseDenies,
      dangerBlockRate: report.dangerBlockRate,
      falsePositiveRate: report.falsePositiveRate,
      accuracy: report.accuracy,
      failures: report.results.filter((result) => !result.pass).map((result) => ({
        id: result.caseId,
        category: result.category,
        expected: result.expected,
        actual: result.actual,
        kind: result.failureKind,
      })),
    }));
  });
});
