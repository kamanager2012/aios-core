/**
 * AIOS Model Context Protocol (MCP) Server
 * 
 * Exposes AIOS Evidence Gate, Contract Verification, and Tamper-evident Audit
 * as standard MCP Tools over JSON-RPC (Stdio), compatible with Claude Code, Cursor, Windsurf, etc.
 */

import * as readline from 'node:readline';
import { evaluateReliability } from '../kernel/reliability.js';
import type { TaskContract, EvidenceItem } from '../kernel/schema/index.js';
import { AuditLog } from '../governor/audit.js';

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

const auditLog = new AuditLog('/tmp/aios_mcp_audit.jsonl');

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
    description: 'Append an operation / approval decision into the tamper-evident cryptographic audit chain.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Action performed' },
        details: { type: 'object', description: 'Detailed metadata' },
        verdict: { type: 'string', enum: ['allow', 'deny', 'ask'] }
      },
      required: ['action', 'verdict']
    }
  }
];

export async function handleMcpMessage(msg: McpRequest): Promise<McpResponse> {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'aios-mcp-server', version: '0.2.0' }
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
    const { name, arguments: args } = params || {};

    if (name === 'aios_verify_evidence') {
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
      const entry = await auditLog.record({
        action: args.action,
        verdict: args.verdict,
        details: args.details || {},
        timestamp: Date.now()
      });
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
