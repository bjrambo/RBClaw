import { describe, expect, it } from 'vitest';

import { formatAppServerToolActivity } from '../src/app-server-tool-activity.js';

describe('Codex app-server display-only tool activity', () => {
  it.each([
    ['commandExecution', '명령 실행'],
    ['fileChange', '파일 변경'],
    ['mcpToolCall', 'MCP 도구'],
    ['dynamicToolCall', '연결 도구'],
    ['collabAgentToolCall', '에이전트 도구'],
    ['subAgentActivity', '서브에이전트 작업'],
    ['webSearch', '웹 검색'],
    ['imageView', '이미지 확인'],
    ['imageGeneration', '이미지 생성'],
    ['sleep', '대기'],
  ])('shows start and completion metadata for %s', (type, label) => {
    expect(formatAppServerToolActivity('item/started', { type })).toBe(
      `🔄 ${label} 시작`,
    );
    expect(formatAppServerToolActivity('item/completed', { type })).toBe(
      `✅ ${label} 완료`,
    );
  });

  it.each([
    { status: 'failed' },
    { exitCode: 1 },
    { success: false },
    { error: { message: 'private error detail' } },
    { failure: 'private generation failure' },
    { result: { isError: true, content: 'private result' } },
  ])('shows failure without exposing error details: %j', (fields) => {
    expect(
      formatAppServerToolActivity('item/completed', {
        type: 'commandExecution',
        ...fields,
      }),
    ).toBe('❌ 명령 실행 실패');
  });

  it('distinguishes declined and interrupted execution', () => {
    expect(
      formatAppServerToolActivity('item/completed', {
        type: 'fileChange',
        status: 'declined',
      }),
    ).toBe('⛔ 파일 변경 거부됨');
    expect(
      formatAppServerToolActivity('item/completed', {
        type: 'commandExecution',
        status: 'interrupted',
      }),
    ).toBe('⏹ 명령 실행 중단됨');
  });

  it('never copies raw commands, tool inputs, results, paths or prompts', () => {
    const activity = formatAppServerToolActivity('item/started', {
      type: 'mcpToolCall',
      arguments: { token: 'secret-token' },
      command: 'PASSWORD=secret-command',
      result: 'secret-output',
      path: '/private/path',
      prompt: 'secret-prompt',
      tool: 'secret-tool-name',
    });
    expect(activity).toBe('🔄 MCP 도구 시작');
    expect(activity).not.toContain('secret');
    expect(activity).not.toContain('/private');
  });

  it.each([
    'reasoning',
    'agentMessage',
    'plan',
    'userMessage',
    'unknown',
    'toString',
  ])('ignores non-tool items and unknown types: %s', (type) => {
    expect(formatAppServerToolActivity('item/started', { type })).toBeNull();
    expect(formatAppServerToolActivity('item/completed', { type })).toBeNull();
  });

  it('ignores output deltas and malformed items', () => {
    expect(formatAppServerToolActivity('item/started', null)).toBeNull();
    expect(formatAppServerToolActivity('item/completed', {})).toBeNull();
    expect(
      formatAppServerToolActivity('item/commandExecution/outputDelta', {
        type: 'commandExecution',
        delta: 'private stdout',
      }),
    ).toBeNull();
  });
});
