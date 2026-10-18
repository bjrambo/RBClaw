export type SettingsAgentType = 'claude-code' | 'codex' | 'glm-code';

export const CODEX_EFFORT_VALUES = [
  '',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
] as const;

export const CLAUDE_EFFORT_VALUES = [
  '',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type EffortValue = (typeof CODEX_EFFORT_VALUES)[number];

export function effortValuesForAgent(
  agentType: SettingsAgentType,
): readonly EffortValue[] {
  if (agentType === 'glm-code') {
    return CLAUDE_EFFORT_VALUES.filter((value) => value !== 'xhigh');
  }
  return agentType === 'claude-code'
    ? CLAUDE_EFFORT_VALUES
    : CODEX_EFFORT_VALUES;
}

export function isEffortSupported(
  agentType: SettingsAgentType | null | undefined,
  effort: string,
): boolean {
  if (!effort) return true;
  if (!agentType) return true;
  return effortValuesForAgent(agentType).includes(effort as EffortValue);
}

export function readSettingsAgentType(
  value: string | undefined,
): SettingsAgentType | null {
  if (value === 'claude-code' || value === 'codex' || value === 'glm-code') {
    return value;
  }
  return null;
}

export function agentTypeForRole(
  role: 'owner' | 'reviewer' | 'arbiter',
  env:
    | Record<string, string | undefined>
    | ((key: string) => string | undefined),
): SettingsAgentType | null {
  const read = typeof env === 'function' ? env : (key: string) => env[key];
  const key =
    role === 'owner'
      ? 'OWNER_AGENT_TYPE'
      : role === 'reviewer'
        ? 'REVIEWER_AGENT_TYPE'
        : 'ARBITER_AGENT_TYPE';
  const raw = read(key);
  if (raw !== undefined) return readSettingsAgentType(raw);
  if (role === 'owner') return 'codex';
  if (role === 'reviewer') return 'claude-code';
  return null;
}
