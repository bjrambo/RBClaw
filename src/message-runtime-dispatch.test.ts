import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getLastHumanMessageTimestamp: vi.fn(() => null),
  getLatestOpenPairedTaskForChat: vi.fn(() => null),
  getMessagesSinceSeq: vi.fn(() => []),
  getPairedTurnOutputs: vi.fn(() => []),
  pausePairedTaskForChat: vi.fn(),
}));

vi.mock('./service-routing.js', () => ({
  hasReviewerLease: vi.fn(() => false),
  resolveLeaseServiceId: vi.fn(() => null),
}));

vi.mock('./paired-task-status.js', () => ({
  transitionPairedTaskStatus: vi.fn(),
}));

import {
  getLastHumanMessageTimestamp,
  getLatestOpenPairedTaskForChat,
  getMessagesSinceSeq,
  pausePairedTaskForChat,
} from './db.js';
import { processLoopGroupMessages } from './message-runtime-dispatch.js';
import { MessageTurnController } from './message-turn-controller.js';
import { hasReviewerLease } from './service-routing.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

const getLastHumanMessageTimestampMock =
  getLastHumanMessageTimestamp as unknown as {
    mockReturnValue(value: string | null): void;
  };
const getLatestOpenPairedTaskForChatMock =
  getLatestOpenPairedTaskForChat as unknown as {
    mockReturnValue(value: unknown): void;
  };
const hasReviewerLeaseMock = hasReviewerLease as unknown as {
  mockReturnValue(value: boolean): void;
};

const chatJid = 'group@test';
const timestamp = '2026-04-29T13:25:28.000Z';

const group: RegisteredGroup = {
  name: 'Test Group',
  folder: 'test-group',
  trigger: '@Andy',
  added_at: timestamp,
  requiresTrigger: false,
};

const channel: Channel = {
  name: 'discord',
  connect: vi.fn(),
  sendMessage: vi.fn(),
  isConnected: vi.fn(() => true),
  ownsJid: vi.fn(() => true),
  disconnect: vi.fn(),
};

function message(overrides: Partial<NewMessage>): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: chatJid,
    sender: 'user',
    sender_name: 'User',
    content: '중간에 이거 먼저 봐줘',
    timestamp,
    seq: 10,
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function defaultArgs(
  overrides: Partial<Parameters<typeof processLoopGroupMessages>[0]> = {},
) {
  return {
    chatJid,
    group,
    groupMessages: [message({})],
    channel,
    pairedChannels: [channel],
    assistantName: '오너',
    failureFinalText: 'FAILED',
    triggerPattern: /^\/clear\b/,
    hasImplicitContinuationWindow: vi.fn(() => false),
    lastAgentTimestamps: {},
    saveState: vi.fn(),
    timezone: 'Asia/Seoul',
    executeTurn: vi.fn(),
    schedulePairedFollowUp: vi.fn(() => true),
    enqueueMessageCheck: vi.fn(),
    sendQueuedMessage: vi.fn(() => true),
    closeStdin: vi.fn(),
    killProcess: vi.fn(() => true),
    isRunningMessageTurn: vi.fn(() => true),
    labelPairedSenders: vi.fn((_jid, messages) => messages),
    formatMessages: vi.fn((messages: NewMessage[]) =>
      messages.map((item) => item.content).join('\n'),
    ),
    ...overrides,
  } satisfies Parameters<typeof processLoopGroupMessages>[0];
}

describe('processLoopGroupMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLastHumanMessageTimestampMock.mockReturnValue(null);
    getLatestOpenPairedTaskForChatMock.mockReturnValue(null);
    hasReviewerLeaseMock.mockReturnValue(false);
  });

  it('requeues external human messages instead of piping them into an active agent', async () => {
    const args = defaultArgs();

    await processLoopGroupMessages(args);

    expect(args.closeStdin).toHaveBeenCalledWith('human-message-detected');
    expect(args.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({});
    expect(args.saveState).not.toHaveBeenCalled();
  });

  it('does not close stdin for human messages when no message turn is running', async () => {
    const args = defaultArgs({
      isRunningMessageTurn: vi.fn(() => false),
    });

    await processLoopGroupMessages(args);

    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).toHaveBeenCalledTimes(1);
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
  });

  it('kills the running agent immediately for authorized /stop without queueing another run', async () => {
    const args = defaultArgs({
      group: { ...group, isMain: true },
      groupMessages: [message({ content: '/stop', seq: 20 })],
    });

    await processLoopGroupMessages(args);

    expect(args.killProcess).toHaveBeenCalledTimes(1);
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
    expect(channel.sendMessage).toHaveBeenCalledWith(chatJid, 'Agent stopped.');
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '20' });
  });

  it('pauses the paired Goal before killing its running episode', async () => {
    hasReviewerLeaseMock.mockReturnValue(true);
    getLatestOpenPairedTaskForChatMock.mockReturnValue({
      id: 'task-1',
      status: 'owner_running',
      updated_at: '2026-04-29T13:25:00.000Z',
    });
    const args = defaultArgs({
      group: { ...group, isMain: true },
      groupMessages: [message({ content: '/stop', seq: 20 })],
    });

    await processLoopGroupMessages(args);

    expect(pausePairedTaskForChat).toHaveBeenCalledExactlyOnceWith(chatJid);
    expect(
      vi.mocked(pausePairedTaskForChat).mock.invocationCallOrder[0],
    ).toBeLessThan(args.killProcess.mock.invocationCallOrder[0]);
  });

  it('does not pipe old context or enqueue bot messages while a user-stopped Goal waits', async () => {
    hasReviewerLeaseMock.mockReturnValue(true);
    getLastHumanMessageTimestampMock.mockReturnValue(timestamp);
    getLatestOpenPairedTaskForChatMock.mockReturnValue({
      id: 'paused-goal',
      status: 'active',
      supervisor_state: 'waiting_user',
      last_blocker_class: 'user_input',
    });
    const args = defaultArgs({
      groupMessages: [
        message({
          seq: 12,
          content: 'TASK_DONE',
          is_bot_message: true,
        }),
      ],
    });
    await processLoopGroupMessages(args);
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps[chatJid]).toBe('12');
  });

  it('does not process a delivered /stop again, including while its acknowledgement is pending', async () => {
    let finishAck!: () => void;
    vi.mocked(channel.sendMessage).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishAck = resolve;
        }),
    );
    const args = defaultArgs({
      group: { ...group, isMain: true },
      groupMessages: [message({ content: '/stop', seq: 20 })],
    });
    const first = processLoopGroupMessages(args);
    await processLoopGroupMessages(args);
    finishAck();
    await first;

    expect(args.killProcess).toHaveBeenCalledOnce();
    expect(channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'Agent stopped.',
    );
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('queues a fresh human message when an already consumed /stop is redelivered beside it', async () => {
    const args = defaultArgs({
      group: { ...group, isMain: true },
      lastAgentTimestamps: { [chatJid]: '20' },
      groupMessages: [
        message({ id: 'stop', content: '/stop', seq: 20 }),
        message({ id: 'next', content: 'new prompt', seq: 21 }),
      ],
    });
    await processLoopGroupMessages(args);
    expect(args.killProcess).not.toHaveBeenCalled();
    expect(channel.sendMessage).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).toHaveBeenCalledOnce();
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '20' });
  });

  it('preserves the batch tail even when sending the /stop acknowledgement fails', async () => {
    vi.mocked(channel.sendMessage).mockRejectedValueOnce(
      new Error('send failed'),
    );
    const args = defaultArgs({
      group: { ...group, isMain: true },
      groupMessages: [
        message({ id: 'stop', content: '/stop', seq: 20 }),
        message({ id: 'next', content: 'new prompt', seq: 21 }),
      ],
    });
    await expect(processLoopGroupMessages(args)).rejects.toThrow('send failed');
    expect(args.enqueueMessageCheck).toHaveBeenCalledOnce();
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '20' });
  });

  it('ignores human messages already claimed by the active run instead of self-interrupting it', async () => {
    const args = defaultArgs({
      isActiveRunInputMessage: vi.fn((_chatJid, msg) => msg.seq === 10),
    });

    await processLoopGroupMessages(args);

    expect(args.isActiveRunInputMessage).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({ seq: 10 }),
    );
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.sendQueuedMessage).not.toHaveBeenCalled();
    expect(args.saveState).not.toHaveBeenCalled();
  });

  it('does not self-interrupt for a web-injected message claimed by the active run', async () => {
    const args = defaultArgs({
      groupMessages: [
        message({
          id: 'web-issue-227',
          sender: 'web-dashboard',
          sender_name: 'Fixture_WEB',
          message_source_kind: 'ipc_injected_human',
          seq: 3023,
        }),
      ],
      isActiveRunInputMessage: vi.fn(
        (_chatJid, msg) =>
          msg.id === 'web-issue-227' &&
          msg.message_source_kind === 'ipc_injected_human' &&
          msg.seq === 3023,
      ),
    });

    await processLoopGroupMessages(args);

    expect(args.isActiveRunInputMessage).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({
        id: 'web-issue-227',
        message_source_kind: 'ipc_injected_human',
        seq: 3023,
      }),
    );
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({});
    expect(args.saveState).not.toHaveBeenCalled();
  });

  it('still interrupts when any external human message is not part of the active run input', async () => {
    const args = defaultArgs({
      groupMessages: [
        message({ id: 'claimed-msg', seq: 10 }),
        message({ id: 'new-msg', seq: 11, content: '새 요청' }),
      ],
      isActiveRunInputMessage: vi.fn((_chatJid, msg) => msg.seq === 10),
    });

    await processLoopGroupMessages(args);

    expect(args.closeStdin).toHaveBeenCalledWith('human-message-detected');
    expect(args.enqueueMessageCheck).toHaveBeenCalledTimes(1);
  });

  it('still pipes bot-only messages when active stdin accepts them', async () => {
    hasReviewerLeaseMock.mockReturnValue(true);
    getLastHumanMessageTimestampMock.mockReturnValue(timestamp);
    const args = defaultArgs({
      groupMessages: [
        message({
          id: 'bot-msg-1',
          sender: '오너',
          sender_name: '오너',
          content: 'STEP_DONE',
          is_from_me: true,
          is_bot_message: true,
          seq: 12,
        }),
      ],
    });

    await processLoopGroupMessages(args);

    expect(args.sendQueuedMessage).toHaveBeenCalledWith(chatJid, 'STEP_DONE');
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '12' });
  });

  it('pipes trusted external bot events instead of treating them as human interrupts', async () => {
    hasReviewerLeaseMock.mockReturnValue(true);
    const args = defaultArgs({
      groupMessages: [
        message({
          id: 'watch-ci-completed:task-1',
          sender: 'ci-watcher',
          sender_name: 'CI watcher',
          content: '[CI watcher completed]\nCI succeeded',
          is_from_me: false,
          is_bot_message: false,
          message_source_kind: 'trusted_external_bot',
          seq: 13,
        }),
      ],
      isRunningMessageTurn: vi.fn(() => true),
    });

    await processLoopGroupMessages(args);

    expect(args.sendQueuedMessage).toHaveBeenCalledWith(
      chatJid,
      '[CI watcher completed]\nCI succeeded',
    );
    expect(args.closeStdin).not.toHaveBeenCalled();
    expect(args.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(args.lastAgentTimestamps).toEqual({ [chatJid]: '13' });
  });
});

describe('queued typing ownership in opted-in paired rooms', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    vi.stubEnv('RBCLAW_FINAL_DECISION_ROOMS', chatJid);
    hasReviewerLeaseMock.mockReturnValue(true);
    getLastHumanMessageTimestampMock.mockReturnValue(timestamp);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function harness() {
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    const refreshes: string[] = [];
    const channels = ['discord', 'discord-review', 'discord-arbiter'].map(
      (name) => ({
        ...channel,
        name,
        setTyping: vi.fn(async (_jid: string, on: boolean) => {
          const existing = timers.get(name);
          if (existing) clearInterval(existing);
          timers.delete(name);
          if (on) {
            timers.set(
              name,
              setInterval(() => refreshes.push(name), 8_000),
            );
          }
        }),
      }),
    );
    const oldHuman = message({ id: 'old-human', seq: 10 });
    const peer = message({
      id: 'new-reviewer-result',
      seq: 12,
      content: 'TASK_DONE\nApproved',
      sender: 'reviewer-bot',
      sender_name: 'Reviewer',
      is_from_me: false,
      is_bot_message: true,
      message_source_kind: 'bot',
    });
    vi.mocked(getMessagesSinceSeq).mockReturnValue([oldHuman, peer]);
    const args = defaultArgs({
      channel: channels[0],
      pairedChannels: channels,
      groupMessages: [peer],
    });
    return { channels, timers, refreshes, oldHuman, peer, args };
  }

  it.each([
    ['owner', 'success'],
    ['reviewer', 'success'],
    ['arbiter', 'success'],
    ['owner', 'error'],
    ['reviewer', 'error'],
    ['arbiter', 'error'],
  ] as const)(
    'leaves no owner typing timer after the %s turn finishes with %s beside stale human context',
    async (role, outputStatus) => {
      const test = harness();
      getLatestOpenPairedTaskForChatMock.mockReturnValue({
        id: 'typing-task',
        status:
          role === 'arbiter'
            ? 'in_arbitration'
            : role === 'owner'
              ? 'active'
              : 'in_review',
        review_phase: 'final',
        created_at: timestamp,
        updated_at: timestamp,
      });
      const roleChannel =
        test.channels[['owner', 'reviewer', 'arbiter'].indexOf(role)];
      const controller = new MessageTurnController({
        chatJid,
        group,
        runId: `typing-${role}`,
        channel: roleChannel,
        idleTimeout: 60_000,
        failureFinalText: 'FAILED',
        isClaudeCodeAgent: role !== 'owner',
        clearSession: vi.fn(),
        requestClose: vi.fn(),
        deliverFinalText: vi.fn(async () => true),
        deliveryRole: role,
      });
      await controller.start();
      try {
        await processLoopGroupMessages(test.args);
      } finally {
        await controller.finish(outputStatus);
      }

      expect(test.args.sendQueuedMessage).toHaveBeenCalledOnce();
      expect(test.args.labelPairedSenders).toHaveBeenCalledWith(chatJid, [
        test.oldHuman,
        test.peer,
      ]);
      expect(test.args.closeStdin).not.toHaveBeenCalled();
      expect(
        test.channels[0].setTyping.mock.calls.filter(([, on]) => on),
      ).toHaveLength(role === 'owner' ? 1 : 0);
      expect(roleChannel.setTyping).toHaveBeenCalledWith(chatJid, true);
      expect(roleChannel.setTyping).toHaveBeenCalledWith(chatJid, false);
      expect(test.timers.size).toBe(0);
      await vi.advanceTimersByTimeAsync(16_000);
      expect(test.refreshes).toEqual([]);
    },
  );

  it('keeps legacy queued typing when the paired-room feature is disabled', async () => {
    vi.stubEnv('RBCLAW_FINAL_DECISION_ROOMS', 'dc:another-room');
    const test = harness();
    getLatestOpenPairedTaskForChatMock.mockReturnValue({
      id: 'typing-task',
      status: 'in_review',
      review_phase: 'final',
    });
    await processLoopGroupMessages(test.args);
    expect(test.channels[0].setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(test.args.sendQueuedMessage).toHaveBeenCalledOnce();
    await test.channels[0].setTyping(chatJid, false);
  });

  it('does not change queued typing in a non-paired room even if opted in', async () => {
    hasReviewerLeaseMock.mockReturnValue(false);
    getLatestOpenPairedTaskForChatMock.mockReturnValue(null);
    const test = harness();
    const trustedEvent = {
      ...test.peer,
      is_bot_message: false,
      message_source_kind: 'trusted_external_bot' as const,
    };
    test.args.groupMessages = [trustedEvent];
    vi.mocked(getMessagesSinceSeq).mockReturnValue([
      test.oldHuman,
      trustedEvent,
    ]);
    await processLoopGroupMessages(test.args);
    expect(test.channels[0].setTyping).toHaveBeenCalledWith(chatJid, true);
    expect(test.args.sendQueuedMessage).toHaveBeenCalledOnce();
    await test.channels[0].setTyping(chatJid, false);
  });
});
