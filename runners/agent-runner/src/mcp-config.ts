import type { McpStdioServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { RBCLAW_ENV } from 'rbclaw-runners-shared';

export interface RbclawMcpServerConfigInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  agentType: string;
  roomRole: string;
  ipcDir?: string;
  hostIpcDir?: string;
}

export function buildRbclawMcpServerConfig(
  mcpServerPath: string,
  input: RbclawMcpServerConfigInput,
): McpStdioServerConfig {
  return {
    command: 'node',
    args: [mcpServerPath],
    alwaysLoad: true,
    env: {
      [RBCLAW_ENV.chatJid]: input.chatJid,
      [RBCLAW_ENV.groupFolder]: input.groupFolder,
      [RBCLAW_ENV.isMain]: input.isMain ? '1' : '0',
      [RBCLAW_ENV.agentType]: input.agentType,
      [RBCLAW_ENV.roomRole]: input.roomRole,
      ...(input.ipcDir && {
        [RBCLAW_ENV.ipcDir]: input.ipcDir,
      }),
      ...(input.hostIpcDir && {
        [RBCLAW_ENV.hostIpcDir]: input.hostIpcDir,
      }),
    },
  };
}
