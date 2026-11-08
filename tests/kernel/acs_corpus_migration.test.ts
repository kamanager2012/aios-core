import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACS_V1_EXPECTED_COUNTS,
  ACS_V1_FILES,
  ACS_V1_ROOT,
  loadAcsV1Cases,
  loadLegacyAcsFile,
} from "../helpers/acs_corpus.js";

describe("ACS v1 corpus migration", () => {
  it("preserves all 105 source scenarios with stable unique IDs", () => {
    const all = ACS_V1_FILES.flatMap((file) => loadLegacyAcsFile(file));
    expect(all).toHaveLength(105);
    expect(new Set(all.map((item) => item.id)).size).toBe(105);

    for (const file of ACS_V1_FILES) {
      expect(loadLegacyAcsFile(file)).toHaveLength(ACS_V1_EXPECTED_COUNTS[file]);
    }
  });

  it("matches the pinned manifest baseline (incl. raw hashes)", () => {
    const manifest = JSON.parse(readFileSync(join(ACS_V1_ROOT, "manifest.json"), "utf8")) as {
      sourceBaseline: { totalScenarios: number; failedScenarioIds: string[] };
      source: { commit: string };
      rawFilesSha256?: Record<string, string>;
    };
    if (manifest.rawFilesSha256) {
      for (const [rel, expected] of Object.entries(manifest.rawFilesSha256)) {
        const bytes = readFileSync(join(ACS_V1_ROOT, rel), "utf8");
        // Hash the exact file bytes as read (text round-trip preserves UTF-8).
        const actual = createHash("sha256").update(bytes, "utf8").digest("hex");
        expect(actual).toBe(expected);
      }
    } else {
      throw new Error("manifest.rawFilesSha256 missing");
    }
    const allIds = new Set(ACS_V1_FILES.flatMap((file) => loadLegacyAcsFile(file)).map((item) => item.id));

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
    const normalized = loadAcsV1Cases();

    expect(normalized).toHaveLength(105);
    for (const item of normalized) {
      expect(["allow", "deny"]).toContain(item.expected);
      expect(["command", "path"]).toContain(item.input.type);
      expect(item.input.value.length).toBeGreaterThan(0);
      expect(item.source?.legacyId).toBe(item.id);
    }
  });
});
