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
  it("persists delivery and reply binding without changing active routing", () => {
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
    expect(state.getActiveThread("telegram", "42")).toBeNull();
    expect(
      state.getTerminalDeliveryMessageId({ channel: "telegram", chatId: "42" }, "thread", "turn"),
    ).toBe("100");
  });

  it("normalizes null topic identifiers and detaches context", () => {
    state.selectAndWatchThread("telegram", "42", null, "thread", { turnId: "turn-1" });
    expect(state.getActiveThread("telegram", "42", undefined)).toBe("thread");
    expect(state.getThreadWatch("telegram", "42")).toMatchObject({
      codexThreadId: "thread",
      lastDeliveredTurnId: "turn-1",
    });
    expect(state.detach("telegram", "42", null)).toBe(true);
    expect(state.getActiveThread("telegram", "42")).toBeNull();
    expect(state.getThreadWatch("telegram", "42")).toBeNull();
  });

  it("conditionally detaches only the expected active thread", () => {
    state.selectAndWatchThread("telegram", "42", null, "thread-1");

    expect(state.detachIfActiveThread("telegram", "42", null, "thread-old")).toBe(false);
    expect(state.getActiveThread("telegram", "42")).toBe("thread-1");
    expect(state.getThreadWatch("telegram", "42")?.codexThreadId).toBe("thread-1");

    expect(state.detachIfActiveThread("telegram", "42", null, "thread-1")).toBe(true);
    expect(state.getActiveThread("telegram", "42")).toBeNull();
    expect(state.getThreadWatch("telegram", "42")).toBeNull();
  });

  it("replaces one watched thread and acknowledges only the current watch", () => {
    state.selectAndWatchThread("telegram", "42", null, "thread-1", { turnId: "turn-1" }, 1);
    state.selectAndWatchThread("telegram", "42", null, "thread-2", { turnId: "turn-2" }, 2);

    expect(state.listThreadWatches()).toHaveLength(1);
    expect(state.getThreadWatch("telegram", "42")?.codexThreadId).toBe("thread-2");
    expect(
      state.acknowledgeWatchedState({ channel: "telegram", chatId: "42" }, "thread-1", {
        turnId: "late-turn",
      }),
    ).toBe(false);
    expect(
      state.acknowledgeWatchedState({ channel: "telegram", chatId: "42" }, "thread-2", {
        turnId: "turn-3",
        blockedGoalUpdatedAt: 10,
      }),
    ).toBe(true);
    expect(state.getThreadWatch("telegram", "42")).toMatchObject({
      lastDeliveredTurnId: "turn-3",
      lastDeliveredGoalUpdatedAt: 10,
    });
  });

  it("deduplicates terminal deliveries across producers and stores thread mutes separately", () => {
    const target = { channel: "telegram", chatId: "42" };

    expect(
      state.recordTerminalDelivery(target, "thread-1", "turn-1", "watch", null, "message-1"),
    ).toBe(true);
    expect(
      state.recordTerminalDelivery(
        target,
        "thread-1",
        "turn-1",
        "explicit_notification",
        "notification-1",
        "message-2",
      ),
    ).toBe(false);
    expect(state.getTerminalDeliveryMessageId(target, "thread-1", "turn-1")).toBe("message-1");

    state.muteThread(target, "thread-1");
    expect(state.isThreadMuted(target, "thread-1")).toBe(true);
    expect(state.unmuteThread(target, "thread-1")).toBe(true);
    expect(state.isThreadMuted(target, "thread-1")).toBe(false);
  });
});
