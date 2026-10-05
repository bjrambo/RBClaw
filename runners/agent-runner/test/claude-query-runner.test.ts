import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  events: [] as unknown[],
  outputs: [] as any[],
  counts: [] as number[],
  options: null as any,
  close: false,
}));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(async function* (args: any) {
    fixture.options = args.options;
    for (const event of fixture.events) {
      if (typeof event === 'function') {
        await event(args.options);
        continue;
      }
      yield event;
      fixture.counts.push(fixture.outputs.length);
    }
  }),
}));
vi.mock('../src/claude-cli.js', () => ({
  getClaudeCliPath: () => '/mock-only/no-process',
}));
vi.mock('../src/ipc-input.js', () => ({
  drainIpcInput: () => [],
  shouldClose: () => fixture.close,
}));
vi.mock('../src/output-protocol.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/output-protocol.js')>()),
  writeOutput: vi.fn((output) => fixture.outputs.push(output)),
}));
import { runClaudeQuery } from '../src/claude-query-runner.js';

const commentary = {
  type: 'assistant',
  message: {
    content: [{ type: 'text', text: 'FIRST_PUBLIC_PROGRESS' }],
    stop_reason: 'tool_use',
  },
};
const final = {
  type: 'result',
  subtype: 'success',
  result: 'TASK_DONE AUTHORITATIVE_FINAL',
};
const log = vi.fn();
function run(readonly = false) {
  return runClaudeQuery({
    prompt: 'Synthetic fixture only',
    sessionId: undefined,
    mcpServerPath: '/mock-only/no-mcp',
    runnerInput: {
      prompt: 'Synthetic fixture only',
      chatJid: 'dc:fixture',
      groupFolder: 'fixture',
      isMain: false,
    },
    sdkEnv: {},
    reviewerRuntime: readonly,
    claudeReadonlyReviewerRuntime: false,
    claudeReadonlySandboxMode: null,
    abortController: new AbortController(),
    paths: {
      workDir: process.cwd(),
      groupDir: process.cwd(),
      groupFolder: 'fixture',
      hostTasksDir: '/mock-only',
      ipcInputCloseSentinel: '/mock-only',
      ipcInputDir: '/mock-only',
    },
    log,
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  fixture.events = [];
  fixture.outputs = [];
  fixture.counts = [];
  fixture.close = false;
  log.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Claude runner progress/final boundary', () => {
  it('publishes the first complete commentary before the next SDK message', async () => {
    fixture.events = [commentary, final];
    await run();
    expect(fixture.counts[0]).toBe(1);
    expect(
      fixture.outputs.map((output) => [output.phase, output.result]),
    ).toEqual([
      ['progress', 'FIRST_PUBLIC_PROGRESS'],
      ['final', 'TASK_DONE AUTHORITATIVE_FINAL'],
    ]);
  });

  it('does not promote commentary after premature SDK stream end', async () => {
    fixture.events = [commentary];
    const result = await run();
    expect(result.terminalResultObserved).toBe(true);
    expect(fixture.outputs[1]).toMatchObject({
      status: 'error',
      phase: 'final',
      result: null,
    });
    expect(
      fixture.outputs.filter(
        (output) => output.status === 'success' && output.phase === 'final',
      ),
    ).toHaveLength(0);
  });

  it('keeps an empty successful result empty, without promoting prior text', async () => {
    fixture.events = [
      commentary,
      { type: 'result', subtype: 'success', result: '' },
    ];
    await run();
    expect(fixture.outputs.at(-1)).toMatchObject({
      status: 'success',
      phase: 'final',
      result: null,
    });
  });

  it.each(['nested', 'legacy'])(
    'accepts only an explicit end_turn assistant as final: %s',
    async (where) => {
      const message = {
        type: 'assistant',
        ...(where === 'legacy' ? { stop_reason: 'end_turn' } : {}),
        message: {
          content: [
            { type: 'text', text: 'TASK_DONE EXPLICIT_ASSISTANT_FINAL' },
          ],
          ...(where === 'nested' ? { stop_reason: 'end_turn' } : {}),
        },
      };
      fixture.events = [message, final];
      await run();
      expect(fixture.outputs).toHaveLength(1);
      expect(fixture.outputs[0]).toMatchObject({
        phase: 'final',
        result: 'TASK_DONE EXPLICIT_ASSISTANT_FINAL',
      });
    },
  );

  it('drops commentary on close rather than inventing a final', async () => {
    fixture.events = [
      commentary,
      async () => {
        fixture.close = true;
        await vi.advanceTimersByTimeAsync(1000);
      },
    ];
    const result = await run();
    expect(result.closedDuringQuery).toBe(true);
    expect(fixture.outputs).toHaveLength(1);
    expect(fixture.outputs[0].phase).toBe('progress');
  });

  it('does not treat a nested agent end_turn as the main final', async () => {
    fixture.events = [
      {
        type: 'assistant',
        parent_tool_use_id: 'parent-tool',
        message: {
          content: [{ type: 'text', text: 'NESTED_PRIVATE_RESULT' }],
          stop_reason: 'end_turn',
        },
      },
      final,
    ];
    await run();
    expect(fixture.outputs).toHaveLength(1);
    expect(fixture.outputs[0]).toMatchObject({
      phase: 'final',
      result: 'TASK_DONE AUTHORITATIVE_FINAL',
    });
  });

  it('retains explicit error results without converting prior commentary to success', async () => {
    fixture.events = [
      commentary,
      {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['fixture error'],
      },
    ];
    await run();
    expect(fixture.outputs.at(-1)).toMatchObject({
      status: 'error',
      phase: 'final',
      result: null,
    });
  });

  it('emits lifecycle through safe hooks and keeps the reviewer Bash guards', async () => {
    fixture.events = [
      async (options: any) => {
        const base = {
          session_id: 'fixture',
          cwd: '/fixture',
          transcript_path: '',
          tool_use_id: 'bash-1',
          tool_name: 'Bash',
          tool_input: {
            command: 'TOKEN=DUMMY_SECRET bun run test --filter=DUMMY_SECRET',
          },
        };
        const args = { signal: new AbortController().signal };
        expect(
          await options.hooks.PreToolUse[0].hooks[0](
            { ...base, hook_event_name: 'PreToolUse' },
            'bash-1',
            args,
          ),
        ).toEqual({});
        expect(
          await options.hooks.PostToolUse[0].hooks[0](
            {
              ...base,
              hook_event_name: 'PostToolUse',
              tool_response: { stdout: 'DUMMY_SECRET' },
            },
            'bash-1',
            args,
          ),
        ).toEqual({});
      },
      final,
    ];
    await run(true);
    expect(fixture.outputs.slice(0, 2).map((output) => output.phase)).toEqual([
      'tool-activity',
      'tool-activity',
    ]);
    expect(
      fixture.options.hooks.PreToolUse.find(
        (matcher: HookCallbackMatcher) => matcher.matcher === 'Bash',
      ).hooks,
    ).toHaveLength(2);
    expect(JSON.stringify(fixture.outputs)).not.toContain('DUMMY_SECRET');
    expect(fixture.options.hooks.PostToolUseFailure).toHaveLength(1);
  });

  it('does not forward raw tool blocks or free-form tool summaries', async () => {
    fixture.events = [
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'raw-1',
              name: 'Read',
              input: { file_path: '/private/DUMMY_SECRET.json' },
            },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'raw-1',
              content: 'DUMMY_SECRET',
            },
          ],
        },
      },
      { type: 'tool_use_summary', summary: 'DUMMY_SECRET' },
      final,
    ];
    await run();
    expect(fixture.outputs).toHaveLength(1);
    expect(JSON.stringify(fixture.outputs)).not.toContain('DUMMY_SECRET');
    expect(JSON.stringify(log.mock.calls)).not.toContain('DUMMY_SECRET');
  });

  it('routes safe heartbeats as activity, not canonical progress/final', async () => {
    fixture.events = [
      { type: 'tool_progress', tool_name: 'Bash', elapsed_time_seconds: 2.4 },
      final,
    ];
    await run();
    expect(fixture.outputs[0]).toMatchObject({
      phase: 'tool-activity',
      result: '⏳ 명령 실행 (2s)',
    });
  });
});
