import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dispatcher } from "../src/dispatcher/dispatcher.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { CompletionEventStore } from "../src/storage/event-store.js";
import { GatewayStateStore } from "../src/storage/gateway-state-store.js";

let database: GatewayDatabase;
let events: CompletionEventStore;
let state: GatewayStateStore;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  events = new CompletionEventStore(database);
  state = new GatewayStateStore(database);
});
afterEach(() => database.close());

describe("Dispatcher", () => {
  it("reads, sends, binds, and acknowledges a completion", async () => {
    enqueue();
    const reader = {
      readTurn: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed" as const,
        finalMessage: "done",
        cwd: "/workspace",
      })),
    };
    const sender = { sendCompletion: vi.fn(async () => ({ messageId: "200" })) };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    expect(await dispatcher.runOnce(1_100)).toBe(true);
    expect(events.counts().delivered).toBe(1);
    expect(state.findMessageBinding("telegram", "42", "200")).toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
  });

  it("retries failures without acknowledging delivery", async () => {
    enqueue();
    const reader = {
      readTurn: vi.fn(async () => {
        throw new Error("temporary");
      }),
    };
    const sender = { sendCompletion: vi.fn() };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);
    expect(events.counts().queued).toBe(1);
    expect(sender.sendCompletion).not.toHaveBeenCalled();
  });

  it("dead-letters completions outside the workspace allowlist without sending", async () => {
    enqueue();
    const reader = {
      readTurn: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed" as const,
        finalMessage: "private",
        cwd: "/not-allowed",
      })),
    };
    const sender = { sendCompletion: vi.fn(async () => ({ messageId: "never" })) };
    const dispatcher = new Dispatcher(
      events,
      state,
      reader,
      sender,
      { channel: "telegram", chatId: "42" },
      async () => false,
    );

    await dispatcher.runOnce(1_100);
    expect(events.counts().deadLetter).toBe(1);
    expect(sender.sendCompletion).not.toHaveBeenCalled();
  });

  it("acknowledges a turn already delivered by another producer without sending twice", async () => {
    enqueue();
    state.recordTerminalDelivery(
      { channel: "telegram", chatId: "42" },
      "thread-1",
      "turn-1",
      "watch",
      null,
      "existing-message",
    );
    const reader = { readTurn: vi.fn() };
    const sender = { sendCompletion: vi.fn() };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);

    expect(events.counts().delivered).toBe(1);
    expect(reader.readTurn).not.toHaveBeenCalled();
    expect(sender.sendCompletion).not.toHaveBeenCalled();
  });

  it("acknowledges a muted thread without sending", async () => {
    enqueue();
    state.muteThread({ channel: "telegram", chatId: "42" }, "thread-1");
    const sender = { sendCompletion: vi.fn() };
    const dispatcher = new Dispatcher(events, state, { readTurn: vi.fn() }, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);

    expect(events.counts().delivered).toBe(1);
    expect(sender.sendCompletion).not.toHaveBeenCalled();
  });

  it("keeps automation completions silent by default", async () => {
    enqueue();
    const reader = {
      readTurn: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed" as const,
        finalMessage: "scheduled result",
        cwd: "/workspace",
        threadSource: "automation",
      })),
    };
    const sender = { sendCompletion: vi.fn() };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);

    expect(events.counts().delivered).toBe(1);
    expect(sender.sendCompletion).not.toHaveBeenCalled();
  });

  it("delivers automation completions after the task is explicitly selected", async () => {
    enqueue();
    state.selectAndWatchThread("telegram", "42", null, "thread-1");
    const reader = {
      readTurn: vi.fn(async () => ({
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed" as const,
        finalMessage: "scheduled result",
        cwd: "/workspace",
        threadSource: "automation",
      })),
    };
    const sender = { sendCompletion: vi.fn(async () => ({ messageId: "201" })) };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);

    expect(events.counts().delivered).toBe(1);
    expect(sender.sendCompletion).toHaveBeenCalledOnce();
  });

  it("dead-letters an unsupported plugin ingress protocol without reading Codex", async () => {
    events.enqueue(
      {
        idempotencyKey: "future:turn",
        codexThreadId: "future",
        codexTurnId: "turn",
        cwd: "/workspace",
        eventType: "completed",
        ingress: { producer: "stop_hook", protocolVersion: 99 },
      },
      1_000,
    );
    const reader = { readTurn: vi.fn() };
    const sender = { sendCompletion: vi.fn() };
    const dispatcher = new Dispatcher(events, state, reader, sender, {
      channel: "telegram",
      chatId: "42",
    });

    await dispatcher.runOnce(1_100);

    expect(events.counts().deadLetter).toBe(1);
    expect(events.list("dead_letter")[0]?.lastError).toBe("unsupported ingress protocol 99");
    expect(reader.readTurn).not.toHaveBeenCalled();
  });
});

function enqueue() {
  return events.enqueue(
    {
      idempotencyKey: "thread-1:turn-1",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
      cwd: "/workspace",
      eventType: "completed",
    },
    1_000,
  );
}
