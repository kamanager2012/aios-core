import { describe, it, expect } from 'vitest';
import { handleMcpMessage } from '../../cli/mcp_server.js';

describe('AIOS MCP Server Protocol', () => {
  it('handles initialize handshake', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize'
    });
    expect(res.error).toBeUndefined();
    expect(res.result.serverInfo.name).toBe('aios-mcp-server');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists registered AIOS MCP tools', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });
    expect(res.result.tools).toHaveLength(2);
    const names = res.result.tools.map((t: any) => t.name);
    expect(names).toContain('aios_verify_evidence');
    expect(names).toContain('aios_record_audit');
  });

  it('evaluates task evidence with aios_verify_evidence', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'aios_verify_evidence',
        arguments: {
          contract: {
            version: 1,
            requiredEvidence: ['test', 'build'],
            invariants: []
          },
          evidence: [
            { kind: 'test', status: 'pass' },
            { kind: 'build', status: 'pass' }
          ]
        }
      }
    });
    expect(res.error).toBeUndefined();
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.status).toBe('PASS');
  });
});
