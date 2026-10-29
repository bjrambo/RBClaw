import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./agent-runner.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createAgentRunnerMock();
});
vi.mock('./config.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createConfigMock();
});
vi.mock('./paired-execution-context.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createPairedExecutionContextMock();
});
vi.mock('./db.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createDbMock();
});
vi.mock('./service-routing.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createServiceRoutingMock();
});
vi.mock('./logger.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createLoggerMock();
});
vi.mock('./sender-allowlist.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSenderAllowlistMock();
});
vi.mock('./session-commands.js', async () => {
  const mocks = await import('../test/helpers/message-runtime-mocks.js');
  return mocks.createSessionCommandsMock();
});

import * as agentRunner from './agent-runner.js';
import * as db from './db.js';
import { createMessageRuntime } from './message-runtime.js';
import { processMessageLoopTick } from './message-runtime-loop.js';
import { resetPairedFollowUpScheduleState } from './paired-follow-up-scheduler.js';
import * as serviceRouting from './service-routing.js';
import { resolveOwnerTaskForHumanMessage } from './paired-execution-context.js';
import type { NewMessage, PairedTask } from './types.js';
import {
  makeChannel,
  makeGroup,
} from '../test/helpers/message-runtime-fixtures.js';

const chatJid = 'dc:completed-task-test';
const peerMessage = (overrides: Partial<NewMessage> = {}): NewMessage => ({
  id: 'final-review',
  chat_jid: chatJid,
  sender: 'reviewer-bot',
  sender_name: 'Reviewer',
  content: 'TASK_DONE\n검토 승인',
  timestamp: '2026-10-26T11:14:33.598Z',
  seq: 51,
  is_from_me: false,
  is_bot_message: true,
  message_source_kind: 'bot',
  ...overrides,
});

function harness(messages: NewMessage[]) {
  const group = makeGroup('codex');
  const channels = ['discord', 'discord-review', 'discord-arbiter'].map(
    (name, index) => ({
      ...makeChannel(chatJid, name, index === 0),
      isOwnMessage: vi.fn(
        (message: NewMessage) =>
          !!message.is_bot_message &&
          message.sender ===
            ['owner-bot', 'reviewer-bot', 'arbiter-bot'][index],
      ),
    }),
  );
  const cursors: Record<string, string> = {};
  const saveState = vi.fn();
  const enqueueMessageCheck = vi.fn();
  const sendQueuedMessage = vi.fn(() => false);
  vi.mocked(db.getMessagesSince).mockImplementation((_jid, since = '0') =>
    messages.filter((message) => (message.seq ?? 0) > Number(since)),
  );
  vi.mocked(agentRunner.runAgentProcess).mockImplementation(
    async (_group, _input, _onProcess, onOutput) => {
      await onOutput?.({ status: 'success', result: '처리 결과' });
      return { status: 'success', result: '처리 결과' };
    },
  );
  const runtime = createMessageRuntime({
    assistantName: 'Andy',
    idleTimeout: 1_000,
    pollInterval: 1_000,
    timezone: 'UTC',
    triggerPattern: /^@Andy\b/i,
    channels,
    queue: {
      enqueueMessageCheck,
      registerProcess: vi.fn(),
      closeStdin: vi.fn(),
      notifyIdle: vi.fn(),
    } as any,
    getRoomBindings: () => ({ [chatJid]: group }),
    getSessions: () => ({}),
    getLastTimestamp: () => '0',
    setLastTimestamp: vi.fn(),
    getLastAgentTimestamps: () => cursors,
    saveState,
    persistSession: vi.fn(),
    clearSession: vi.fn(),
  });
  const runQueue = () =>
    runtime.processGroupMessages(chatJid, {
      runId: 'completed-task-queue',
      reason: 'messages',
    });
  const runPoller = async (newMessages = messages) => {
    vi.mocked(db.getNewMessagesBySeq).mockReturnValue({
      messages: newMessages,
      newSeqCursor: String(newMessages.at(-1)?.seq ?? 0),
    });
    await processMessageLoopTick({
      assistantName: 'Andy',
      failureFinalText: 'FAILED',
      triggerPattern: /^@Andy\b/i,
      timezone: 'UTC',
      channels,
      getRoomBindings: () => ({ [chatJid]: group }),
      getLastTimestamp: () => '0',
      setLastTimestamp: vi.fn(),
      lastAgentTimestamps: cursors,
      saveState,
      hasImplicitContinuationWindow: () => false,
      executeTurn: vi.fn(),
      enqueuePendingHandoffs: vi.fn(),
      schedulePairedFollowUpWithMessageCheck: vi.fn(() => true),
      enqueueScopedGroupMessageCheck: enqueueMessageCheck,
      sendQueuedMessage,
      closeStdin: vi.fn(),
      killProcess: vi.fn(() => false),
      isRunningMessageTurn: () => true,
      labelPairedSenders: (_jid, pending) => pending,
    });
  };
  return {
    runQueue,
    runPoller,
    channels,
    cursors,
    saveState,
    enqueueMessageCheck,
    sendQueuedMessage,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  resetPairedFollowUpScheduleState();
  vi.mocked(serviceRouting.hasReviewerLease).mockReturnValue(true);
  vi.mocked(db.getLastBotFinalMessage).mockReturnValue([]);
  vi.mocked(db.getRecentChatMessages).mockReturnValue([]);
});

describe('completed-task paired bot messages', () => {
  it.each(['reviewer-bot', 'arbiter-bot'])(
    'does not run an owner or send another message for a late %s message',
    async (sender) => {
      const test = harness([peerMessage({ sender })]);
      await expect(test.runQueue()).resolves.toBe(true);
      await expect(test.runQueue()).resolves.toBe(true);
      expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
      expect(test.channels[0].sendMessage).not.toHaveBeenCalled();
      expect(test.cursors[chatJid]).toBe('51');
      expect(test.saveState).toHaveBeenCalled();
    },
  );

  it('does not pipe a late final report into a running agent or enqueue another run', async () => {
    const test = harness([peerMessage()]);
    await test.runPoller();
    expect(test.sendQueuedMessage).not.toHaveBeenCalled();
    expect(test.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(test.cursors[chatJid]).toBe('51');
  });

  it('consumes report continuation chunks without requiring a completion status line', async () => {
    const test = harness([
      peerMessage(),
      peerMessage({
        id: 'last-chunk',
        seq: 52,
        content: '남은 검증 항목과 주의사항입니다.',
      }),
    ]);
    await test.runPoller();
    await test.runQueue();
    expect(test.sendQueuedMessage).not.toHaveBeenCalled();
    expect(test.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(agentRunner.runAgentProcess).not.toHaveBeenCalled();
    expect(test.cursors[chatJid]).toBe('52');
  });

  it('does not suppress an unrelated bot based on its display name or verdict', async () => {
    const test = harness([
      peerMessage({ sender: 'external-bot', sender_name: 'reviewer' }),
    ]);
    await test.runQueue();
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'preserves trusted external events with bot flag %s',
    async (is_bot_message) => {
      const test = harness([
        peerMessage({
          message_source_kind: 'trusted_external_bot',
          is_bot_message,
        }),
      ]);
      await test.runQueue();
      expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    },
  );

  it('processes a new human request even when it arrives with the old final report', async () => {
    const human = peerMessage({
      id: 'new-request',
      sender: 'user',
      sender_name: 'User',
      seq: 52,
      content: '다음 작업 해줘',
      is_bot_message: false,
      message_source_kind: 'human',
    });
    const test = harness([peerMessage(), human]);
    await test.runQueue();
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(resolveOwnerTaskForHumanMessage).toHaveBeenCalled();
    expect(test.cursors[chatJid]).toBe('52');
  });

  it('does not discard a human quoting a final report', async () => {
    const test = harness([
      peerMessage({
        sender: 'user',
        is_bot_message: false,
        message_source_kind: 'human',
      }),
    ]);
    await test.runQueue();
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(resolveOwnerTaskForHumanMessage).toHaveBeenCalled();
  });

  it('does not advance past an older unprocessed human request when only the peer report is newly polled', async () => {
    const human = peerMessage({
      id: 'pending-request',
      sender: 'user',
      seq: 50,
      content: '아직 처리 안 된 요청',
      is_bot_message: false,
      message_source_kind: 'human',
    });
    const report = peerMessage();
    const test = harness([human, report]);
    await test.runPoller([report]);
    expect(test.enqueueMessageCheck).toHaveBeenCalledWith(
      chatJid,
      expect.any(String),
    );
    expect(test.cursors[chatJid]).toBeUndefined();
  });

  it('preserves an owner-to-reviewer handoff while a task remains open', async () => {
    const task = {
      id: 'open-review',
      chat_jid: chatJid,
      group_folder: 'test-codex',
      work_dir: '/repo',
      owner_service_id: 'claude',
      reviewer_service_id: 'codex-main',
      owner_agent_type: 'codex',
      reviewer_agent_type: 'claude-code',
      status: 'review_ready',
      review_phase: 'implementation',
      round_trip_count: 1,
      created_at: '2026-10-26T11:00:00.000Z',
      updated_at: '2026-10-26T11:13:00.000Z',
    } as PairedTask;
    vi.mocked(db.getLatestOpenPairedTaskForChat).mockReturnValue(task);
    vi.mocked(db.getPairedTaskById).mockReturnValue(task);
    const test = harness([peerMessage()]);
    await test.runQueue();
    expect(agentRunner.runAgentProcess).toHaveBeenCalledTimes(1);
    expect(test.channels[1].sendMessage).toHaveBeenCalled();
  });
});
