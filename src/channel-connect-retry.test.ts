import { describe, expect, it, vi } from 'vitest';

import { connectChannelWithRetry } from './channel-connect-retry.js';

describe('connectChannelWithRetry', () => {
  it('returns immediately after a successful first connection', async () => {
    const channel = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      connectChannelWithRetry(channel, { sleep: wait }),
    ).resolves.toBe(1);
    expect(channel.connect).toHaveBeenCalledTimes(1);
    expect(channel.disconnect).not.toHaveBeenCalled();
    expect(wait).not.toHaveBeenCalled();
  });

  it('cleans up and retries transient connection failures with backoff', async () => {
    const transientError = new Error('network unavailable');
    const channel = {
      connect: vi
        .fn()
        .mockRejectedValueOnce(transientError)
        .mockRejectedValueOnce(transientError)
        .mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const wait = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();

    await expect(
      connectChannelWithRetry(channel, {
        initialDelayMs: 100,
        maxDelayMs: 150,
        sleep: wait,
        onRetry,
      }),
    ).resolves.toBe(3);

    expect(channel.connect).toHaveBeenCalledTimes(3);
    expect(channel.disconnect).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls).toEqual([[100], [150]]);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      maxAttempts: 5,
      retryDelayMs: 100,
      error: transientError,
    });
  });

  it('throws the last error after the configured attempts are exhausted', async () => {
    const finalError = new Error('still unavailable');
    const channel = {
      connect: vi.fn().mockRejectedValue(finalError),
      disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const wait = vi.fn().mockResolvedValue(undefined);

    await expect(
      connectChannelWithRetry(channel, {
        maxAttempts: 3,
        initialDelayMs: 10,
        maxDelayMs: 20,
        sleep: wait,
      }),
    ).rejects.toBe(finalError);

    expect(channel.connect).toHaveBeenCalledTimes(3);
    expect(channel.disconnect).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls).toEqual([[10], [20]]);
  });
});
