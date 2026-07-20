import { expect, it } from "vitest";
import { SerialQueue } from "../src/queue.js";

it("serializes tasks in arrival order and continues after failure", async () => {
  const queue = new SerialQueue();
  const seen: number[] = [];
  const first = queue.run(async () => { await new Promise((r) => setTimeout(r, 10)); seen.push(1); });
  const second = queue.run(async () => { seen.push(2); throw new Error("expected"); });
  const third = queue.run(async () => { seen.push(3); });
  await Promise.allSettled([first, second, third]);
  expect(seen).toEqual([1, 2, 3]);
  expect(queue.size).toBe(0);
});
