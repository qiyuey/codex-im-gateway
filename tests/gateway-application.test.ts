import { describe, expect, it, vi } from "vitest";
import { GatewayApplication } from "../src/application/gateway-application.js";

describe("GatewayApplication", () => {
  it("owns startup, graceful shutdown, status, and the single-instance lock", async () => {
    let finishTelegram: (() => void) | undefined;
    const telegramRun = new Promise<void>((resolve) => {
      finishTelegram = resolve;
    });
    const order: string[] = [];
    const application = new GatewayApplication({
      config: {
        telegramBotToken: "secret",
        telegramAllowedUserId: 7,
        telegramAllowedChatId: 7,
        allowedWorkspaces: ["/workspace"],
        dispatchIntervalMs: 10_000,
        language: "zh",
      },
      database: { close: vi.fn(() => order.push("database.close")) },
      appServer: {
        connect: vi.fn(async () => order.push("codex.connect")),
        close: vi.fn(async () => {
          order.push("codex.close");
        }),
      },
      telegram: {
        configureCommandMenu: vi.fn(async () => {
          order.push("telegram.configure");
        }),
        onMessage: vi.fn(),
        onCallbackQuery: vi.fn(),
        start: vi.fn(async () => {
          order.push("telegram.start");
          await telegramRun;
        }),
        stop: vi.fn(async () => {
          order.push("telegram.stop");
          finishTelegram?.();
        }),
      },
      service: {
        handleMessage: vi.fn(async () => undefined),
        handleCallbackQuery: vi.fn(async () => undefined),
        drain: vi.fn(async () => {
          order.push("service.drain");
        }),
      },
      dispatcher: { runOnce: vi.fn(async () => false) },
      notificationDispatcher: { runOnce: vi.fn(async () => false) },
      threadWatchMonitor: {
        initializeExistingSelections: vi.fn(async () => {
          order.push("watch.initialize");
        }),
        runOnce: vi.fn(async () => false),
      },
      runtimeStatus: {
        start: vi.fn(() => order.push("status.start")),
        stop: vi.fn(() => order.push("status.stop")),
      },
      instanceLock: {
        acquire: vi.fn(() => order.push("lock.acquire")),
        release: vi.fn(() => order.push("lock.release")),
      },
    });

    const running = application.run();
    await vi.waitFor(() => expect(order).toContain("telegram.start"));
    await application.stop();
    await running;

    expect(order).toEqual([
      "lock.acquire",
      "codex.connect",
      "watch.initialize",
      "telegram.configure",
      "status.start",
      "telegram.start",
      "telegram.stop",
      "service.drain",
      "codex.close",
      "status.stop",
      "database.close",
      "lock.release",
    ]);
  });
});
