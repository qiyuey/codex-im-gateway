import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchedThreadSnapshot } from "../src/codex/app-server-client.js";
import { ThreadWatchMonitor } from "../src/dispatcher/thread-watch-monitor.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { GatewayStateStore } from "../src/storage/gateway-state-store.js";
import type { TelegramApi } from "../src/telegram/types.js";

let database: GatewayDatabase;
let state: GatewayStateStore;
let sendRichMessage: ReturnType<typeof vi.fn>;
let api: TelegramApi;

beforeEach(() => {
  database = new GatewayDatabase(":memory:");
  state = new GatewayStateStore(database);
  sendRichMessage = vi.fn(async (chatId: number, _markdown: string, topicId?: string | null) => ({
    chatId,
    messageId: "200",
    topicId: topicId ?? null,
  }));
  api = { sendRichMessage } as unknown as TelegramApi;
  state.selectAndWatchThread("telegram", "42", null, "thread-1", { turnId: "turn-old" });
});

afterEach(() => database.close());

describe("ThreadWatchMonitor", () => {
  it("delivers and binds one new terminal turn without duplicating it", async () => {
    const reader = { readThreadSnapshot: vi.fn(async () => snapshot()) };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 5_000);

    expect(await monitor.runOnce(1_000)).toBe(true);
    expect(await monitor.runOnce(7_000)).toBe(true);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("completed");
    expect(sendRichMessage.mock.calls[0]?.[3]).toEqual([
      [
        { text: "Switch", callbackData: "thread:thread-1" },
        { text: "Mute", callbackData: "mute:thread-1" },
      ],
    ]);
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-new");
    expect(state.findMessageBinding("telegram", "42", "200")).toMatchObject({
      codexThreadId: "thread-1",
      codexTurnId: "turn-new",
    });
  });

  it("does not deliver a transient empty interruption before the turn resumes", async () => {
    const snapshots = [
      snapshot({
        latestTurn: interruptedTurn(),
        latestTerminalTurn: interruptedTurn(),
        latestTerminalTurnId: "turn-new",
      }),
      snapshot({
        latestTurn: {
          ...interruptedTurn(),
          status: "in_progress",
        },
        latestTerminalTurn: {
          ...interruptedTurn(),
          turnId: "turn-old",
          status: "completed",
          finalMessage: "previous result",
        },
        latestTerminalTurnId: "turn-old",
      }),
      snapshot(),
    ];
    const reader = {
      readThreadSnapshot: vi.fn(async () => snapshots.shift() ?? snapshot()),
    };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.runOnce(1_000);
    await monitor.runOnce(2_000);
    await monitor.runOnce(3_000);
    await monitor.runOnce(4_000);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("completed result");
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-new");
  });

  it("silently ignores a persistent empty interruption but delivers its later result", async () => {
    const emptyInterruption = snapshot({
      latestTurn: interruptedTurn(),
      latestTerminalTurn: interruptedTurn(),
      latestTerminalTurnId: "turn-new",
    });
    const completed = snapshot();
    const snapshots = [emptyInterruption, emptyInterruption, emptyInterruption, completed];
    const reader = {
      readThreadSnapshot: vi.fn(async () => snapshots.shift() ?? completed),
    };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.runOnce(1_000);
    await monitor.runOnce(2_000);
    await monitor.runOnce(3_000);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-old");

    await monitor.runOnce(4_000);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("completed result");
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-new");
  });

  it("does not deliver commentary from a transient interrupted view of an active turn", async () => {
    const transient = snapshot({
      latestTurn: interruptedTurn("Working on the requested change."),
      latestTerminalTurn: interruptedTurn("Working on the requested change."),
      latestTerminalTurnId: "turn-new",
    });
    const snapshots = [transient, snapshot()];
    const reader = {
      readThreadSnapshot: vi.fn(async () => snapshots.shift() ?? snapshot()),
    };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.runOnce(1_000);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-old");

    await monitor.runOnce(2_000);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("completed result");
  });

  it("silently acknowledges a stable interrupted turn", async () => {
    const interrupted = interruptedTurn("Partial output before the stop.", 12_000);
    const reader = {
      readThreadSnapshot: vi.fn(async () =>
        snapshot({
          latestTurn: interrupted,
          latestTerminalTurn: interrupted,
          latestTerminalTurnId: interrupted.turnId,
        }),
      ),
    };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.runOnce(1_000);
    await monitor.runOnce(2_000);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(state.getThreadWatch("telegram", "42")?.lastDeliveredTurnId).toBe("turn-new");
  });

  it("coalesces a blocked goal with its latest turn into one notification", async () => {
    const reader = {
      readThreadSnapshot: vi.fn(async () =>
        snapshot({ blockedGoal: { objective: "Need user input", updatedAt: 12 } }),
      ),
    };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.runOnce(1_000);

    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("# ⚠️ Task blocked");
    expect(state.getThreadWatch("telegram", "42")).toMatchObject({
      lastDeliveredTurnId: "turn-new",
      lastDeliveredGoalUpdatedAt: 12,
    });
  });

  it("clears a watch that is no longer inside the workspace allowlist", async () => {
    const reader = { readThreadSnapshot: vi.fn(async () => snapshot()) };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => false, 0);

    await monitor.runOnce(1_000);

    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(state.getThreadWatch("telegram", "42")).toBeNull();
  });

  it("upgrades an existing active selection with a historical baseline", async () => {
    state.clearThreadWatch("telegram", "42");
    const reader = { readThreadSnapshot: vi.fn(async () => snapshot()) };
    const monitor = new ThreadWatchMonitor(state, reader, api, async () => true, 0);

    await monitor.initializeExistingSelections();
    await monitor.runOnce(1_000);

    expect(state.getThreadWatch("telegram", "42")).toMatchObject({
      codexThreadId: "thread-1",
      lastDeliveredTurnId: "turn-new",
    });
    expect(sendRichMessage).not.toHaveBeenCalled();
  });
});

function snapshot(overrides: Partial<WatchedThreadSnapshot> = {}): WatchedThreadSnapshot {
  return {
    threadId: "thread-1",
    cwd: "/workspace",
    latestTurn: {
      threadId: "thread-1",
      turnId: "turn-new",
      status: "completed",
      finalMessage: "completed result",
      cwd: "/workspace",
    },
    latestTerminalTurn: {
      threadId: "thread-1",
      turnId: "turn-new",
      status: "completed",
      finalMessage: "completed result",
      cwd: "/workspace",
    },
    latestTerminalTurnId: "turn-new",
    blockedGoal: null,
    ...overrides,
  };
}

function interruptedTurn(
  finalMessage = "",
  durationMs: number | null = null,
): NonNullable<WatchedThreadSnapshot["latestTurn"]> {
  return {
    threadId: "thread-1",
    turnId: "turn-new",
    status: "interrupted",
    finalMessage,
    cwd: "/workspace",
    durationMs,
  };
}
