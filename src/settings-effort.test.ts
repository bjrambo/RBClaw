import { describe, expect, it } from 'vitest';

import { agentTypeForRole, isEffortSupported } from './settings-effort.js';

describe('settings-effort', () => {
  it('maps roles to agent types with defaults', () => {
    expect(agentTypeForRole('owner', {})).toBe('codex');
    expect(agentTypeForRole('reviewer', {})).toBe('claude-code');
    expect(agentTypeForRole('arbiter', {})).toBeNull();
    expect(agentTypeForRole('owner', { OWNER_AGENT_TYPE: 'claude-code' })).toBe(
      'claude-code',
    );
    expect(agentTypeForRole('owner', { OWNER_AGENT_TYPE: 'glm-code' })).toBe(
      'glm-code',
    );
  });

  it('keeps Codex-only efforts out of Claude-compatible agents', () => {
    expect(isEffortSupported('claude-code', 'xhigh')).toBe(false);
    expect(isEffortSupported('claude-code', 'ultra')).toBe(false);
    expect(isEffortSupported('glm-code', 'xhigh')).toBe(false);
    expect(isEffortSupported('glm-code', 'ultra')).toBe(false);
    expect(isEffortSupported('codex', 'xhigh')).toBe(true);
    expect(isEffortSupported('codex', 'ultra')).toBe(true);
    expect(isEffortSupported('claude-code', '')).toBe(true);
  });
});
