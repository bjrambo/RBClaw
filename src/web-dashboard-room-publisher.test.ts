import { describe, expect, it, vi } from 'vitest';

import type { Channel, SendMessageResult } from './types.js';
import {
  formatWebDashboardRoomMessage,
  publishWebDashboardRoomMessage,
} from './web-dashboard-room-publisher.js';

function makeChannel(
  sendResult: SendMessageResult | void = {
    primaryMessageId: 'discord-message-1',
    messageIds: ['discord-message-1'],
    visible: true,
  },
): Channel {
  return {
    name: 'discord',
    connect: async () => undefined,
    disconnect: async () => undefined,
    isConnected: () => true,
    ownsJid: (jid) => jid === 'dc:ops',
    sendMessage: vi.fn(async () => sendResult),
  };
}

describe('web dashboard room publisher', () => {
  it('formats and publishes the web message to the owning channel', async () => {
    const channel = makeChannel();

    await publishWebDashboardRoomMessage([channel], {
      chatJid: 'dc:ops',
      senderName: 'Fixture_WEB',
      text: '웹에서 보낸 내용',
    });

    expect(channel.sendMessage).toHaveBeenCalledWith(
      'dc:ops',
      '[WEB] Fixture_WEB\n웹에서 보낸 내용',
    );
    expect(
      formatWebDashboardRoomMessage({
        senderName: 'Fixture_WEB',
        text: '웹에서 보낸 내용',
      }),
    ).toBe('[WEB] Fixture_WEB\n웹에서 보낸 내용');
  });

  it('rejects missing or invisible Discord delivery', async () => {
    await expect(
      publishWebDashboardRoomMessage([], {
        chatJid: 'dc:missing',
        senderName: 'Fixture_WEB',
        text: 'missing room',
      }),
    ).rejects.toThrow('No channel owns room JID');

    const invisibleChannel = makeChannel({
      primaryMessageId: null,
      messageIds: [],
      visible: false,
    });
    await expect(
      publishWebDashboardRoomMessage([invisibleChannel], {
        chatJid: 'dc:ops',
        senderName: 'Fixture_WEB',
        text: 'invisible message',
      }),
    ).rejects.toThrow('was not visible in Discord');
  });
});
