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

  it("routes explicit notifications through Rich Markdown", async () => {
    const sendRichMessage = vi.fn(async (_chatId: number, _markdown: string) => ({
      chatId: 42,
      messageId: "notification-1",
      topicId: null,
    }));
    const sender = new TelegramNotificationSender(
      { sendRichMessage } as unknown as TelegramApi,
      42,
    );

    await sender.sendNotification({
      id: "notification-1",
      idempotencyKey: "explicit:run-1",
      channel: "telegram",
      cwd: "/workspace/project",
      title: "Scheduled report",
      message: "## Final status\n\n- Passed",
      source: { kind: "notification_only" },
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
  });
});
