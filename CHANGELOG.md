# Changelog

All notable changes to AIOS Core are documented here. This project has not
yet been published to npm (the `aios-core` name on npm belongs to SynkraAI);
the version below is a local release candidate, not an npm release.

The format follows Keep a Changelog (Unreleased + versioned sections).

## [1.0.0] — candidate (prepared, not tagged, not on npm)

Intended tag: `v1.0.0`. This is the first locally-packable candidate of the
independent AIOS Core kernel. It contains the reliability kernel plus the
P0 governance, rollback/MCP, hardening, and release rounds.

### Breaking changes (vs pre-candidate tip-of-master)

- **Tier semantics corrected to SPEC**: Tier 0/1 now return reconciler
  `COMMIT` as a would-commit and never promote memory (`memoryCommitted=false`).
  Previously Tier 0/1 wrote tasks/decisions/snapshots to `current/`.
  Undefined tier defaults to 2 (production) for backward compatibility.
- **Rollback restores `plan.files`**: `restore()` with `planFiles` is now
  wired; scope-rejected `plan.files` containing shell-unsafe names are
  rejected before execution.
- **Policy denies extended**: `node -e/--eval/-p`, `python3 -m/-i`, `npm exec`
  added to `deniedCommands` (105-case corpus metrics unchanged: 92/13/0 FA/13 FD).
- **Package layout**: consumers now import from `dist/` (`main`/`bin`/`exports`
  point at built `.js`), not from `.ts` sources. `files` ships `dist/` only.
- **Hash chain**: `canonicalJson` now sorts keys by codepoint (locale-independent)
  instead of `localeCompare`. Chain heads are still runtime-only; persisted
  heads from old code are not comparable.

### Added

- CLI `--contract <json|file>` for enforcing the evidence gate; legacy tasks
  warn to stderr but still accept on verify-pass (SPEC `LEGACY_COMPATIBILITY`).
- MCP stdio server surface: `aios_verify_evidence` and `aios_record_audit`,
  with inline trust-boundary notes (local trusted principal only, unsigned).
- Build + pack tooling: `tsconfig.build.json`, `npm run build`, `prepack`,
  `npm pack --dry-run` CI verification, SHA-pinned Actions and 15m timeouts.
- `CHANGELOG.md` and version alignment (MCP `serverInfo` now `1.0.0`).

### Changed

- PLAN gate enforces `effectiveApproval` (protected paths force `MANUAL`
  even when the model wrote `AUTO`) and a four-signal command gate
  (`validateCommand` / `isMassDelete` / `commandTargetsDeniedPath` /
  `usesElevatedCommand`). Generic non-shell steps remain allowed.
- `cli/aios.ts` injects a strict `HashChain` in `makeRuntimeDeps`; `replay`
  compares decisions/terminality (no lossy projection divergence).
- Lockfile converged to `package-lock.json` (`pnpm-lock.yaml` removed).

### Fixed

- Rollback shell injection: paths and commit hashes are whitelist-validated;
  optional `runCommandFile` (argv, no shell) is preferred.
- Commit promotion is atomic (`try/catch` → snapshot/file restore + `ROLLBACK`
  with incident); staging clear is per-task (`clearStagingTask`).
- MCP inputs are bounded and validated (`evidence≤100`, text≤8KB,
  line≤1MB) and every written entry is hash-chained (`verifyChain`).
- Scope quoted-flag bypass: `python3 "-c"` / `git push "--force"` now deny;
  `echo "rm -rf /"` stays allow. `validateFileType` now trims.
- Memory traversal (`..`/absolute) rejected; `maxTotalBytes` enforced;
  snapshot round-trip no longer double-encodes raw text and includes nested
  `current/` files.
- Codex observations redact common secret shapes (`Bearer`, `sk-…`, flags)
  from `command`/`webSearch`/`agentMessage` before persistence.
- ACS scope uses segment-boundary matching; empty `allowed_dirs` entries
  no longer allow everything.

## [Unreleased]

- Legacy byte-identity: `manifest.json` now pins SHA-256 for all six raw
  files; semantic verification (105 IDs + command/filepath/expected) passes
  against legacy commit `a8e41fa2`. Byte identity is not claimed (formatter
  differences only).
- `npm audit` real-machine (via public registry): 13 → 10 after semver-safe
  `npm audit fix`. Residuals are dev-only (`vitest` critical needs v5,
  `madge` moderate via `minimatch` needs v7); `files` ships `dist/` only so
  runtime exposure is zero, but `security-audit.yml` (moderate) will fail
  until those majors land.
