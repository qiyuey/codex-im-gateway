import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationDispatcher } from "../src/dispatcher/notification-dispatcher.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { OutboundNotificationStore } from "../src/storage/notification-store.js";

let database: GatewayDatabase;
let store: OutboundNotificationStore;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  store = new OutboundNotificationStore(database);
});

afterEach(() => database.close());

describe("NotificationDispatcher", () => {
  it("sends one allowed explicit notification and acknowledges it", async () => {
    enqueue();
    const sender = { sendNotification: vi.fn(async () => ({ messageId: "message-1" })) };
    const dispatcher = new NotificationDispatcher(store, sender, async () => true);

    expect(await dispatcher.runOnce(1_100)).toBe(true);
    expect(sender.sendNotification).toHaveBeenCalledOnce();
    expect(store.list("delivered")[0]).toMatchObject({ platformMessageId: "message-1" });
  });

  it("dead-letters a notification outside the workspace allowlist", async () => {
    enqueue();
    const sender = { sendNotification: vi.fn() };
    const dispatcher = new NotificationDispatcher(store, sender, async () => false);

    expect(await dispatcher.runOnce(1_100)).toBe(true);
    expect(sender.sendNotification).not.toHaveBeenCalled();
    expect(store.counts().deadLetter).toBe(1);
  });

  it("records an exact reply binding for a bound-task notification", async () => {
    store.enqueue(
      {
        idempotencyKey: "bound:thread-1:turn-1",
        channel: "telegram",
        cwd: "/workspace/example",
        title: "Bound result",
        message: "Done.",
        source: { kind: "bound_task", codexThreadId: "thread-1", codexTurnId: "turn-1" },
      },
      1_000,
    );
    const sender = { sendNotification: vi.fn(async () => ({ messageId: "message-bound" })) };
    const recordBinding = vi.fn();
    const dispatcher = new NotificationDispatcher(store, sender, async () => true, recordBinding);

    await dispatcher.runOnce(1_100);

    expect(recordBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: "bound_task", codexThreadId: "thread-1", codexTurnId: "turn-1" },
      }),
      "message-bound",
    );
  });
});

function enqueue() {
  store.enqueue(
    {
      idempotencyKey: "explicit:run-1",
      channel: "telegram",
      cwd: "/workspace/example",
      title: "Scheduled result",
      message: "Done.",
      source: { kind: "notification_only" },
    },
    1_000,
  );
}
