import { describe, expect, it } from 'vitest';

import type { NewMessage, RegisteredGroup } from './types.js';
import {
  createRoomMessageIdCache,
  handleRoomMessageRoute,
  type WebDashboardRoomMessage,
} from './web-dashboard-room-message-routes.js';

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
}

function roomMessageRequest(
  roomJid: string,
  body: unknown,
  method = 'POST',
): Request {
  return new Request(
    `http://localhost/api/rooms/${encodeURIComponent(roomJid)}/messages`,
    {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    },
  );
}

function makeDeps(
  overrides: {
    rooms?: Record<string, RegisteredGroup>;
    existingMessage?: (chatJid: string, id: string) => boolean;
    messages?: NewMessage[];
    published?: WebDashboardRoomMessage[];
    publishRoomMessage?: (message: WebDashboardRoomMessage) => Promise<void>;
    queued?: Array<{ chatJid: string; groupFolder: string }>;
    events?: string[];
  } = {},
) {
  const messages = overrides.messages ?? [];
  const published = overrides.published ?? [];
  const queued = overrides.queued ?? [];
  const events = overrides.events ?? [];
  return {
    enqueueMessageCheck: (chatJid: string, groupFolder: string) => {
      events.push('enqueue');
      queued.push({ chatJid, groupFolder });
    },
    loadRoomBindings: () =>
      overrides.rooms ?? {
        'dc:ops': {
          name: '#ops',
          folder: 'ops-room',
          added_at: '2026-04-26T05:00:00.000Z',
        },
      },
    messageExists: overrides.existingMessage ?? (() => false),
    publishRoomMessage:
      overrides.publishRoomMessage ??
      (async (message: WebDashboardRoomMessage) => {
        events.push('publish');
        published.push(message);
      }),
    rememberRoomMessageId: createRoomMessageIdCache(),
    writeChatMetadata: (
      _chatJid: string,
      _timestamp: string,
      _name?: string,
      _channel?: string,
      _isGroup?: boolean,
    ) => undefined,
    writeMessage: (message: NewMessage) => {
      events.push('store');
      messages.push(message);
    },
    events,
    messages,
    published,
    queued,
  };
}

describe('web dashboard room message routes', () => {
  it('expires the oldest remembered room message ids after the cache limit', () => {
    const remember = createRoomMessageIdCache(2);

    expect(remember('room:message-1')).toBe(true);
    expect(remember('room:message-1')).toBe(false);
    expect(remember('room:message-2')).toBe(true);
    expect(remember('room:message-3')).toBe(true);
    expect(remember('room:message-1')).toBe(true);
    expect(remember('room:message-2')).toBe(true);
  });

  it('releases remembered room message ids for retry', () => {
    const remember = createRoomMessageIdCache();

    expect(remember('room:message-1')).toBe(true);
    expect(remember('room:message-1')).toBe(false);
    remember.release('room:message-1');
    expect(remember('room:message-1')).toBe(true);
  });

  it('publishes to Discord before storing and queues messages once', async () => {
    const messages: NewMessage[] = [];
    const published: WebDashboardRoomMessage[] = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    const events: string[] = [];
    const deps = makeDeps({ events, messages, published, queued });

    const first = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      now: () => '2026-04-26T05:10:00.000Z',
      request: roomMessageRequest('dc:ops', {
        nickname: '  Fixture User  ',
        requestId: 'compose 1',
        text: '  run a dashboard check  ',
      }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    const second = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', {
        requestId: 'compose 1',
        text: 'second submit',
      }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    await expect(first?.json()).resolves.toMatchObject({
      id: 'web-compose-1',
      queued: true,
    });
    await expect(second?.json()).resolves.toMatchObject({
      id: 'web-compose-1',
      queued: false,
      duplicate: true,
    });
    expect(messages).toHaveLength(1);
    expect(published).toEqual([
      {
        chatJid: 'dc:ops',
        senderName: 'Fixture User',
        text: 'run a dashboard check',
      },
    ]);
    expect(messages[0]).toMatchObject({
      chat_jid: 'dc:ops',
      content: 'run a dashboard check',
      id: 'web-compose-1',
      message_source_kind: 'ipc_injected_human',
      sender: 'web-dashboard',
      sender_name: 'Fixture User',
      timestamp: '2026-04-26T05:10:00.000Z',
    });
    expect(events).toEqual(['publish', 'store', 'enqueue']);
    expect(queued).toEqual([{ chatJid: 'dc:ops', groupFolder: 'ops-room' }]);
  });

  it('does not store or queue when Discord publishing fails and allows retry', async () => {
    const messages: NewMessage[] = [];
    const queued: Array<{ chatJid: string; groupFolder: string }> = [];
    let publishAttempts = 0;
    let shouldFail = true;
    const deps = makeDeps({
      messages,
      queued,
      publishRoomMessage: async () => {
        publishAttempts += 1;
        if (shouldFail) throw new Error('Discord unavailable');
      },
    });
    const requestBody = {
      requestId: 'retry-after-publish-failure',
      text: 'retry me',
    };

    const failed = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', requestBody),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });

    expect(failed?.status).toBe(502);
    expect(messages).toHaveLength(0);
    expect(queued).toHaveLength(0);

    shouldFail = false;
    const retried = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', requestBody),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });

    expect(retried?.status).toBe(200);
    expect(publishAttempts).toBe(2);
    expect(messages).toHaveLength(1);
    expect(queued).toEqual([{ chatJid: 'dc:ops', groupFolder: 'ops-room' }]);
  });

  it('handles fall-through and invalid room message requests', async () => {
    const deps = makeDeps({ rooms: {} });

    const fallThrough = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: new Request('http://localhost/api/overview'),
      url: new URL('http://localhost/api/overview'),
    });
    expect(fallThrough).toBeNull();

    const notConfigured = await handleRoomMessageRoute({
      ...deps,
      enqueueMessageCheck: undefined,
      jsonResponse,
      request: roomMessageRequest('dc:ops', { text: 'hello' }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(notConfigured?.status).toBe(503);

    const empty = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', { text: '  ' }),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(empty?.status).toBe(400);

    const missing = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:missing', { text: 'hello' }),
      url: new URL('http://localhost/api/rooms/dc%3Amissing/messages'),
    });
    expect(missing?.status).toBe(404);

    const wrongMethod = await handleRoomMessageRoute({
      ...deps,
      jsonResponse,
      request: roomMessageRequest('dc:ops', null, 'GET'),
      url: new URL('http://localhost/api/rooms/dc%3Aops/messages'),
    });
    expect(wrongMethod?.status).toBe(405);
  });
});
