// AIOS Core — ACS Bridge.
// Connects AIOS Governor to the Agent Constraint System (acs_lite.py).
//
// Flow:
//   AIOS plan → ScopeValidator → ApprovalGateway → ACS Bridge → acs_lite.py
//                                                         ↓
//                                                   scope init
//                                                   lock/unlock
//                                                   violation check
//
// The bridge does NOT bypass ACS. It communicates with ACS as a client.
// ACS remains the runtime enforcement layer (hooks).
// AIOS remains the decision layer (state machine).

import type { Plan, Approval } from "../kernel/schema/index.js";
import { AcsClient } from "./acs_client.js";
import { ACS_DENIED_PATHS } from "./scope.js";

export interface AcsBridgeResult {
  ok: boolean;
  reason?: string;
  acsStatus?: {
    locked: boolean;
    scope: string[];
    violations: { window: number; total: number };
  };
}

export class AcsBridge {
  private readonly client: AcsClient;

  constructor(client?: AcsClient) {
    this.client = client ?? new AcsClient();
  }

  /** Pre-flight check before any plan execution.
   *  1. Is ACS locked?
   *  2. Are any plan files in ACS protected paths?
   *  3. Are all plan files in ACS scope?
   *  4. Are there recent violations approaching lock threshold?
   */
  async preflight(plan: Plan): Promise<AcsBridgeResult> {
    // 1. Lock check
    const locked = await this.client.isLocked();
    if (locked) {
      return {
        ok: false,
        reason: "ACS is locked — cannot execute",
        acsStatus: { locked: true, scope: [], violations: { window: 0, total: 0 } },
      };
    }

    // 2. Protected paths (checked before scope — more specific)
    const protected_ = plan.files.filter((f) => ACS_DENIED_PATHS.some((p) => f.includes(p)));
    if (protected_.length > 0) {
      return {
        ok: false,
        reason: `ACS protected paths: ${protected_.join(", ")}`,
        acsStatus: { locked: false, scope: [], violations: { window: 0, total: 0 } },
      };
    }

    // 3. Scope check
    const acsScope = await this.client.getScope();
    const outOfScope: string[] = [];
    for (const file of plan.files) {
      const inScope = acsScope.some((dir) => file.startsWith(dir));
      if (!inScope) outOfScope.push(file);
    }
    if (outOfScope.length > 0) {
      return {
        ok: false,
        reason: `ACS scope violation: ${outOfScope.join(", ")}`,
        acsStatus: { locked: false, scope: acsScope, violations: { window: 0, total: 0 } },
      };
    }

    // 4. Violation pressure
    const status = await this.client.status();
    const pressure = status.violations.window / status.violations.windowMax;
    if (pressure > 0.8) {
      return {
        ok: false,
        reason: `ACS violation pressure ${(pressure * 100).toFixed(0)}% — approaching lock threshold`,
        acsStatus: {
          locked: false,
          scope: status.dirs,
          violations: { window: status.violations.window, total: status.violations.total },
        },
      };
    }

    return {
      ok: true,
      acsStatus: {
        locked: false,
        scope: status.dirs,
        violations: { window: status.violations.window, total: status.violations.total },
      },
    };
  }

  /** Get current ACS status for display. */
  async status(): Promise<{
    locked: boolean;
    scope: string[];
    violations: { window: number; windowMax: number; total: number; totalMax: number };
  }> {
    const status = await this.client.status();
    return {
      locked: status.locked,
      scope: status.dirs,
      violations: status.violations,
    };
  }

  /** Check if a single path is allowed by ACS. */
  async isPathAllowed(path: string): Promise<boolean> {
    return this.client.isPathInScope(path);
  }
}
