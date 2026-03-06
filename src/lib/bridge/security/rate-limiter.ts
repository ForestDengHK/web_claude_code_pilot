export class ChatRateLimiter {
  private buckets = new Map<string, number[]>();

  constructor(
    private maxMessages: number = 20,
    private windowMs: number = 60_000,
  ) {}

  /**
   * Acquire a slot for the given chatId using a sliding window.
   * If the bucket is full, delays until the oldest message exits the window.
   */
  async acquire(chatId: string): Promise<void> {
    const now = Date.now();
    let timestamps = this.buckets.get(chatId);

    if (!timestamps) {
      timestamps = [];
      this.buckets.set(chatId, timestamps);
    }

    // Prune timestamps outside the current window
    const cutoff = now - this.windowMs;
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    // If at capacity, wait until the oldest timestamp exits the window
    if (timestamps.length >= this.maxMessages) {
      const oldestTs = timestamps[0];
      const waitMs = oldestTs + this.windowMs - now;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      // Prune again after waiting
      const newCutoff = Date.now() - this.windowMs;
      while (timestamps.length > 0 && timestamps[0] <= newCutoff) {
        timestamps.shift();
      }
    }

    timestamps.push(Date.now());
  }

  /**
   * Remove buckets that have been idle for longer than windowMs.
   */
  cleanup(): void {
    const now = Date.now();
    for (const [chatId, timestamps] of this.buckets) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] + this.windowMs < now) {
        this.buckets.delete(chatId);
      }
    }
  }
}
