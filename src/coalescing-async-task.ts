export class CoalescingAsyncTask {
  private inFlight: Promise<void> | null = null;
  private requested = false;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly task: () => Promise<void>) {}

  request(): Promise<void> {
    this.requested = true;
    if (!this.inFlight) {
      this.inFlight = this.drain();
    }
    return this.inFlight;
  }

  cancelPending(): void {
    this.requested = false;
  }

  start(intervalMs: number, enabled = true): void {
    if (!enabled || this.ticker) return;
    this.ticker = setInterval(() => void this.request(), intervalMs);
  }

  stop(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  async waitForIdle(): Promise<void> {
    while (this.inFlight) {
      await this.inFlight;
    }
  }

  private async drain(): Promise<void> {
    try {
      while (this.requested) {
        this.requested = false;
        await this.task();
      }
    } finally {
      this.inFlight = null;
    }
  }
}
