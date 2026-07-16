import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db.js', () => ({
  getLastHumanMessageTimestamp: vi.fn(() => null),
  getLatestOpenPairedTaskForChat: vi.fn(() => null),
  getMessagesSinceSeq: vi.fn(() => []),
  getPairedTurnOutputs: vi.fn(() => []),
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
} from './db.js';
import { processLoopGroupMessages } from './message-runtime-dispatch.js';
import { transitionPairedTaskStatus } from './paired-task-status.js';
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
const transitionPairedTaskStatusMock =
  transitionPairedTaskStatus as unknown as ReturnType<typeof vi.fn>;
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

  it('marks an active paired task as stopped when /stop interrupts it', async () => {
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

    expect(getLatestOpenPairedTaskForChat).toHaveBeenCalledWith(chatJid);
    expect(transitionPairedTaskStatusMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        currentStatus: 'owner_running',
        nextStatus: 'completed',
        expectedUpdatedAt: '2026-04-29T13:25:00.000Z',
        patch: { completion_reason: 'stopped' },
      }),
    );
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
