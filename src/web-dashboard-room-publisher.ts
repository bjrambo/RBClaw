import { findChannel, formatOutbound } from './router.js';
import type { Channel } from './types.js';
import type { WebDashboardRoomMessage } from './web-dashboard-room-message-routes.js';

export function formatWebDashboardRoomMessage(
  message: Pick<WebDashboardRoomMessage, 'senderName' | 'text'>,
): string {
  return `[WEB] ${message.senderName}\n${message.text}`;
}

export async function publishWebDashboardRoomMessage(
  channels: Channel[],
  message: WebDashboardRoomMessage,
): Promise<void> {
  const channel = findChannel(channels, message.chatJid);
  if (!channel) {
    throw new Error(`No channel owns room JID: ${message.chatJid}`);
  }

  const text = formatOutbound(formatWebDashboardRoomMessage(message));
  if (!text) {
    throw new Error('Web dashboard room message is empty after formatting');
  }

  const result = await channel.sendMessage(message.chatJid, text);
  if (result && !result.visible) {
    throw new Error('Web dashboard room message was not visible in Discord');
  }
}
