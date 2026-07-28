import type { Client, TextChannel } from 'discord.js';

import { logger } from '../logger.js';
import type { DeleteRecentMessagesByContentOptions } from '../types.js';

export async function deleteDiscordMessage(args: {
  client: Client | null;
  channelName: string;
  jid: string;
  messageId: string;
}): Promise<void> {
  if (!args.client) {
    throw new Error('Discord client not initialized');
  }
  try {
    const channelId = args.jid.replace(/^dc:/, '');
    const channel = await args.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Discord channel not found or not editable: ${args.jid}`);
    }
    const message = await (channel as TextChannel).messages.fetch(
      args.messageId,
    );
    await message.delete();
    logger.info(
      {
        jid: args.jid,
        channelName: args.channelName,
        deliveryMode: 'delete',
        messageId: args.messageId,
        botUserId: args.client.user?.id ?? null,
        botUsername: args.client.user?.username ?? null,
      },
      'Discord message deleted',
    );
  } catch (err) {
    logger.debug(
      {
        jid: args.jid,
        channelName: args.channelName,
        messageId: args.messageId,
        botUserId: args.client.user?.id ?? null,
        botUsername: args.client.user?.username ?? null,
        err,
      },
      'Failed to delete Discord message',
    );
    throw err;
  }
}

export async function editDiscordMessage(args: {
  client: Client | null;
  channelName: string;
  jid: string;
  messageId: string;
  text: string;
}): Promise<void> {
  if (!args.client) {
    throw new Error('Discord client not initialized');
  }
  try {
    const channelId = args.jid.replace(/^dc:/, '');
    const channel = await args.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) {
      throw new Error(`Discord channel not found or not editable: ${args.jid}`);
    }
    const message = await (channel as TextChannel).messages.fetch(
      args.messageId,
    );
    await message.edit(args.text);
    logger.info(
      {
        jid: args.jid,
        channelName: args.channelName,
        deliveryMode: 'edit',
        messageId: args.messageId,
        length: args.text.length,
        botUserId: args.client.user?.id ?? null,
        botUsername: args.client.user?.username ?? null,
      },
      'Discord message edited',
    );
  } catch (err) {
    logger.debug(
      {
        jid: args.jid,
        channelName: args.channelName,
        messageId: args.messageId,
        botUserId: args.client.user?.id ?? null,
        botUsername: args.client.user?.username ?? null,
        err,
      },
      'Failed to edit Discord message',
    );
    throw err;
  }
}

export async function deleteRecentDiscordMessagesByContent(args: {
  client: Client | null;
  channelName: string;
  jid: string;
  options: DeleteRecentMessagesByContentOptions;
}): Promise<number> {
  if (!args.client) return 0;

  const contentIncludes = args.options.contentIncludes.trim();
  if (!contentIncludes) return 0;

  let deleted = 0;
  try {
    const channelId = args.jid.replace(/^dc:/, '');
    const channel = await args.client.channels.fetch(channelId);
    if (!channel || !('messages' in channel)) return 0;

    const tc = channel as TextChannel;
    const messages = await tc.messages.fetch({
      limit: Math.max(1, Math.min(args.options.limit ?? 100, 100)),
    });
    const candidates = messages.filter(
      (message) =>
        message.author.id === args.client?.user?.id &&
        message.id !== args.options.exceptMessageId &&
        message.content.includes(contentIncludes),
    );
    if (candidates.size === 0) return 0;

    for (const [, message] of candidates) {
      await message.delete();
      deleted += 1;
    }

    logger.info(
      {
        jid: args.jid,
        deleted,
        exceptMessageId: args.options.exceptMessageId ?? null,
        channelName: args.channelName,
      },
      'Deleted duplicate Discord messages by content marker',
    );
  } catch (err) {
    logger.warn(
      {
        jid: args.jid,
        err,
        deleted,
        exceptMessageId: args.options.exceptMessageId ?? null,
        channelName: args.channelName,
      },
      'Failed to delete duplicate Discord messages by content marker',
    );
  }

  return deleted;
}
