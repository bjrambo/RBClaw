import { normalizePairedRoomRole } from 'rbclaw-runners-shared';

export function resolveCurrentAgentType(
  agentType: string,
): 'claude-code' | 'codex' | 'glm-code' {
  return agentType === 'codex'
    ? 'codex'
    : agentType === 'glm-code'
      ? 'glm-code'
      : 'claude-code';
}

export function resolveCurrentRoomRole(roomRole: string | undefined) {
  return normalizePairedRoomRole(roomRole);
}
