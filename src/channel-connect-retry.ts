import type { Channel } from './types.js';

export const CHANNEL_CONNECT_MAX_ATTEMPTS = 5;
export const CHANNEL_CONNECT_INITIAL_DELAY_MS = 1_000;
export const CHANNEL_CONNECT_MAX_DELAY_MS = 8_000;

export interface ChannelConnectRetryEvent {
  attempt: number;
  maxAttempts: number;
  retryDelayMs: number;
  error: unknown;
}

interface ChannelConnectRetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  onRetry?: (event: ChannelConnectRetryEvent) => void;
}

const sleep = (delayMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, delayMs));

export async function connectChannelWithRetry(
  channel: Pick<Channel, 'connect' | 'disconnect'>,
  options: ChannelConnectRetryOptions = {},
): Promise<number> {
  const maxAttempts = options.maxAttempts ?? CHANNEL_CONNECT_MAX_ATTEMPTS;
  const initialDelayMs =
    options.initialDelayMs ?? CHANNEL_CONNECT_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? CHANNEL_CONNECT_MAX_DELAY_MS;
  const wait = options.sleep ?? sleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await channel.connect();
      return attempt;
    } catch (error) {
      await channel.disconnect().catch(() => undefined);
      if (attempt === maxAttempts) throw error;

      const retryDelayMs = Math.min(
        initialDelayMs * 2 ** (attempt - 1),
        maxDelayMs,
      );
      options.onRetry?.({ attempt, maxAttempts, retryDelayMs, error });
      await wait(retryDelayMs);
    }
  }

  throw new Error('Channel connection attempts exhausted');
}
