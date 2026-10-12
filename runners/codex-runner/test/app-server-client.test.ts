import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

import { describe, expect, it, vi } from 'vitest';

import {
  CodexAppServerClient,
  buildCodexAppServerArgs,
  closeAppServerProcess,
} from '../src/app-server-client.js';

function buildClosableProcess(): ChildProcess {
  const proc = new EventEmitter() as ChildProcess;
  Object.assign(proc, {
    exitCode: null,
    signalCode: null,
    stdin: { end: vi.fn() },
    kill: vi.fn(() => true),
  });
  return proc;
}

describe('codex app-server display event routing', () => {
  it('routes tool metadata separately from commentary and the authoritative final', async () => {
    const client = new CodexAppServerClient({ cwd: '/repo', log: vi.fn() });
    const internals = client as unknown as {
      request: (method: string, params?: unknown) => Promise<unknown>;
      handleNotification: (message: {
        method: string;
        params: Record<string, unknown>;
      }) => void;
    };
    internals.request = vi.fn().mockResolvedValue({
      turn: { id: 'turn-1', status: 'inProgress' },
    });
    const onProgress = vi.fn();
    const onToolActivity = vi.fn();
    const turn = await client.startTurn('thread-1', [], {
      cwd: '/repo',
      onProgress,
      onToolActivity,
    });
    const notify = (method: string, item: Record<string, unknown>) =>
      internals.handleNotification({
        method,
        params: { threadId: 'thread-1', turnId: 'turn-1', item },
      });

    notify('item/completed', {
      type: 'agentMessage',
      phase: 'commentary',
      text: '첫 공개 진행 문구',
    });
    notify('item/started', {
      type: 'commandExecution',
      command: 'bun run test --token secret-token',
    });
    notify('item/completed', {
      type: 'commandExecution',
      command: 'bun run test --token secret-token',
      exitCode: 0,
      aggregatedOutput: 'secret stdout',
    });
    notify('item/completed', { type: 'reasoning', text: 'private reasoning' });
    internals.handleNotification({
      method: 'item/started',
      params: { threadId: 'other-thread', item: { type: 'mcpToolCall' } },
    });
    internals.handleNotification({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        turnId: 'old-turn',
        item: { type: 'mcpToolCall' },
      },
    });
    notify('item/completed', {
      type: 'agentMessage',
      phase: 'final_answer',
      text: 'TASK_DONE 최종 결과',
    });
    internals.handleNotification({
      method: 'turn/completed',
      params: {
        threadId: 'thread-1',
        turn: { id: 'turn-1', status: 'completed' },
      },
    });

    expect(onProgress.mock.calls).toEqual([['첫 공개 진행 문구']]);
    expect(onToolActivity.mock.calls).toEqual([
      ['🔄 명령 실행 시작 · `bun run test …`'],
      ['✅ 명령 실행 완료 · `bun run test …`'],
    ]);
    expect((await turn.wait()).result).toBe('TASK_DONE 최종 결과');
  });
});

describe('codex app-server client goals', () => {
  it('does not enable goals by default when spawning app-server', () => {
    expect(
      buildCodexAppServerArgs({
        codexBin: '/opt/codex/bin/codex.js',
      }),
    ).toEqual(['/opt/codex/bin/codex.js', 'app-server']);
  });

  it('waits for app-server exit after closing stdin and sending SIGTERM', async () => {
    const proc = buildClosableProcess();
    const closePromise = closeAppServerProcess(proc, 1_000);

    expect(proc.stdin?.end).toHaveBeenCalledOnce();
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    proc.emit('exit', 0, null);
    await expect(closePromise).resolves.toBeUndefined();
  });

  it('bounds the app-server shutdown wait when no exit event arrives', async () => {
    vi.useFakeTimers();
    const proc = buildClosableProcess();
    const closePromise = closeAppServerProcess(proc, 10);

    await vi.advanceTimersByTimeAsync(10);
    await expect(closePromise).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('adds the under-development goals feature only when explicitly enabled', () => {
    expect(
      buildCodexAppServerArgs({
        codexBin: '/opt/codex/bin/codex.js',
        enableGoals: true,
      }),
    ).toEqual(['/opt/codex/bin/codex.js', '--enable', 'goals', 'app-server']);
  });

  it('wraps thread goal JSON-RPC methods with the upstream objective field', async () => {
    const client = new CodexAppServerClient({
      cwd: '/repo',
      log: () => undefined,
    });
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thread-1',
          objective: 'ship the release',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thread-1',
          objective: 'ship the release',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      })
      .mockResolvedValueOnce({ cleared: true });
    (
      client as unknown as {
        request: (method: string, params?: unknown) => Promise<unknown>;
      }
    ).request = request;

    await expect(
      client.threadGoalSet('thread-1', 'ship the release'),
    ).resolves.toMatchObject({
      threadId: 'thread-1',
      objective: 'ship the release',
      status: 'active',
    });
    await expect(client.threadGoalGet('thread-1')).resolves.toMatchObject({
      objective: 'ship the release',
    });
    await expect(client.threadGoalClear('thread-1')).resolves.toBe(true);

    expect(request).toHaveBeenNthCalledWith(1, 'thread/goal/set', {
      threadId: 'thread-1',
      objective: 'ship the release',
    });
    expect(request).toHaveBeenNthCalledWith(2, 'thread/goal/get', {
      threadId: 'thread-1',
    });
    expect(request).toHaveBeenNthCalledWith(3, 'thread/goal/clear', {
      threadId: 'thread-1',
    });
  });
});
