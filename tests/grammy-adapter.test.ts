import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { GrammyTelegramAdapter, TELEGRAM_COMMANDS } from "../src/telegram/grammy-adapter.js";

describe("GrammyTelegramAdapter", () => {
  it("registers every supported command and exposes the commands menu button", async () => {
    const setMyCommands = vi.fn(async () => true as const);
    const setChatMenuButton = vi.fn(async () => true as const);
    const bot = {
      api: { setMyCommands, setChatMenuButton },
      catch: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", bot);

    await adapter.configureCommandMenu(42);

    expect(setMyCommands).toHaveBeenCalledWith(TELEGRAM_COMMANDS, {
      scope: { type: "chat", chat_id: 42 },
    });
    expect(setChatMenuButton).toHaveBeenCalledWith({
      chat_id: 42,
      menu_button: { type: "commands" },
    });
  });

  it("sends plain text without parse mode and answers callback queries", async () => {
    const sendMessage = vi.fn(async () => ({ message_id: 12 }));
    const answerCallbackQuery = vi.fn(async () => true as const);
    const bot = {
      api: { sendMessage, answerCallbackQuery },
      catch: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", bot);

    await adapter.sendTextMessage(42, "Select a thread:", null, [
      [{ text: "abcdef12 · Example", callbackData: "thread:abcdef12-full" }],
    ]);
    await adapter.answerCallbackQuery("query-1", "Switched.");

    expect(sendMessage).toHaveBeenCalledWith(42, "Select a thread:", {
      reply_markup: {
        inline_keyboard: [[{ text: "abcdef12 · Example", callback_data: "thread:abcdef12-full" }]],
      },
    });
    expect(answerCallbackQuery).toHaveBeenCalledWith("query-1", { text: "Switched." });
  });

  it("sends and edits Rich Markdown through Bot API rich_message", async () => {
    const sendRichMessage = vi.fn(async () => ({ message_id: 13 }));
    const editMessageText = vi.fn(async () => true as const);
    const bot = {
      api: { sendRichMessage, editMessageText },
      catch: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", bot);

    const ref = await adapter.sendRichMessage(42, "# Result\n\n- passed", "9", [
      [{ text: "Continue", callbackData: "thread:abc" }],
    ]);
    await adapter.editRichMessage(ref, "# Final\n\n**done**");

    expect(sendRichMessage).toHaveBeenCalledWith(
      42,
      { markdown: "# Result\n\n- passed" },
      {
        message_thread_id: 9,
        reply_markup: {
          inline_keyboard: [[{ text: "Continue", callback_data: "thread:abc" }]],
        },
      },
    );
    expect(editMessageText).toHaveBeenCalledWith(
      42,
      13,
      {
        markdown: "# Final\n\n**done**",
      },
      {},
    );
  });
});
