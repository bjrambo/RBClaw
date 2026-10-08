import type { ChildProcess } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./service-routing.js', async () => {
  const actual = await vi.importActual<typeof import('./service-routing.js')>(
    './service-routing.js',
  );
  return { ...actual, hasReviewerLease: () => false };
});

// Exercise the real queue lifecycle without sending signals or writing IPC files.
vi.mock('./group-queue-ipc.js', () => ({
  writeCloseSentinel: vi.fn(),
  queueFollowUpMessage: vi.fn(),
}));

import {
  _initTestDatabase,
  getMessagesSinceSeq,
  getSessionForAgentType,
  setSessionForAgentType,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { createProcessGroupMessages } from './message-runtime-group-processing.js';
import { processMessageLoopTick } from './message-runtime-loop.js';
import { advanceLastAgentCursor } from './message-runtime-rules.js';
import type { ExecuteTurnFn } from './message-runtime-types.js';
import type { Channel, NewMessage, RegisteredGroup } from './types.js';

const chatJid = 'stop@test';
const timestamp = '2026-10-08T14:57:28.000Z';
const group: RegisteredGroup = {
  name: 'Stop regression',
  folder: 'stop-test',
  trigger: '@Andy',
  added_at: timestamp,
  isMain: true,
  requiresTrigger: false,
  agentType: 'codex',
};

function addMessage(id: string, content: string): NewMessage {
  storeMessage({
    id,
    chat_jid: chatJid,
    sender: 'human',
    sender_name: 'Human',
    content,
    // Deliberately identical timestamps: only seq may consume the command.
    timestamp,
    is_bot_message: false,
  });
  return getMessagesSinceSeq(chatJid, '0', 'Andy').find(
    (message) => message.id === id,
  )!;
}

function harness() {
  const queue = new GroupQueue();
  const lastAgentTimestamps: Record<string, string> = {};
  let loopCursor = '0';
  let finishFirst!: (result: Awaited<ReturnType<ExecuteTurnFn>>) => void;
  const firstTurn = new Promise<Awaited<ReturnType<ExecuteTurnFn>>>(
    (resolve) => {
      finishFirst = resolve;
    },
  );
  const proc = {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      proc.signalCode = signal;
      return true;
    }),
  };
  const channel: Channel = {
    name: 'discord',
    connect: vi.fn(),
    sendMessage: vi.fn(async () => undefined),
    isConnected: () => true,
    ownsJid: (jid) => jid === chatJid,
    disconnect: vi.fn(),
  };
  const executeTurn = vi.fn<ExecuteTurnFn>(async () => {
    if (executeTurn.mock.calls.length === 1) {
      queue.registerProcess(
        chatJid,
        proc as unknown as ChildProcess,
        'fake',
        '',
      );
      return firstTurn;
    }
    return {
      outputStatus: 'success',
      deliverySucceeded: true,
      visiblePhase: 'final',
    };
  });
  const clearSession = vi.fn();
  const runAgent = vi.fn(async () => 'success' as const);
  const shared = {
    assistantName: 'Andy',
    failureFinalText: 'FAILED',
    timezone: 'Asia/Seoul',
    triggerPattern: /^@Andy\b/,
    channels: [channel],
    getRoomBindings: () => ({ [chatJid]: group }),
    saveState: vi.fn(),
    hasImplicitContinuationWindow: () => false,
    executeTurn,
    labelPairedSenders: (_jid: string, messages: NewMessage[]) => messages,
  };
  queue.setProcessMessagesFn(
    createProcessGroupMessages({
      ...shared,
      queue,
      getLastAgentTimestamps: () => lastAgentTimestamps,
      clearSession,
      runAgent,
      openContinuation: vi.fn(),
      isDuplicateOfLastBotFinal: () => false,
    }),
  );
  const tick = () =>
    processMessageLoopTick({
      ...shared,
      lastAgentTimestamps,
      getLastTimestamp: () => loopCursor,
      setLastTimestamp: (cursor) => {
        loopCursor = cursor;
      },
      enqueuePendingHandoffs: vi.fn(),
      schedulePairedFollowUpWithMessageCheck: vi.fn(() => true),
      enqueueScopedGroupMessageCheck: (jid) => queue.enqueueMessageCheck(jid),
      sendQueuedMessage: () => false,
      closeStdin: (jid, reason) => queue.closeStdin(jid, { reason }),
      killProcess: (jid) => queue.killProcess(jid),
      isRunningMessageTurn: (jid) =>
        queue.getStatuses([jid])[0]?.runPhase === 'running_messages',
      isActiveRunInputMessage: (jid, message) =>
        queue.isActiveMessageRunInput(jid, message),
    });

  return {
    queue,
    proc,
    channel,
    executeTurn,
    clearSession,
    runAgent,
    lastAgentTimestamps,
    finishFirst,
    tick,
  };
}

const settle = () => vi.advanceTimersByTimeAsync(1);

describe('/stop through the message loop, queued command gate and queue cleanup', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(chatJid, timestamp, 'Stop regression');
    setSessionForAgentType(group.folder, 'codex', 'existing-session');
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    { outputStatus: 'success' as const, visiblePhase: 'final' },
    { outputStatus: 'error' as const, visiblePhase: 'final' },
    { outputStatus: 'error' as const, visiblePhase: 'silent' },
  ])(
    'does not replay /stop after late completion: $outputStatus/$visiblePhase',
    async (completion) => {
      const h = harness();
      addMessage('initial', 'first task');
      await h.tick();
      await settle();
      expect(h.executeTurn).toHaveBeenCalledTimes(1);

      const stop = addMessage('stop', '/stop');
      await h.tick();
      expect(h.proc.kill).toHaveBeenCalledOnce();
      expect(h.proc.kill).toHaveBeenCalledWith('SIGTERM');
      h.finishFirst({ ...completion, deliverySucceeded: true });
      await settle();
      expect(h.lastAgentTimestamps[chatJid]).toBe(String(stop.seq));

      const next = addMessage('next', 'next ordinary task');
      await h.tick();
      await settle();
      expect(h.executeTurn).toHaveBeenCalledTimes(2);
      expect(h.executeTurn.mock.calls[1][0].prompt).toContain(
        'next ordinary task',
      );
      expect(h.executeTurn.mock.calls[1][0].prompt).not.toContain('/stop');
      expect(h.lastAgentTimestamps[chatJid]).toBe(String(next.seq));
      expect(h.queue.getStatuses([chatJid])[0].runPhase).toBe('idle');
      expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
        chatJid,
        'Agent stopped.',
      );
      expect(h.clearSession).not.toHaveBeenCalled();
      expect(h.runAgent).not.toHaveBeenCalled();
      expect(getSessionForAgentType(group.folder, 'codex')).toBe(
        'existing-session',
      );
    },
  );

  it('drains the normal prompt after /stop in the same polled batch', async () => {
    const h = harness();
    addMessage('initial', 'first task');
    await h.tick();
    await settle();
    const stop = addMessage('stop', '/stop');
    const next = addMessage('next', 'immediate next task');
    await h.tick();
    expect(h.lastAgentTimestamps[chatJid]).toBe(String(stop.seq));
    expect(
      h.queue.getStatuses().find((status) => status.jid === chatJid)
        ?.pendingMessages,
    ).toBe(true);
    h.finishFirst({
      outputStatus: 'success',
      deliverySucceeded: true,
      visiblePhase: 'final',
    });
    await settle();

    expect(h.executeTurn).toHaveBeenCalledTimes(2);
    expect(h.executeTurn.mock.calls[1][0].prompt).toContain(
      'immediate next task',
    );
    expect(h.lastAgentTimestamps[chatJid]).toBe(String(next.seq));
    expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'Agent stopped.',
    );
  });

  it('keeps a fresh idle /stop notice and processes its same-timestamp successor', async () => {
    const h = harness();
    const stop = addMessage('stop', '/stop');
    await h.tick();
    expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'No agent is currently running in this room.',
    );
    expect(h.lastAgentTimestamps[chatJid]).toBe(String(stop.seq));

    // The first actual agent run is for the normal prompt, not for /stop.
    addMessage('next', 'normal after idle stop');
    await h.tick();
    await settle();
    expect(h.executeTurn).toHaveBeenCalledOnce();
    expect(h.executeTurn.mock.calls[0][0].prompt).toContain(
      'normal after idle stop',
    );
    h.finishFirst({
      outputStatus: 'success',
      deliverySucceeded: true,
      visiblePhase: 'final',
    });
    await settle();
    expect(h.clearSession).not.toHaveBeenCalled();
  });

  it('drains a queued idle /stop batch without consuming its successor by timestamp', async () => {
    const h = harness();
    const stop = addMessage('stop', '/stop');
    addMessage('next', 'same timestamp successor');
    // Recovery/queue path rather than the loop's immediate /stop interception.
    h.queue.enqueueMessageCheck(chatJid);
    await settle();
    expect(h.lastAgentTimestamps[chatJid]).toBe(String(stop.seq));
    expect(h.executeTurn).toHaveBeenCalledOnce();
    expect(h.executeTurn.mock.calls[0][0].prompt).toContain(
      'same timestamp successor',
    );
    expect(h.executeTurn.mock.calls[0][0].prompt).not.toContain('/stop');
    h.finishFirst({
      outputStatus: 'success',
      deliverySucceeded: true,
      visiblePhase: 'final',
    });
    await settle();
    expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'No agent is currently running in this room.',
      expect.objectContaining({ deliveryKey: expect.any(String) }),
    );
    expect(h.clearSession).not.toHaveBeenCalled();
  });

  it('does not repeat a command when the queue and poller overlap during preflight', async () => {
    const h = harness();
    addMessage('stop', '/stop');
    h.queue.enqueueMessageCheck(chatJid);
    // Let the queued processor read its snapshot before the poller consumes it.
    await Promise.resolve();
    await h.tick();
    await settle();
    expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'No agent is currently running in this room.',
    );
    expect(h.executeTurn).not.toHaveBeenCalled();
    expect(h.clearSession).not.toHaveBeenCalled();
  });

  it('deduplicates stored deliveries but keeps the notice for a distinct new /stop', async () => {
    const h = harness();
    const first = addMessage('stop', '/stop');
    await h.tick();
    const duplicate = addMessage('stop', '/stop');
    expect(duplicate.seq).toBe(first.seq);
    await h.tick();
    expect(h.channel.sendMessage).toHaveBeenCalledOnce();

    addMessage('new-stop', '/stop');
    await h.tick();
    expect(h.channel.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.executeTurn).not.toHaveBeenCalled();
    expect(h.clearSession).not.toHaveBeenCalled();
  });

  it('does not acknowledge a queued /stop a second time when the poller later observes it', async () => {
    const h = harness();
    addMessage('stop', '/stop');
    h.queue.enqueueMessageCheck(chatJid);
    await settle();
    await h.tick();
    await settle();
    expect(h.channel.sendMessage).toHaveBeenCalledExactlyOnceWith(
      chatJid,
      'No agent is currently running in this room.',
      expect.objectContaining({ deliveryKey: expect.any(String) }),
    );
    expect(h.executeTurn).not.toHaveBeenCalled();
  });

  it('does not regress a legacy timestamp cursor or a separate role cursor', () => {
    addMessage('initial', 'first task');
    const stop = addMessage('stop', '/stop');
    const reviewerKey = `${chatJid}:reviewer`;
    const cursors = { [chatJid]: timestamp, [reviewerKey]: '4' };
    const save = vi.fn();
    advanceLastAgentCursor(cursors, save, chatJid, 1);
    advanceLastAgentCursor(cursors, save, chatJid, '3', reviewerKey);
    expect(cursors).toEqual({ [chatJid]: timestamp, [reviewerKey]: '4' });
    expect(save).not.toHaveBeenCalled();
    advanceLastAgentCursor(cursors, save, chatJid, stop.seq!);
    expect(cursors).toEqual({
      [chatJid]: String(stop.seq),
      [reviewerKey]: '4',
    });
    expect(save).toHaveBeenCalledOnce();
  });
});
