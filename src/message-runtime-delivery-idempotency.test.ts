import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createPairedTask,
  createProducedWorkItem,
  getOpenWorkItemForChat,
  getPairedTaskById,
  getWorkItemById,
} from './db.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import type { Channel } from './types.js';

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function channel(overrides: Partial<Channel>): Channel {
  return {
    name: 'test',
    connect: vi.fn(),
    sendMessage: vi.fn(),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe('persisted delivery idempotency', () => {
  beforeEach(() => {
    _initTestDatabase();
    vi.clearAllMocks();
  });

  it('retries with the same persisted key on an idempotent channel', async () => {
    const item = createProducedWorkItem({
      group_folder: 'room',
      chat_jid: 'dc:delivery',
      agent_type: 'codex',
      delivery_role: 'owner',
      delivery_key_seed: 'run-1',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'final',
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('ambiguous network close'))
      .mockResolvedValueOnce({
        primaryMessageId: 'message-1',
        messageIds: ['message-1'],
        visible: true,
      });
    const target = channel({
      sendMessage,
      supportsIdempotentDelivery: () => true,
    });
    const deliver = () =>
      deliverOpenWorkItem({
        channel: target,
        item,
        log,
        isDuplicateOfLastBotFinal: () => false,
        openContinuation: vi.fn(),
      });

    await expect(deliver()).resolves.toBe(false);
    await expect(deliver()).resolves.toBe(true);
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'dc:delivery', 'final', {
      deliveryKey: item.delivery_key,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'dc:delivery', 'final', {
      deliveryKey: item.delivery_key,
    });
    expect(
      getOpenWorkItemForChat('dc:delivery', item.service_id),
    ).toBeUndefined();
  });

  it('does not auto-retry an uncertain non-idempotent channel delivery', async () => {
    const now = '2026-07-27T00:00:00.000Z';
    createPairedTask({
      id: 'goal-uncertain',
      chat_jid: 'dc:uncertain',
      group_folder: 'room',
      work_dir: '/tmp',
      owner_service_id: 'codex-main',
      reviewer_service_id: 'claude-review',
      title: null,
      source_ref: null,
      plan_notes: null,
      review_requested_at: null,
      round_trip_count: 0,
      owner_failure_count: 0,
      owner_step_done_streak: 0,
      finalize_step_done_count: 0,
      task_done_then_user_reopen_count: 0,
      empty_step_done_streak: 0,
      status: 'active',
      arbiter_verdict: null,
      arbiter_requested_at: null,
      completion_reason: null,
      supervisor_state: 'runnable',
      created_at: now,
      updated_at: now,
    });
    const item = createProducedWorkItem({
      group_folder: 'room',
      chat_jid: 'dc:uncertain',
      agent_type: 'codex',
      delivery_role: 'owner',
      paired_task_id: 'goal-uncertain',
      delivery_key_seed: 'run-uncertain',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'final',
    });

    await expect(
      deliverOpenWorkItem({
        channel: channel({
          sendMessage: vi
            .fn()
            .mockRejectedValue(new Error('unknown provider result')),
        }),
        item,
        log,
        isDuplicateOfLastBotFinal: () => false,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(false);

    expect(
      getOpenWorkItemForChat('dc:uncertain', item.service_id),
    ).toBeUndefined();
    expect(getWorkItemById(item.id)).toMatchObject({ delivery_uncertain: 1 });
    expect(getPairedTaskById('goal-uncertain')).toMatchObject({
      supervisor_state: 'waiting_user',
      last_blocker_class: 'external',
    });
  });

  it('removes tracked progress after replacement fails and fallback delivery succeeds', async () => {
    const item = createProducedWorkItem({
      group_folder: 'room',
      chat_jid: 'dc:delivery',
      agent_type: 'claude-code',
      delivery_role: 'reviewer',
      delivery_key_seed: 'run-long-final',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'x'.repeat(2_017),
    });
    const editMessage = vi
      .fn()
      .mockRejectedValue(new Error('Must be 2000 or fewer in length'));
    const sendMessage = vi.fn().mockResolvedValue({
      primaryMessageId: 'final-1',
      messageIds: ['final-1', 'final-2'],
      visible: true,
    });
    const deleteMessage = vi.fn().mockResolvedValue(undefined);

    await expect(
      deliverOpenWorkItem({
        channel: channel({ editMessage, sendMessage, deleteMessage }),
        item,
        log,
        replaceMessageId: 'progress-1',
        isDuplicateOfLastBotFinal: () => false,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(editMessage).toHaveBeenCalledWith(
      'dc:delivery',
      'progress-1',
      item.result_payload,
    );
    expect(sendMessage).toHaveBeenCalledWith(
      'dc:delivery',
      item.result_payload,
      { deliveryKey: item.delivery_key },
    );
    expect(deleteMessage).toHaveBeenCalledWith('dc:delivery', 'progress-1');
    expect(sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
      deleteMessage.mock.invocationCallOrder[0],
    );
    expect(getWorkItemById(item.id)).toMatchObject({
      status: 'delivered',
      delivery_message_id: 'final-1',
    });
  });

  it('keeps fallback delivery complete when tracked progress cleanup fails', async () => {
    const item = createProducedWorkItem({
      group_folder: 'room',
      chat_jid: 'dc:delivery',
      agent_type: 'claude-code',
      delivery_role: 'reviewer',
      delivery_key_seed: 'run-cleanup-failure',
      start_seq: 1,
      end_seq: 2,
      result_payload: 'final result',
    });
    const cleanupError = new Error('Missing Permissions');

    await expect(
      deliverOpenWorkItem({
        channel: channel({
          editMessage: vi.fn().mockRejectedValue(new Error('edit failed')),
          sendMessage: vi.fn().mockResolvedValue({
            primaryMessageId: 'final-1',
            messageIds: ['final-1'],
            visible: true,
          }),
          deleteMessage: vi.fn().mockRejectedValue(cleanupError),
        }),
        item,
        log,
        replaceMessageId: 'progress-1',
        isDuplicateOfLastBotFinal: () => false,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(true);

    expect(getWorkItemById(item.id)).toMatchObject({
      status: 'delivered',
      delivery_message_id: 'final-1',
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryMode: 'send',
        replacedMessageId: 'progress-1',
        err: cleanupError,
      }),
      'Failed to remove tracked progress message after fallback delivery',
    );
  });
});
