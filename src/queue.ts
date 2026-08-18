export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  get size(): number {
    return this.pending;
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    this.pending += 1;
    const result = this.tail.then(task);
    const decrement = () => { this.pending -= 1; };
    this.tail = result.then(decrement, decrement);
    return result;
  }

  idle(): Promise<void> {
    return this.tail;
  }
}
