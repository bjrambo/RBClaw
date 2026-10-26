import { describe, expect, it } from 'vitest';

import {
  PRESET_MODELS,
  buildModelOptions,
  effortValuesForAgent,
  formatEffortOption,
  isEffortSupported,
  isPresetModel,
} from './settings-options';

describe('settings-options effort', () => {
  it('includes xhigh but not ultra for Claude Code', () => {
    expect(effortValuesForAgent('claude-code')).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(isEffortSupported('claude-code', 'xhigh')).toBe(true);
    expect(isEffortSupported('claude-code', 'ultra')).toBe(false);
    expect(isEffortSupported('claude-code', 'high')).toBe(true);
  });

  it('keeps xhigh and ultra unavailable for GLM', () => {
    expect(effortValuesForAgent('glm-code')).toEqual([
      '',
      'low',
      'medium',
      'high',
      'max',
    ]);
    expect(isEffortSupported('glm-code', 'xhigh')).toBe(false);
    expect(isEffortSupported('glm-code', 'ultra')).toBe(false);
    expect(isEffortSupported('glm-code', 'high')).toBe(true);
  });

  it('allows xhigh and ultra for Codex agents', () => {
    expect(effortValuesForAgent('codex')).toContain('xhigh');
    expect(effortValuesForAgent('codex')).toContain('ultra');
    expect(isEffortSupported('codex', 'xhigh')).toBe(true);
    expect(isEffortSupported('codex', 'ultra')).toBe(true);
  });

  it('shows raw effort keys beside localized labels', () => {
    expect(formatEffortOption('high', '높음')).toBe('높음 (high)');
    expect(formatEffortOption('ultra', '울트라')).toBe('울트라 (ultra)');
    expect(formatEffortOption('', '기본값')).toBe('기본값');
  });
});

describe('settings-options models', () => {
  it('offers Claude Opus 5.5 and 4.8 presets', () => {
    expect(PRESET_MODELS.claude).toEqual([
      'claude-opus-5-5',
      'claude-opus-4-8',
    ]);
    expect(buildModelOptions('')).toContain('claude-opus-5-5');
    expect(buildModelOptions('')).toContain('claude-opus-4-8');
    expect(isPresetModel('claude-opus-5-5')).toBe(true);
    expect(isPresetModel('claude-opus-4-8')).toBe(true);
    expect(isPresetModel('claude-opus-4-7')).toBe(false);
    expect(isPresetModel('claude-opus-4-6')).toBe(false);
  });
});
