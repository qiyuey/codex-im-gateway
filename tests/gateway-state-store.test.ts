import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GatewayDatabase } from "../src/storage/database.js";
import { CompletionEventStore } from "../src/storage/event-store.js";
import { GatewayStateStore } from "../src/storage/gateway-state-store.js";

let database: GatewayDatabase;
let state: GatewayStateStore;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  state = new GatewayStateStore(database);
});
afterEach(() => database.close());

describe("GatewayStateStore", () => {
  it("persists delivery, reply binding, and active context atomically", () => {
    const event = new CompletionEventStore(database).enqueue({
      idempotencyKey: "thread:turn",
      codexThreadId: "thread",
      codexTurnId: "turn",
      cwd: "/workspace",
      eventType: "completed",
    });

    state.recordSentDelivery(
      event.id,
      { channel: "telegram", chatId: "42" },
      "100",
      { threadId: "thread", turnId: "turn" },
      1_000,
    );

    expect(state.hasSentDelivery(event.id, { channel: "telegram", chatId: "42" })).toBe(true);
    expect(state.findMessageBinding("telegram", "42", "100")).toMatchObject({
      codexThreadId: "thread",
      codexTurnId: "turn",
    });
    expect(state.getActiveThread("telegram", "42")).toBe("thread");
  });

  it("normalizes null topic identifiers and detaches context", () => {
    state.setActiveThread("telegram", "42", null, "thread");
    expect(state.getActiveThread("telegram", "42", undefined)).toBe("thread");
    expect(state.detach("telegram", "42", null)).toBe(true);
    expect(state.getActiveThread("telegram", "42")).toBeNull();
  });
});
