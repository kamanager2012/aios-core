/**
 * AIOS Model Context Protocol (MCP) Server
 *
 * Exposes AIOS Evidence Gate, Contract Verification, and Tamper-evident Audit
 * as standard MCP Tools over JSON-RPC (Stdio), compatible with Claude Code, Cursor, Windsurf, etc.
 *
 * Trust boundary: stdio = local trusted principal only. This server has no
 * authN/Z, no network listener, and no provenance signing. Any local process
 * that can write to stdin can call these tools — including recording an
 * arbitrary COMMIT entry. The hash chain below provides tamper *evidence*
 * for entries written through this server instance, not authorship proof.
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateReliability } from '../kernel/reliability.js';
import type { TaskContract, EvidenceItem, Decision } from '../kernel/schema/index.js';
import { AuditLog } from '../governor/audit.js';
import { MemoryStore } from '../memory/index.js';
import { HashChain, verifyChain } from '../kernel/statehash.js';

interface McpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: any;
}

interface McpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

// Default root is unpredictable per process (mkdtemp 0700). AuditLog now waits
// for seq recovery before the first append, but two processes sharing one
// directory can still collide on files. Set AIOS_MCP_AUDIT_ROOT to pin a
// single trusted instance.
function resolveAuditRoot(): string {
  if (process.env.AIOS_MCP_AUDIT_ROOT) return process.env.AIOS_MCP_AUDIT_ROOT;
  return mkdtempSync(join(tmpdir(), 'aios-mcp-audit-'));
}

const auditMemory = new MemoryStore({ root: resolveAuditRoot() });
const auditLog = new AuditLog({
  memory: auditMemory,
  now: () => new Date().toISOString(),
  newId: randomUUID,
});
const auditHashChain = new HashChain();

// Exported for tests / introspection (fingerprint of MCP audit chain).
export function __getAuditHashChain(): HashChain {
  return auditHashChain;
}

const TOOLS = [
  {
    name: 'aios_verify_evidence',
    description: 'Verify software engineering task outcome evidence against strict contract acceptance criteria (Fail-Closed gate).',
    inputSchema: {
      type: 'object',
      properties: {
        contract: {
          type: 'object',
          description: 'Task acceptance contract defining required evidence, minimum passing tests, and required invariants.'
        },
        evidence: {
          type: 'array',
          description: 'Collected evidence items (test, build, diff, invariant).'
        }
      },
      required: ['contract', 'evidence']
    }
  },
  {
    name: 'aios_record_audit',
    description: 'Append a task phase-transition entry into the sequence-stamped, hash-chained AIOS audit log (per Charter §7). Stdio local-trusted only; entries are not signed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task identifier this entry belongs to.' },
        phase: {
          type: 'string',
          enum: ['IDLE', 'PLAN', 'EXECUTE', 'VERIFY', 'COMMIT', 'DONE', 'ROLLBACK'],
          description: 'Lifecycle phase this entry records.'
        },
        decision: {
          type: 'string',
          enum: ['COMMIT', 'ROLLBACK'],
          description: 'Optional COMMIT/ROLLBACK decision associated with this entry.'
        },
        note: { type: 'string', description: 'Human-readable summary stored on the entry.' }
      },
      required: ['taskId', 'phase']
    }
  }
];

const EVIDENCE_KINDS = new Set(['build', 'test', 'lint', 'e2e', 'diff', 'invariant', 'policy', 'artifact']);
const EVIDENCE_STATUSES = new Set(['pass', 'fail', 'missing']);
const MAX_EVIDENCE = 100;
const MAX_TEXT = 8192;
const MAX_TASK_ID = 256;

function invalidParams(id: number | string, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid params: ${message}` } };
}

function validateContract(c: any): string | null {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return 'contract must be an object';
  if (c.version !== 1) return 'contract.version must be 1';
  if (!Array.isArray(c.requiredEvidence)) return 'contract.requiredEvidence must be an array';
  for (const k of c.requiredEvidence) {
    if (!EVIDENCE_KINDS.has(k)) return `contract.requiredEvidence unknown kind: ${String(k).slice(0, 40)}`;
  }
  if (c.invariants !== undefined && !Array.isArray(c.invariants)) return 'contract.invariants must be an array';
  if (c.acceptance !== undefined) {
    if (!c.acceptance || typeof c.acceptance !== 'object') return 'contract.acceptance must be an object';
    if (c.acceptance.minTestsPassed !== undefined && (typeof c.acceptance.minTestsPassed !== 'number' || c.acceptance.minTestsPassed < 0)) {
      return 'contract.acceptance.minTestsPassed must be a non-negative number';
    }
  }
  return null;
}

function validateEvidence(ev: any): string | null {
  if (!Array.isArray(ev)) return 'evidence must be an array';
  if (ev.length > MAX_EVIDENCE) return `evidence exceeds ${MAX_EVIDENCE} items`;
  for (const item of ev) {
    if (!item || typeof item !== 'object') return 'evidence item must be an object';
    if (!EVIDENCE_KINDS.has(item.kind)) return `evidence unknown kind: ${String(item.kind).slice(0, 40)}`;
    if (!EVIDENCE_STATUSES.has(item.status)) return `evidence bad status: ${String(item.status).slice(0, 40)}`;
    if (item.summary !== undefined) {
      if (typeof item.summary !== 'string' || item.summary.length > MAX_TEXT) return 'evidence summary must be string <= 8192 chars';
    }
  }
  return null;
}

export async function handleMcpMessage(msg: McpRequest): Promise<McpResponse> {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aios-mcp-server', version: '1.0.0' }
      }
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS }
    };
  }

  if (method === 'tools/call') {
    if (!params || typeof params !== 'object') {
      return invalidParams(id, 'params is required');
    }
    const { name, arguments: args } = params as { name?: string; arguments?: any };
    if (typeof name !== 'string' || !name) {
      return invalidParams(id, 'tool name is required');
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return invalidParams(id, 'arguments must be an object');
    }

    if (name === 'aios_verify_evidence') {
      const cErr = validateContract(args.contract);
      if (cErr) return invalidParams(id, cErr);
      const eErr = validateEvidence(args.evidence);
      if (eErr) return invalidParams(id, eErr);
      const verdict = evaluateReliability(args.contract as TaskContract, args.evidence as EvidenceItem[]);
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(verdict, null, 2)
            }
          ]
        }
      };
    }

    if (name === 'aios_record_audit') {
      if (typeof args.taskId !== 'string' || !args.taskId || args.taskId.length > MAX_TASK_ID) {
        return invalidParams(id, 'taskId must be non-empty string <= 256 chars');
      }
      if (typeof args.phase !== 'string' || !['IDLE', 'PLAN', 'EXECUTE', 'VERIFY', 'COMMIT', 'DONE', 'ROLLBACK'].includes(args.phase)) {
        return invalidParams(id, 'phase must be one of IDLE/PLAN/EXECUTE/VERIFY/COMMIT/DONE/ROLLBACK');
      }
      if (args.decision !== undefined && !['COMMIT', 'ROLLBACK'].includes(args.decision)) {
        return invalidParams(id, 'decision must be COMMIT or ROLLBACK');
      }
      if (args.note !== undefined && (typeof args.note !== 'string' || args.note.length > MAX_TEXT)) {
        return invalidParams(id, 'note must be string <= 8192 chars');
      }
      const at = new Date().toISOString();
      await auditLog.append({
        at,
        taskId: args.taskId,
        phase: args.phase,
        ...(args.decision ? { decision: args.decision as Decision } : {}),
        ...(args.note ? { result: args.note } : {}),
      });
      const entry = auditLog.bySeq(auditLog.seq());
      // Hash-chain binding: every MCP-written entry is chained + verified.
      if (entry) {
        await auditHashChain.append(entry);
        const check = await verifyChain(auditHashChain.getChain(), auditLog.all());
        if (!check.valid) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32003, message: `audit chain invalid after append: ${check.message}` }
          };
        }
      }
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(entry, null, 2)
            }
          ]
        }
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: `Tool not found: ${name}` }
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` }
  };
}

export function startMcpServer() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    if (line.length > 1_000_000) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: line exceeds 1MB limit' }
        }) + '\n'
      );
      return;
    }
    try {
      const request: McpRequest = JSON.parse(line);
      const response = await handleMcpMessage(request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch (e: any) {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `Parse error: ${e.message}` }
        }) + '\n'
      );
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startMcpServer();
}
