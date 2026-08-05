import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from './config/load-config.js';
import {
  appendArbiterUserToneInstruction,
  readArbiterPrompt,
  readPairedRoomPrompt,
} from './platform-prompts.js';

describe('arbiter user tone', () => {
  const originalValue = process.env.ARBITER_FORCE_POLITE_USER_TONE;

  afterEach(() => {
    if (originalValue === undefined) {
      delete process.env.ARBITER_FORCE_POLITE_USER_TONE;
    } else {
      process.env.ARBITER_FORCE_POLITE_USER_TONE = originalValue;
    }
  });

  it('defaults to enabled and allows explicit opt-out', () => {
    delete process.env.ARBITER_FORCE_POLITE_USER_TONE;
    expect(loadConfig().paired.arbiterForcePoliteUserTone).toBe(true);

    process.env.ARBITER_FORCE_POLITE_USER_TONE = 'false';
    expect(loadConfig().paired.arbiterForcePoliteUserTone).toBe(false);
  });

  it('adds respectful user language while preserving agent directives', () => {
    const prompt = appendArbiterUserToneInstruction('Arbiter rules', true);

    expect(prompt).toContain('The human user is senior to the arbiter');
    expect(prompt).toContain('respectful Korean honorifics');
    expect(prompt).toContain(
      'In every room, address the human user as `사용자님`',
    );
    expect(prompt).toContain('Do not infer relationship-based titles');
    expect(prompt).toContain('Never use casual speech');
    expect(prompt).toContain(
      'Binding directives to the owner and reviewer remain unchanged',
    );
    expect(appendArbiterUserToneInstruction('Arbiter rules', false)).toBe(
      'Arbiter rules',
    );
  });

  it('injects the rule into arbiter prompts but not reviewer prompts', () => {
    const projectRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'rbclaw-arbiter-tone-'),
    );
    const promptsDir = path.join(projectRoot, 'prompts');
    fs.mkdirSync(promptsDir);
    fs.writeFileSync(
      path.join(promptsDir, 'arbiter-paired-room.md'),
      'Arbiter rules',
    );
    fs.writeFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'Reviewer rules',
    );

    try {
      expect(readArbiterPrompt(projectRoot)).toContain(
        'The human user is senior to the arbiter',
      );
      expect(readArbiterPrompt(projectRoot)).toContain(
        'In every room, address the human user as `사용자님`',
      );
      expect(readPairedRoomPrompt('claude-code', projectRoot)).not.toContain(
        'In every room, address the human user as `사용자님`',
      );
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
