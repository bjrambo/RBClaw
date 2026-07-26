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
});
