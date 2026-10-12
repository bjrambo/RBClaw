import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./logger.js', () => {
  const logger = {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { logger, createScopedLogger: () => logger };
});

import { logger } from './logger.js';
import { MessageTurnController } from './message-turn-controller.js';
import { renderProgressMessage } from './message-turn-controller-progress-render.js';
import { TASK_STATUS_MESSAGE_PREFIX } from './task-watch-status.js';
import type { Channel } from './types.js';

function fixture(agentType: 'codex' | 'claude-code' = 'codex') {
  const channel: Channel = {
    name: 'discord',
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: () => true,
    ownsJid: () => true,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAndTrack: vi.fn().mockResolvedValue('progress-1'),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
  const deliverFinalText = vi.fn().mockResolvedValue(true);
  const controller = new MessageTurnController({
    chatJid: 'dc:test',
    group: {
      name: 'Test',
      folder: 'test',
      trigger: '@bot',
      added_at: '',
      agentType,
    },
    runId: 'run-1',
    channel,
    idleTimeout: 60_000,
    failureFinalText: '실패',
    isClaudeCodeAgent: agentType === 'claude-code',
    clearSession: vi.fn(),
    requestClose: vi.fn(),
    deliverFinalText,
    pairedTurnIdentity: {
      turnId: 'task-1:owner-turn',
      taskId: 'task-1',
      taskUpdatedAt: '',
      intentKind: 'owner-turn',
      role: 'owner',
    },
  });
  return { channel, controller, deliverFinalText };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('display-only progress and tool telemetry', () => {
  it('keeps Claude commentary/activity display-only until its authoritative final', async () => {
    const { channel, controller, deliverFinalText } = fixture('claude-code');
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: 'Claude 첫 문구',
    });
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    await controller.handleOutput({
      status: 'success',
      phase: 'tool-activity',
      result: '🔄 파일 읽기 시작 · 읽기 `package.json`',
    });
    expect(deliverFinalText).not.toHaveBeenCalled();
    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'TASK_DONE Claude 정식 보고',
    });
    await controller.finish('success');
    expect(deliverFinalText).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith(
      'TASK_DONE Claude 정식 보고',
      { replaceMessageId: 'progress-1' },
    );
  });

  it('never replays Claude progress as a final on a paired turn', async () => {
    const { controller, deliverFinalText } = fixture('claude-code');
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: 'Claude 중간 문구',
    });
    await controller.finish('success');
    expect(deliverFinalText).not.toHaveBeenCalled();
  });
  it('preserves the newest actions within the Discord limit without truncating dashboard progress', () => {
    const persistProgressBody = vi.fn();
    const text = '긴 진행 문구'.repeat(500);
    const rendered = renderProgressMessage({
      text,
      progressStartedAt: null,
      subagents: new Map(),
      toolActivities: ['🔄 명령 실행 시작', '✅ 명령 실행 완료'],
      persistProgressBody,
    });
    expect(rendered.length).toBeLessThanOrEqual(2000);
    expect(rendered).toContain('✅ 명령 실행 완료');
    expect(persistProgressBody).toHaveBeenCalledWith(
      expect.stringContaining(text),
    );
  });

  it('publishes a lone first commentary immediately without inventing a final', async () => {
    const { channel, controller, deliverFinalText } = fixture();
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 공개 문구',
    });
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      'dc:test',
      expect.stringContaining(`${TASK_STATUS_MESSAGE_PREFIX}첫 공개 문구`),
    );
    await controller.finish('success');
    expect(deliverFinalText).not.toHaveBeenCalled();
  });

  it('keeps safe command summaries display-only and sends only the authoritative final', async () => {
    const { channel, controller, deliverFinalText } = fixture();
    const summary = '🔄 명령 실행 시작 · `bun run test …`';
    await controller.handleOutput({
      status: 'success',
      phase: 'tool-activity',
      result: summary,
    });
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      'dc:test',
      expect.stringContaining(summary),
    );
    expect(deliverFinalText).not.toHaveBeenCalled();
    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'TASK_DONE 실제 결과',
    });
    await controller.finish('success');
    expect(deliverFinalText).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('TASK_DONE 실제 결과', {
      replaceMessageId: 'progress-1',
    });
  });

  it('shows the first action immediately, then coalesces tool updates within one second', async () => {
    vi.useFakeTimers();
    const { channel, controller, deliverFinalText } = fixture();
    await controller.handleOutput({
      status: 'success',
      phase: 'tool-activity',
      result: '🔄 명령 실행 시작',
    });
    expect(channel.sendAndTrack).toHaveBeenCalledWith(
      'dc:test',
      expect.stringContaining('🔄 명령 실행 시작'),
    );
    for (let i = 0; i < 10; i++) {
      await controller.handleOutput({
        status: 'success',
        phase: 'tool-activity',
        result: `✅ 명령 실행 완료 ${i}`,
      });
    }
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(channel.editMessage).toHaveBeenCalledTimes(1);
    expect(channel.editMessage).toHaveBeenLastCalledWith(
      'dc:test',
      'progress-1',
      expect.stringContaining('✅ 명령 실행 완료 9'),
    );
    // Every event is in the scoped display log even when Discord keeps a bounded tail.
    expect(
      vi
        .mocked(logger.info)
        .mock.calls.filter(([, message]) => message === 'Agent tool activity'),
    ).toHaveLength(11);
    await controller.finish('success');
    expect(deliverFinalText).not.toHaveBeenCalled();
  });

  it('keeps tool history across commentary updates and delivers only the actual final', async () => {
    const { channel, controller, deliverFinalText } = fixture();
    await controller.handleOutput({
      status: 'success',
      phase: 'tool-activity',
      result: '✅ 파일 변경 완료',
    });
    await controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '테스트 진행 중',
    });
    await Promise.resolve();
    expect(channel.editMessage).toHaveBeenCalledWith(
      'dc:test',
      'progress-1',
      expect.stringContaining('✅ 파일 변경 완료'),
    );
    await controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'TASK_DONE 검증 완료',
    });
    await controller.finish('success');
    expect(deliverFinalText).toHaveBeenCalledTimes(1);
    expect(deliverFinalText).toHaveBeenCalledWith('TASK_DONE 검증 완료', {
      replaceMessageId: 'progress-1',
    });
  });

  it('waits for a slow initial progress send before replacing it with the explicit final', async () => {
    const { channel, controller, deliverFinalText } = fixture();
    let resolveSend!: (id: string) => void;
    vi.mocked(channel.sendAndTrack!).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    const progress = controller.handleOutput({
      status: 'success',
      phase: 'progress',
      result: '첫 문구',
    });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    const final = controller.handleOutput({
      status: 'success',
      phase: 'final',
      result: 'TASK_DONE 실제 결론',
    });
    expect(deliverFinalText).not.toHaveBeenCalled();
    resolveSend('progress-1');
    await Promise.all([progress, final]);
    await controller.finish('success');
    expect(deliverFinalText).toHaveBeenCalledWith('TASK_DONE 실제 결론', {
      replaceMessageId: 'progress-1',
    });
    expect(channel.sendAndTrack).toHaveBeenCalledTimes(1);
  });
});
