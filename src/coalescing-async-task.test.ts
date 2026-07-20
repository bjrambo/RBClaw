import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoalescingAsyncTask } from './coalescing-async-task.js';

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) {
    await Promise.resolve();
  }
}

describe('CoalescingAsyncTask', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps periodic work single-flight and coalesces delayed ticks', async () => {
    vi.useFakeTimers();
    let activeTasks = 0;
    let maxActiveTasks = 0;
    let taskCalls = 0;
    const resolveTasks: Array<() => void> = [];
    const runner = new CoalescingAsyncTask(async () => {
      taskCalls++;
      activeTasks++;
      maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
      await new Promise<void>((resolve) => resolveTasks.push(resolve));
      activeTasks--;
    });

    try {
      runner.start(5_000);
      vi.advanceTimersByTime(15_000);

      expect(taskCalls).toBe(1);
      expect(activeTasks).toBe(1);
      expect(maxActiveTasks).toBe(1);

      resolveTasks.shift()?.();
      await flushMicrotasks();

      expect(taskCalls).toBe(2);
      expect(activeTasks).toBe(1);
      expect(maxActiveTasks).toBe(1);

      runner.stop();
      runner.cancelPending();
      resolveTasks.shift()?.();
      await runner.waitForIdle();

      expect(taskCalls).toBe(2);
      expect(activeTasks).toBe(0);
    } finally {
      runner.stop();
      for (const resolve of resolveTasks) resolve();
    }
  });
});
