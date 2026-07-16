import { describe, expect, it } from 'vitest';
import { RBCLAW_ENV } from 'rbclaw-runners-shared';

import { buildRbclawMcpServerConfig } from '../src/mcp-config.js';

describe('rbclaw MCP config', () => {
  it('always loads RBClaw MCP tools on turn one and preserves runtime env', () => {
    expect(
      buildRbclawMcpServerConfig('/runner/dist/ipc-mcp-stdio.js', {
        chatJid: 'dc:room',
        groupFolder: 'rbclaw',
        isMain: true,
        agentType: 'claude-code',
        roomRole: 'reviewer',
        ipcDir: '/tmp/ipc/task',
        hostIpcDir: '/tmp/ipc/host',
      }),
    ).toEqual({
      command: 'node',
      args: ['/runner/dist/ipc-mcp-stdio.js'],
      alwaysLoad: true,
      env: {
        [RBCLAW_ENV.chatJid]: 'dc:room',
        [RBCLAW_ENV.groupFolder]: 'rbclaw',
        [RBCLAW_ENV.isMain]: '1',
        [RBCLAW_ENV.agentType]: 'claude-code',
        [RBCLAW_ENV.roomRole]: 'reviewer',
        [RBCLAW_ENV.ipcDir]: '/tmp/ipc/task',
        [RBCLAW_ENV.hostIpcDir]: '/tmp/ipc/host',
      },
    });
  });

  it('keeps RBClaw MCP always loaded for Codex fallback subagent sessions', () => {
    expect(
      buildRbclawMcpServerConfig('/runner/dist/ipc-mcp-stdio.js', {
        chatJid: 'dc:room',
        groupFolder: 'rbclaw',
        isMain: false,
        agentType: 'codex',
        roomRole: 'owner',
        ipcDir: '/tmp/ipc/task',
        hostIpcDir: '/tmp/ipc/host',
      }),
    ).toMatchObject({
      command: 'node',
      args: ['/runner/dist/ipc-mcp-stdio.js'],
      alwaysLoad: true,
      env: {
        [RBCLAW_ENV.chatJid]: 'dc:room',
        [RBCLAW_ENV.groupFolder]: 'rbclaw',
        [RBCLAW_ENV.isMain]: '0',
        [RBCLAW_ENV.agentType]: 'codex',
        [RBCLAW_ENV.roomRole]: 'owner',
        [RBCLAW_ENV.ipcDir]: '/tmp/ipc/task',
        [RBCLAW_ENV.hostIpcDir]: '/tmp/ipc/host',
      },
    });
  });
});
