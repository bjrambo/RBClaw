import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';

import { registerHostEvidenceTools } from '../src/ipc-host-evidence-tool.js';

function registeredTools(roomRole?: string): string[] {
  const names: string[] = [];
  const server = {
    tool: vi.fn((name: string) => {
      names.push(name);
    }),
  } as unknown as McpServer;
  registerHostEvidenceTools({
    server,
    tasksDir: '/tmp/tasks',
    responseDir: '/tmp/responses',
    groupFolder: 'room-folder',
    roomRole,
    pairedTaskId: 'task-1',
    writeIpcFile: vi.fn(() => 'request.json'),
  });
  return names;
}

describe('remote inspection MCP registration', () => {
  it('registers inspect_remote only for the reviewer role', () => {
    expect(registeredTools('reviewer')).toContain('inspect_remote');
    expect(registeredTools('owner')).not.toContain('inspect_remote');
    expect(registeredTools('arbiter')).not.toContain('inspect_remote');
  });
});
