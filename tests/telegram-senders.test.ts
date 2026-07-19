import { describe, expect, it, vi } from "vitest";
import { TelegramCompletionSender } from "../src/telegram/completion-sender.js";
import { TelegramNotificationSender } from "../src/telegram/notification-sender.js";
import type { TelegramApi } from "../src/telegram/types.js";

describe("Telegram result senders", () => {
  it("routes Codex completions through Rich Markdown", async () => {
    const sendRichMessage = vi.fn(async (_chatId: number, _markdown: string) => ({
      chatId: 42,
      messageId: "completion-1",
      topicId: null,
    }));
    const sender = new TelegramCompletionSender({ sendRichMessage } as unknown as TelegramApi, 42);

    await sender.sendCompletion(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        finalMessage: "## Result\n\n| QC | Status |\n| --- | --- |\n| Tests | Pass |",
        cwd: "/workspace/project",
      },
      "event-1",
    );

    expect(sendRichMessage).toHaveBeenCalledOnce();
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("## Result");
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("| QC | Status |");
  });

  it("sends oversized completions in full with actions only on the first part", async () => {
    const sendRichMessage = vi.fn(
      async (
        _chatId: number,
        _markdown: string,
        _topicId?: string | null,
        _keyboard?: unknown,
      ) => ({
        chatId: 42,
        messageId: `completion-${sendRichMessage.mock.calls.length}`,
        topicId: null,
      }),
    );
    const sender = new TelegramCompletionSender(
      { sendRichMessage } as unknown as TelegramApi,
      42,
      "en",
    );
    const body = "x".repeat(70_000);

    const sent = await sender.sendCompletion(
      {
        threadId: "thread-1",
        turnId: "turn-1",
        status: "completed",
        finalMessage: body,
        cwd: "/workspace/project",
      },
      "event-1",
    );

    expect(sendRichMessage).toHaveBeenCalledTimes(3);
    expect(sent.messageId).toBe("completion-1");
    expect(sendRichMessage.mock.calls.every((call) => (call[1]?.length ?? 0) <= 32_768)).toBe(true);
    expect(sendRichMessage.mock.calls[0]?.[3]).toBeDefined();
    expect(sendRichMessage.mock.calls.slice(1).every((call) => call[3] === undefined)).toBe(true);
    expect(
      sendRichMessage.mock.calls
        .map((call) => call[1])
        .join("")
        .split("x"),
    ).toHaveLength(body.length + 1);
  });

  it("routes explicit notifications through Rich Markdown", async () => {
    const sendRichMessage = vi.fn(
      async (
        _chatId: number,
        _markdown: string,
        _topicId?: string | null,
        _keyboard?: unknown,
      ) => ({
        chatId: 42,
        messageId: "notification-1",
        topicId: null,
      }),
    );
    const sender = new TelegramNotificationSender(
      { sendRichMessage } as unknown as TelegramApi,
      42,
      "en",
    );

    await sender.sendNotification({
      id: "notification-1",
      idempotencyKey: "explicit:run-1",
      channel: "telegram",
      cwd: "/workspace/project",
      title: "Scheduled report",
      message: "## Final status\n\n- Passed",
      source: { kind: "notification_only" },
      ingress: { producer: "internal", producerVersion: "0.1.0", protocolVersion: 1 },
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: null,
      leaseToken: null,
      platformMessageId: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });

    expect(sendRichMessage).toHaveBeenCalledOnce();
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("# 📬 Scheduled report");
    expect(sendRichMessage.mock.calls[0]?.[1]).toContain("## Final status");
    expect(sendRichMessage.mock.calls[0]?.[3]).toEqual([
      [{ text: "Choose task", callbackData: "threads" }],
    ]);
  });

  it("adds an exact task switch action to a bound notification", async () => {
    const sendRichMessage = vi.fn(
      async (
        _chatId: number,
        _markdown: string,
        _topicId?: string | null,
        _keyboard?: unknown,
      ) => ({
        chatId: 42,
        messageId: "notification-2",
        topicId: null,
      }),
    );
    const sender = new TelegramNotificationSender(
      { sendRichMessage } as unknown as TelegramApi,
      42,
      "en",
    );

    await sender.sendNotification({
      id: "notification-2",
      idempotencyKey: "bound:run-2",
      channel: "telegram",
      cwd: "/workspace/project",
      title: "Bound report",
      message: "Done",
      source: { kind: "bound_task", codexThreadId: "thread-2", codexTurnId: "turn-2" },
      ingress: { producer: "internal", producerVersion: "0.1.0", protocolVersion: 1 },
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: null,
      leaseToken: null,
      platformMessageId: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });

    expect(sendRichMessage.mock.calls[0]?.[3]).toEqual([
      [{ text: "Switch to this task", callbackData: "switch:thread-2" }],
    ]);
  });

  it("adds a direct switch action to a thread-bound notification", async () => {
    const sendRichMessage = vi.fn(
      async (
        _chatId: number,
        _markdown: string,
        _topicId?: string | null,
        _keyboard?: unknown,
      ) => ({
        chatId: 42,
        messageId: "notification-thread",
        topicId: null,
      }),
    );
    const sender = new TelegramNotificationSender(
      { sendRichMessage } as unknown as TelegramApi,
      42,
      "en",
    );

    await sender.sendNotification({
      id: "notification-thread",
      idempotencyKey: "thread:run-3",
      channel: "telegram",
      cwd: "/workspace/project",
      title: "Thread-bound report",
      message: "Done",
      source: { kind: "bound_thread", codexThreadId: "thread-3" },
      ingress: { producer: "mcp", producerVersion: "0.1.0", protocolVersion: 1 },
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: null,
      leaseToken: null,
      platformMessageId: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });

    expect(sendRichMessage.mock.calls[0]?.[3]).toEqual([
      [{ text: "Switch to this task", callbackData: "switch:thread-3" }],
    ]);
  });
});
