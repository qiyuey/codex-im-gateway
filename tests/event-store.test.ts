import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayDatabase } from "../src/storage/database.js";
import { CompletionEventStore } from "../src/storage/event-store.js";

let database: GatewayDatabase;
let store: CompletionEventStore;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  store = new CompletionEventStore(database);
});

afterEach(() => database.close());

describe("CompletionEventStore", () => {
  it("deduplicates events by thread and turn idempotency key", () => {
    const first = enqueue();
    const duplicate = enqueue();

    expect(duplicate.id).toBe(first.id);
    expect(store.counts()).toEqual({ queued: 1, leased: 0, delivered: 0, deadLetter: 0 });
  });

  it("leases and marks an event delivered with the matching token", () => {
    enqueue();
    const leased = store.leaseNext({ now: 1_100, leaseDurationMs: 500 });

    expect(leased).toMatchObject({ state: "leased", attemptCount: 1, leaseExpiresAt: 1_600 });
    if (!leased?.leaseToken) throw new Error("Expected an active lease");
    const leaseToken = leased.leaseToken;
    const delivered = store.markDelivered(leased.id, leaseToken, 1_200);
    expect(delivered.state).toBe("delivered");
    expect(() => store.markDelivered(leased.id, leaseToken, 1_300)).toThrow(/stale/);
  });

  it("recovers an expired lease after a restart boundary", () => {
    enqueue();
    store.leaseNext({ now: 1_100, leaseDurationMs: 100 });

    expect(store.recoverExpired(1_201)).toBe(1);
    expect(store.leaseNext({ now: 1_201 })).toMatchObject({ state: "leased", attemptCount: 2 });
  });

  it("backs off retries and moves exhausted events to dead letter", () => {
    enqueue();
    const first = store.leaseNext({ now: 1_100 });
    if (!first?.leaseToken) throw new Error("Expected the first lease");
    const retry = store.markFailed(first.id, first.leaseToken, "temporary token=secret", {
      now: 1_200,
      baseDelayMs: 100,
      maxAttempts: 2,
    });
    expect(retry).toMatchObject({ state: "queued", nextAttemptAt: 1_300 });
    expect(retry.lastError).toBe("temporary token=[REDACTED]");

    const second = store.leaseNext({ now: 1_300 });
    if (!second?.leaseToken) throw new Error("Expected the second lease");
    const dead = store.markFailed(second.id, second.leaseToken, "still failing", {
      now: 1_400,
      baseDelayMs: 100,
      maxAttempts: 2,
    });
    expect(dead.state).toBe("dead_letter");
  });
});

function enqueue() {
  return store.enqueue(
    {
      idempotencyKey: "thread-1:turn-1",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      cwd: "/workspace/example",
      eventType: "completed",
      payload: {},
    },
    1_000,
  );
}
