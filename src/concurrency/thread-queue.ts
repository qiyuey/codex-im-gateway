export class ThreadQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly generations = new Map<string, number>();

  enqueue<T>(threadId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(threadId) ?? Promise.resolve();
    const generation = this.generations.get(threadId) ?? 0;
    const start = async () => {
      if ((this.generations.get(threadId) ?? 0) !== generation) {
        throw new ThreadQueueCancelledError();
      }
      return operation();
    };
    const result = previous.then(start, start);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(threadId, tail);
    void tail.finally(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    return result;
  }

  isBusy(threadId: string): boolean {
    return this.tails.has(threadId);
  }

  cancelPending(threadId: string): boolean {
    if (!this.tails.has(threadId)) return false;
    this.generations.set(threadId, (this.generations.get(threadId) ?? 0) + 1);
    return true;
  }
}

export class ThreadQueueCancelledError extends Error {
  constructor() {
    super("Queued thread operation was cancelled");
    this.name = "ThreadQueueCancelledError";
  }
}
