import { createHash } from 'crypto';

import type { MessageCreateOptions, TextChannel } from 'discord.js';

export function createDeliverySender(
  channel: TextChannel,
  deliveryKey?: string,
) {
  let index = 0;
  return (payload: MessageCreateOptions) => {
    const identity = deliveryKey
      ? {
          nonce: createHash('sha256')
            .update(`${deliveryKey}:${index}`)
            .digest('hex')
            .slice(0, 24),
          enforceNonce: true,
        }
      : {};
    index += 1;
    return channel.send({ ...payload, ...identity });
  };
}
