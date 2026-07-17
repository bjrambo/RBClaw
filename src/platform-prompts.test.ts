import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENT_LANGUAGE } from './config.js';
import {
  getCustomPromptPath,
  getPairedRoomPromptPath,
  getPlatformPromptPath,
  readCustomPrompt,
  readPairedRoomPrompt,
  readPlatformPrompt,
} from './platform-prompts.js';

describe('platform-prompts', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rbclaw-prompts-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns undefined when the prompt file is missing', () => {
    expect(readPlatformPrompt('claude-code')).toBeUndefined();
  });

  it('reads the local custom prompt when present', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'CUSTOM.md'), '\nLocal rules\n');

    expect(getCustomPromptPath()).toBe(path.join(promptsDir, 'CUSTOM.md'));
    expect(readCustomPrompt()).toBe('Local rules');
  });

  it('ignores missing or empty local custom prompts', () => {
    expect(readCustomPrompt()).toBeUndefined();

    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(path.join(promptsDir, 'CUSTOM.md'), '  \n');

    expect(readCustomPrompt()).toBeUndefined();
  });

  it('reads and trims provider-specific prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'codex-platform.md'),
      '\nCodex platform prompt\n',
    );

    expect(getPlatformPromptPath('codex')).toBe(
      path.join(promptsDir, 'codex-platform.md'),
    );
    expect(readPlatformPrompt('codex')).toBe('Codex platform prompt');
  });

  it('reads and trims paired-room prompt files', () => {
    const promptsDir = path.join(tempDir, 'prompts');
    fs.mkdirSync(promptsDir, { recursive: true });
    fs.writeFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      '\nClaude paired prompt\n',
    );

    expect(getPairedRoomPromptPath('claude-code')).toBe(
      path.join(promptsDir, 'claude-paired-room.md'),
    );
    const expected = AGENT_LANGUAGE
      ? `Claude paired prompt\n\n## Language\n\nAlways respond in ${AGENT_LANGUAGE}.`
      : 'Claude paired prompt';
    expect(readPairedRoomPrompt('claude-code')).toBe(expected);
  });

  it('maps Codex paired-room prompts to the shared reviewer prompt while preserving failover identity wording', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );

    expect(getPairedRoomPromptPath('codex', repoRoot)).toBe(
      path.join(repoRoot, 'prompts', 'claude-paired-room.md'),
    );

    const codexPairedPrompt = readPairedRoomPrompt('codex', repoRoot);
    expect(codexPairedPrompt).toContain('reviewer');
    expect(codexPairedPrompt).toContain('the output is invalid');
    expect(codexPairedPrompt).toContain('RBCLAW_WORK_DIR');
    expect(codexPairedPrompt).toContain(
      'primary verification root for this turn, not the only readable target',
    );
    expect(codexPairedPrompt).toContain(
      'suggest 1-2 better alternatives with the reason and tradeoff for each',
    );
    expect(codexPairedPrompt).toContain(
      'Separate correctness issues from improvement ideas',
    );
    expect(codexPairedPrompt).toContain(
      'Do not present static analysis as completed verification',
    );
    expect(codexPairedPrompt).toContain('Keep reviewer output owner-facing');
    expect(codexPairedPrompt).toContain('prefer 3-6 lines');
    expect(codexPairedPrompt).not.toContain('owner-side paired agent');

    const failoverPlatformPrompt = fs.readFileSync(
      path.join(repoRoot, 'prompts', 'codex-review-failover-platform.md'),
      'utf-8',
    );
    expect(failoverPlatformPrompt).toContain('acting as `클코`');
  });

  it('separates the owner default cwd from authorized external access while keeping review read-only', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'utf-8',
    );
    const reviewerPrompt = fs.readFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'utf-8',
    );
    const arbiterPrompt = fs.readFileSync(
      path.join(promptsDir, 'arbiter-paired-room.md'),
      'utf-8',
    );

    expect(ownerPrompt).toContain('not as an owner access boundary');
    expect(ownerPrompt).toContain('SSH, SFTP, FTP, or remote services');
    expect(ownerPrompt).toContain('Report every external path or host touched');
    expect(ownerPrompt).not.toContain('Do not read or write sibling projects');
    expect(reviewerPrompt).toContain(
      'every local path that the owner reports touching',
    );
    expect(reviewerPrompt).toContain('Keep all verification read-only');
    expect(arbiterPrompt).toContain(
      'every external local path the owner reports touching',
    );
  });

  it('keeps the superpowers-derived debugging guidance compressed and role-scoped', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'utf-8',
    );
    const reviewerPrompt = fs.readFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'utf-8',
    );

    for (const prompt of [ownerPrompt, reviewerPrompt]) {
      expect(prompt).toContain('## Debugging discipline');
      expect(prompt).toContain('root-cause');
      expect(prompt).toContain('component-boundary data');
      expect(prompt).toContain('symptom');
      expect(prompt).toContain('same failed fix path');
      expect(prompt).toContain('3 times');
      expect(prompt).not.toContain('superpowers');
      expect(prompt).not.toContain('NO FIXES WITHOUT ROOT CAUSE');
      expect(prompt).not.toContain('The Four Phases');
    }
  });

  it('keeps file-backed note guidance optional and lightweight', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-paired-room.md'),
      'utf-8',
    );
    const reviewerPrompt = fs.readFileSync(
      path.join(promptsDir, 'claude-paired-room.md'),
      'utf-8',
    );

    for (const prompt of [ownerPrompt, reviewerPrompt]) {
      expect(prompt).toContain('## Durable work notes');
      expect(prompt).toContain('multi-step plans');
      expect(prompt).toContain('long debugging evidence');
      expect(prompt).toContain('existing docs/plans location');
      expect(prompt).toContain('tradeoff');
      expect(prompt).toContain('pasted');
      expect(prompt).not.toContain('docs/superpowers');
      expect(prompt).not.toContain('Every plan MUST');
      expect(prompt).not.toContain('Task-size gate');
    }
  });

  it('keeps Codex prompts focused on prompt and skill compliance before high-impact work', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const codexPrompt = fs.readFileSync(
      path.join(promptsDir, 'codex-platform.md'),
      'utf-8',
    );
    const ownerPrompt = fs.readFileSync(
      path.join(promptsDir, 'owner-common-platform.md'),
      'utf-8',
    );

    for (const prompt of [codexPrompt, ownerPrompt]) {
      expect(prompt).toContain('## Prompt and Skill Compliance');
      expect(prompt).toContain('Re-read the matching section');
      expect(prompt).toContain("open that skill's `SKILL.md`");
      expect(prompt).toContain('compaction summaries override');
      expect(prompt).toContain('find and apply that prompt/skill first');
      expect(prompt).toContain('Treat this as your responsibility');
      expect(prompt).toContain('before guessing a workaround');
      expect(prompt).toContain('Clear authorization to finish the task');
      expect(prompt).toContain('does not skip high-risk checkpoints');
    }
  });

  it('keeps personal owner rules out of tracked platform prompts', () => {
    const repoRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const promptsDir = path.join(repoRoot, 'prompts');
    const trackedPrompts = [
      'codex-platform.md',
      'owner-common-platform.md',
      'claude-platform.md',
    ].map((filename) =>
      fs.readFileSync(path.join(promptsDir, filename), 'utf-8'),
    );

    for (const prompt of trackedPrompts) {
      expect(prompt).not.toMatch(/^## .*Persona.*$/m);
      expect(prompt).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
      expect(prompt).not.toContain('## Workspace Path Rules');
      expect(prompt).not.toContain('## SSH Access Profile Rules');
    }

    const examplePrompt = fs.readFileSync(
      path.join(promptsDir, 'CUSTOM.example.md'),
      'utf-8',
    );
    expect(examplePrompt).toContain('prompts/CUSTOM.md');
    expect(examplePrompt).not.toMatch(/\/home\/[A-Za-z0-9._-]+/);
  });
});
