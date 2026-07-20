export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => { this.pending -= 1; },
      () => { this.pending -= 1; },
    );
    return result;
  }

  async idle(): Promise<void> {
    await this.tail;
  }
}
