import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _initTestDatabase,
  createProducedWorkItem,
  getWorkItemById,
} from './db.js';
import { deliverOpenWorkItem } from './message-runtime-delivery.js';
import type { Channel } from './types.js';

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const text =
  'TASK_DONE — 최종 결정사항\n[과업 report-task]\n\n설정 수정, 테스트 통과, 배포 미실행.';
const makeItem = () =>
  createProducedWorkItem({
    group_folder: 'room',
    chat_jid: 'dc:report',
    agent_type: 'codex',
    delivery_role: 'reviewer',
    paired_task_id: 'report-task',
    delivery_key_seed: 'report-run',
    start_seq: null,
    end_seq: null,
    result_payload: text,
  });
const makeChannel = (overrides: Partial<Channel>): Channel => ({
  name: 'test',
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendMessage: vi.fn(),
  isConnected: () => true,
  ownsJid: () => true,
  ...overrides,
});

beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
});

describe('final report publication and durable retries', () => {
  it('posts a new visible final report before removing only the tracked progress message', async () => {
    const item = makeItem();
    const deliveryEvents: string[] = [];
    const sendMessage = vi.fn(async () => {
      deliveryEvents.push('report-sent');
      return {
        primaryMessageId: 'report-1',
        messageIds: ['report-1'],
        visible: true,
      };
    });
    const editMessage = vi.fn();
    const deleteMessage = vi.fn(async () => {
      deliveryEvents.push('progress-removed');
    });
    const duplicate = vi.fn(() => true);
    await expect(
      deliverOpenWorkItem({
        channel: makeChannel({
          sendMessage,
          editMessage,
          deleteMessage,
          supportsIdempotentDelivery: () => true,
        }),
        item,
        log,
        replaceMessageId: 'old-progress',
        isDuplicateOfLastBotFinal: duplicate,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(true);
    expect(duplicate).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(
      'dc:report',
      'old-progress',
    );
    expect(deliveryEvents).toEqual(['report-sent', 'progress-removed']);
    expect(sendMessage).toHaveBeenCalledWith('dc:report', text, {
      deliveryKey: item.delivery_key,
    });
    expect(getWorkItemById(item.id)).toMatchObject({
      status: 'delivered',
      delivery_message_id: 'report-1',
    });
  });

  it.each([
    undefined,
    { primaryMessageId: null, messageIds: [], visible: false },
    { primaryMessageId: 'hidden', messageIds: ['hidden'], visible: false },
    { primaryMessageId: null, messageIds: ['orphan'], visible: true },
    { primaryMessageId: 'message', messageIds: [], visible: true },
  ])('rejects invisible or receipt-less success: %j', async (receipt) => {
    const item = makeItem();
    const deleteMessage = vi.fn();
    const editMessage = vi.fn();
    await expect(
      deliverOpenWorkItem({
        channel: makeChannel({
          sendMessage: vi.fn().mockResolvedValue(receipt),
          deleteMessage,
          editMessage,
          supportsIdempotentDelivery: () => true,
        }),
        item,
        log,
        replaceMessageId: 'old-progress',
        isDuplicateOfLastBotFinal: () => false,
        openContinuation: vi.fn(),
      }),
    ).resolves.toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(editMessage).not.toHaveBeenCalled();
    expect(getWorkItemById(item.id)).toMatchObject({
      status: 'delivery_retry',
      delivery_message_id: null,
    });
  });

  it('retries partial sends using the saved body and identical delivery key', async () => {
    const item = makeItem();
    const deleteMessage = vi.fn();
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('partial delivery'))
      .mockResolvedValueOnce({
        primaryMessageId: 'chunk-1',
        messageIds: ['chunk-1', 'chunk-2'],
        visible: true,
      });
    const channel = makeChannel({
      sendMessage,
      deleteMessage,
      supportsIdempotentDelivery: () => true,
    });
    const deliver = (stored: typeof item) =>
      deliverOpenWorkItem({
        channel,
        item: stored,
        log,
        replaceMessageId: 'old-progress',
        isDuplicateOfLastBotFinal: () => true,
        openContinuation: vi.fn(),
      });
    await expect(deliver(item)).resolves.toBe(false);
    expect(deleteMessage).not.toHaveBeenCalled();
    await expect(deliver(getWorkItemById(item.id)!)).resolves.toBe(true);
    expect(deleteMessage).toHaveBeenCalledExactlyOnceWith(
      'dc:report',
      'old-progress',
    );
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'dc:report', text, {
      deliveryKey: item.delivery_key,
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'dc:report', text, {
      deliveryKey: item.delivery_key,
    });
    expect(getWorkItemById(item.id)).toMatchObject({
      status: 'delivered',
      delivery_receipts: JSON.stringify(['chunk-1', 'chunk-2']),
    });
  });
});
