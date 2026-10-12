import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeToolActivity } from '../src/claude-tool-activity.js';

const secret = 'CLAUDE_DUMMY_SECRET_71E';
function call(hook: HookCallback, event: Record<string, unknown>) {
  return hook(
    {
      session_id: 'fixture',
      transcript_path: '',
      cwd: '/fixture',
      tool_use_id: 'call-1',
      tool_name: 'Bash',
      tool_input: {
        command: `TOKEN=${secret} bun run test --filter=${secret}`,
      },
      ...event,
    } as HookInput,
    'call-1',
    { signal: new AbortController().signal },
  );
}

describe('Claude display-only tool lifecycle', () => {
  it('emits safe start/completion once without model-facing hook output', async () => {
    const emit = vi.fn();
    const activity = new ClaudeToolActivity(emit);
    expect(
      await call(activity.preToolUse, { hook_event_name: 'PreToolUse' }),
    ).toEqual({});
    await call(activity.preToolUse, { hook_event_name: 'PreToolUse' });
    expect(
      await call(activity.postToolUse, {
        hook_event_name: 'PostToolUse',
        tool_response: { stdout: secret, stderr: secret },
      }),
    ).toEqual({});
    await call(activity.postToolUse, { hook_event_name: 'PostToolUse' });
    expect(emit.mock.calls.map(([line]) => line)).toEqual([
      '🔄 명령 실행 시작 · `bun run test …`',
      '✅ 명령 실행 완료 · `bun run test …`',
    ]);
    expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
  });

  it.each(['Read', 'Write', 'Edit', 'MultiEdit'])(
    'shows only a safe basename for %s',
    async (tool_name) => {
      const emit = vi.fn();
      const activity = new ClaudeToolActivity(emit);
      await call(activity.preToolUse, {
        hook_event_name: 'PreToolUse',
        tool_name,
        tool_input: {
          file_path: '/private/tree/package.json',
          content: secret,
          old_string: secret,
          new_string: secret,
        },
      });
      expect(emit.mock.calls[0][0]).toContain('package.json');
      expect(emit.mock.calls[0][0]).not.toMatch(/private|CLAUDE_DUMMY_SECRET/u);
    },
  );

  it.each([
    { is_error: true },
    { isError: true },
    { exitCode: 2 },
    { exit_code: 1 },
    { success: false },
  ])(
    'marks failed results without copying output: %j',
    async (tool_response) => {
      const emit = vi.fn();
      const activity = new ClaudeToolActivity(emit);
      await call(activity.postToolUse, {
        hook_event_name: 'PostToolUse',
        tool_response: { ...tool_response, stdout: secret },
      });
      expect(emit.mock.calls[0][0]).toBe(
        '❌ 명령 실행 실패 · `bun run test …`',
      );
    },
  );

  it.each([false, true])(
    'reports failure/interruption safely: %s',
    async (is_interrupt) => {
      const emit = vi.fn();
      const activity = new ClaudeToolActivity(emit);
      expect(
        await call(activity.postToolUseFailure, {
          hook_event_name: 'PostToolUseFailure',
          is_interrupt,
          error: secret,
        }),
      ).toEqual({});
      expect(emit.mock.calls[0][0]).toBe(
        `${is_interrupt ? '⏹ 명령 실행 중단됨' : '❌ 명령 실행 실패'} · \`bun run test …\``,
      );
    },
  );

  it('uses fixed fallback names for arbitrary tools and suspicious paths', async () => {
    const emit = vi.fn();
    const activity = new ClaudeToolActivity(emit);
    await call(activity.preToolUse, {
      hook_event_name: 'PreToolUse',
      tool_name: secret,
      tool_input: { command: secret },
    });
    await call(activity.preToolUse, {
      hook_event_name: 'PreToolUse',
      tool_use_id: 'read-2',
      tool_name: 'Read',
      tool_input: { file_path: `/private/${secret}.md` },
    });
    expect(emit.mock.calls.map(([line]) => line)).toEqual([
      '🔄 도구 작업 시작',
      '🔄 파일 읽기 시작 · 파일 읽기',
    ]);
  });

  it('keeps safe command detail on progress and ignores late heartbeats', async () => {
    const activity = new ClaudeToolActivity(vi.fn());
    await call(activity.preToolUse, { hook_event_name: 'PreToolUse' });
    expect(
      activity.progress({ tool_use_id: 'call-1', elapsed_time_seconds: 2.4 }),
    ).toBe('⏳ 명령 실행 (2s) · `bun run test …`');
    expect(
      activity.progress({ tool_name: secret, elapsed_time_seconds: NaN }),
    ).toBe('⏳ 도구 작업');
    await call(activity.postToolUse, { hook_event_name: 'PostToolUse' });
    expect(activity.progress({ tool_use_id: 'call-1' })).toBeNull();
  });

  it('does not emit invalid lifecycle events without a tool id', async () => {
    const emit = vi.fn();
    const activity = new ClaudeToolActivity(emit);
    await call(activity.preToolUse, { tool_use_id: '' });
    await call(activity.postToolUseFailure, { tool_use_id: '' });
    expect(emit).not.toHaveBeenCalled();
  });
});
