import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  comparePolicyEvalResults,
  evaluatePolicySuite,
  type PolicyEvalCase,
  type PolicyEvalObservation,
  type PolicyEvalResult,
} from "../../kernel/eval.js";
import { ScopeValidator } from "../../governor/scope.js";
import { loadAcsV1Cases } from "../helpers/acs_corpus.js";

interface StoredBaseline {
  metrics: { falseAllows: number; falseDenies: number };
  falseAllowIds: string[];
  falseDenyIds: string[];
}

function loadBaseline(): StoredBaseline {
  return JSON.parse(
    readFileSync(
      join(process.cwd(), "shadow", "evals", "policy", "canonical-v1", "baseline.json"),
      "utf8",
    ),
  ) as StoredBaseline;
}

function observe(testCase: PolicyEvalCase, scope: ScopeValidator): PolicyEvalObservation {
  if (testCase.input.type === "path") {
    const allowed = scope.validatePath(testCase.input.value) && scope.validateFileType(testCase.input.value);
    return { caseId: testCase.id, actual: allowed ? "allow" : "deny" };
  }

  const command = testCase.input.value;
  if (!scope.validateCommand(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.isMassDelete(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.commandTargetsDeniedPath(command)) return { caseId: testCase.id, actual: "deny" };
  if (scope.usesElevatedCommand(command)) return { caseId: testCase.id, actual: "ask" };
  return { caseId: testCase.id, actual: "allow" };
}

function storedBaselineResults(cases: PolicyEvalCase[], baseline: StoredBaseline): PolicyEvalResult[] {
  const falseAllows = new Set(baseline.falseAllowIds);
  const falseDenies = new Set(baseline.falseDenyIds);

  return cases.map((testCase) => {
    if (falseAllows.has(testCase.id)) {
      return {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: "allow",
        pass: false,
        severity: testCase.severity,
        failureKind: "false_allow",
      };
    }
    if (falseDenies.has(testCase.id)) {
      return {
        caseId: testCase.id,
        category: testCase.category,
        expected: testCase.expected,
        actual: "deny",
        pass: false,
        severity: testCase.severity,
        failureKind: "false_deny",
      };
    }
    return {
      caseId: testCase.id,
      category: testCase.category,
      expected: testCase.expected,
      actual: testCase.expected,
      pass: true,
      severity: testCase.severity,
    };
  });
}

describe("canonical default policy hardening", () => {
  it("improves the stored baseline without introducing a PASS-to-FAIL regression", () => {
    const cases = loadAcsV1Cases();
    const baseline = loadBaseline();
    const baselineResults = storedBaselineResults(cases, baseline);
    const scope = new ScopeValidator();
    const candidate = evaluatePolicySuite(cases, cases.map((testCase) => observe(testCase, scope)));
    const comparison = comparePolicyEvalResults(baselineResults, candidate.results);

    expect(comparison.regressions).toEqual([]);
    expect(candidate.missingObservations).toBe(0);
    expect(candidate.unexpectedAsks).toBe(0);
    expect(candidate.falseAllows).toBeLessThan(baseline.metrics.falseAllows);
    expect(candidate.falseDenies).toBe(baseline.metrics.falseDenies);

    console.log("CANONICAL_POLICY_HARDENING", JSON.stringify({
      total: candidate.total,
      passed: candidate.passed,
      failed: candidate.failed,
      falseAllows: candidate.falseAllows,
      falseDenies: candidate.falseDenies,
      dangerBlockRate: candidate.dangerBlockRate,
      falsePositiveRate: candidate.falsePositiveRate,
      accuracy: candidate.accuracy,
      improvements: comparison.improvements.map((change) => change.caseId),
      regressions: comparison.regressions.map((change) => change.caseId),
      remainingFailures: candidate.results.filter((result) => !result.pass).map((result) => ({
        id: result.caseId,
        kind: result.failureKind,
      })),
    }));
  });
});
