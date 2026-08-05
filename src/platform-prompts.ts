import fs from 'fs';
import path from 'path';

import { AGENT_LANGUAGE, ARBITER_FORCE_POLITE_USER_TONE } from './config.js';
import type { AgentType } from './types.js';

function appendLanguageInstruction(prompt: string): string {
  if (!AGENT_LANGUAGE) return prompt;
  return `${prompt}\n\n## Language\n\nAlways respond in ${AGENT_LANGUAGE}.`;
}

const ARBITER_POLITE_USER_TONE_INSTRUCTION = `## Human User Address

- The human user is senior to the arbiter. Always address the human user in respectful Korean honorifics (존댓말), regardless of the user's tone or the conversation history
- Never use casual speech, insults, patronizing language, or commands toward the human user
- When human input is required, explain the reason and ask respectfully instead of ordering the user to act
- This rule applies only to communication with the human user. Binding directives to the owner and reviewer remain unchanged`;

export function appendArbiterUserToneInstruction(
  prompt: string,
  forcePoliteUserTone = ARBITER_FORCE_POLITE_USER_TONE,
): string {
  if (!forcePoliteUserTone) return prompt;
  return `${prompt}\n\n${ARBITER_POLITE_USER_TONE_INSTRUCTION}`;
}

const PLATFORM_PROMPT_FILES: Record<AgentType, string> = {
  'claude-code': 'claude-platform.md',
  'glm-code': 'claude-platform.md',
  codex: 'codex-platform.md',
};

// SSOT: both agent types use the same paired room prompts.
// Role-specific rules (owner vs reviewer) are selected by the caller.
const PAIRED_ROOM_PROMPT_FILES: Record<AgentType, string> = {
  'claude-code': 'claude-paired-room.md',
  'glm-code': 'claude-paired-room.md',
  codex: 'claude-paired-room.md',
};

const ARBITER_PROMPT_FILE = 'arbiter-paired-room.md';
const CUSTOM_PROMPT_FILE = 'CUSTOM.md';

export function getPlatformPromptsDir(projectRoot = process.cwd()): string {
  return path.join(projectRoot, 'prompts');
}

export function getCustomPromptPath(projectRoot = process.cwd()): string {
  return path.join(getPlatformPromptsDir(projectRoot), CUSTOM_PROMPT_FILE);
}

export function readCustomPrompt(
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getCustomPromptPath(projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt || undefined;
}

export function getPlatformPromptPath(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string {
  return path.join(
    getPlatformPromptsDir(projectRoot),
    PLATFORM_PROMPT_FILES[agentType],
  );
}

export function readPlatformPrompt(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getPlatformPromptPath(agentType, projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt || undefined;
}

export function getPairedRoomPromptPath(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string {
  return path.join(
    getPlatformPromptsDir(projectRoot),
    PAIRED_ROOM_PROMPT_FILES[agentType],
  );
}

export function readPairedRoomPrompt(
  agentType: AgentType,
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getPairedRoomPromptPath(agentType, projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt ? appendLanguageInstruction(prompt) : undefined;
}

export function getArbiterPromptPath(projectRoot = process.cwd()): string {
  return path.join(getPlatformPromptsDir(projectRoot), ARBITER_PROMPT_FILE);
}

export function readArbiterPrompt(
  projectRoot = process.cwd(),
): string | undefined {
  const promptPath = getArbiterPromptPath(projectRoot);
  if (!fs.existsSync(promptPath)) return undefined;

  const prompt = fs.readFileSync(promptPath, 'utf-8').trim();
  return prompt
    ? appendArbiterUserToneInstruction(appendLanguageInstruction(prompt))
    : undefined;
}
