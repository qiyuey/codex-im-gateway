import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayDatabase } from "../src/storage/database.js";
import { OutboundNotificationStore } from "../src/storage/notification-store.js";

let database: GatewayDatabase;
let store: OutboundNotificationStore;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  store = new OutboundNotificationStore(database);
});

afterEach(() => database.close());

describe("OutboundNotificationStore", () => {
  it("deduplicates explicit notifications by caller-provided run key", () => {
    const first = enqueue();
    const duplicate = enqueue();

    expect(duplicate.id).toBe(first.id);
    expect(first.ingress).toEqual({
      producer: "internal",
      producerVersion: "0.1.0",
      protocolVersion: 1,
    });
    expect(store.counts()).toEqual({ queued: 1, leased: 0, delivered: 0, deadLetter: 0 });
  });

  it("leases and records the Telegram message identifier", () => {
    enqueue();
    const leased = store.leaseNext({ now: 1_100, leaseDurationMs: 500 });
    if (!leased?.leaseToken) throw new Error("Expected an active notification lease");

    const delivered = store.markDelivered(leased.id, leased.leaseToken, "telegram-42", 1_200);
    expect(delivered).toMatchObject({
      state: "delivered",
      platformMessageId: "telegram-42",
      leaseToken: null,
    });
  });

  it("persists an explicit bound-task source without inferring it from cwd", () => {
    const notification = store.enqueue({
      idempotencyKey: "bound:thread-1:turn-1",
      channel: "telegram",
      cwd: "/workspace/example",
      title: "Bound result",
      message: "Done.",
      source: { kind: "bound_task", codexThreadId: "thread-1", codexTurnId: "turn-1" },
    });

    expect(notification.source).toEqual({
      kind: "bound_task",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
  });

  it("persists an inherited thread binding without inventing a turn", () => {
    const notification = store.enqueue({
      idempotencyKey: "thread:thread-1",
      channel: "telegram",
      cwd: "/workspace/example",
      title: "Thread result",
      message: "Done.",
      source: { kind: "bound_thread", codexThreadId: "thread-1" },
    });

    expect(notification.source).toEqual({
      kind: "bound_thread",
      codexThreadId: "thread-1",
    });
  });

  it("redacts credentials from retry errors", () => {
    enqueue();
    const leased = store.leaseNext({ now: 1_100 });
    if (!leased?.leaseToken) throw new Error("Expected an active notification lease");

    const retry = store.markFailed(leased.id, leased.leaseToken, "token=secret", {
      now: 1_200,
      baseDelayMs: 100,
    });
    expect(retry.lastError).toBe("token=[REDACTED]");
    expect(retry.state).toBe("queued");
  });

  it("rejects an invalid empty notification before it reaches the queue", () => {
    expect(() =>
      store.enqueue({
        idempotencyKey: "explicit:invalid",
        channel: "telegram",
        cwd: "/workspace/example",
        title: "",
        message: "Result",
        source: { kind: "notification_only" },
      }),
    ).toThrow(/title/);
    expect(store.counts().queued).toBe(0);
  });
});

function enqueue() {
  return store.enqueue(
    {
      idempotencyKey: "explicit:daily-report:2026-07-15",
      channel: "telegram",
      cwd: "/workspace/example",
      title: "Daily report",
      message: "All checks passed.",
      source: { kind: "notification_only" },
    },
    1_000,
  );
}
