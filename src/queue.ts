export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task, task);
    const decrement = () => { this.pending -= 1; };
    this.tail = result.then(decrement, decrement);
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}

/**
 * Registry of per-chat SerialQueues: same-chat tasks are serialized while
 * distinct chats run concurrently. Queues are created lazily on first use and
 * evicted once drained. This is the shared contract replacing Outbox's
 * chatOperations map (src/outbox.ts) and TelegramDeliveryQueue (src/telegram.ts).
 */
export class SerialQueueRegistry {
  private readonly queues = new Map<number, SerialQueue>();

  run<T>(chatId: number, task: () => T | PromiseLike<T>): Promise<T> {
    let queue = this.queues.get(chatId);
    if (!queue) {
      queue = new SerialQueue();
      this.queues.set(chatId, queue);
    }
    return queue.run(() => Promise.resolve(task())).finally(() => {
      if (queue.size === 0 && this.queues.get(chatId) === queue) {
        this.queues.delete(chatId);
      }
    });
  }

  /** Total queued-but-not-yet-done tasks across all live per-chat queues. */
  get size(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.size;
    return total;
  }

  /** Resolves once every live queue has drained, including tasks enqueued while waiting. */
  async idle(): Promise<void> {
    while (true) {
      const live = [...this.queues.values()];
      if (live.length === 0) return;
      await Promise.all(live.map((queue) => queue.idle().catch(() => undefined)));
      await Promise.resolve();
    }
  }
}
