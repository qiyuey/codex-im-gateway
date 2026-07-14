import { describe, expect, it } from "vitest";
import { ThreadQueue, ThreadQueueCancelledError } from "../src/concurrency/thread-queue.js";

describe("ThreadQueue", () => {
  it("serializes the same thread while allowing different threads to run", async () => {
    const queue = new ThreadQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.enqueue("a", async () => {
      order.push("a1-start");
      await gate;
      order.push("a1-end");
    });
    const second = queue.enqueue("a", async () => order.push("a2"));
    const other = queue.enqueue("b", async () => order.push("b1"));
    await other;
    expect(order).toEqual(["a1-start", "b1"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["a1-start", "b1", "a1-end", "a2"]);
  });

  it("cancels queued operations without aborting the active operation", async () => {
    const queue = new ThreadQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = queue.enqueue("a", async () => gate);
    await Promise.resolve();
    const pending = queue.enqueue("a", async () => "should not run");
    expect(queue.cancelPending("a")).toBe(true);
    release();
    await active;
    await expect(pending).rejects.toBeInstanceOf(ThreadQueueCancelledError);
  });
});
