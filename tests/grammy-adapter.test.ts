import type { Bot } from "grammy";
import { describe, expect, it, vi } from "vitest";
import { GrammyTelegramAdapter, TELEGRAM_COMMANDS } from "../src/telegram/grammy-adapter.js";

describe("GrammyTelegramAdapter", () => {
  it("drops updates before routing unless they come from the sole allowed private user", async () => {
    const handlers = new Map<string, (context: never) => Promise<void>>();
    const bot = {
      api: {},
      catch: vi.fn(),
      on: vi.fn((event: string, handler: (context: never) => Promise<void>) => {
        handlers.set(event, handler);
      }),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", 7, bot);
    const onMessage = vi.fn(async () => undefined);
    adapter.onMessage(onMessage);
    const handleMessage = handlers.get("message:text");
    if (!handleMessage) throw new Error("Expected message handler registration");

    const context = (userId: number, chatId: number, chatType: string) =>
      ({
        message: {
          message_id: 1,
          chat: { id: chatId, type: chatType },
          from: { id: userId },
          text: "hello",
        },
      }) as never;

    await handleMessage(context(8, 7, "private"));
    await handleMessage(context(7, -100, "group"));
    await handleMessage(context(7, 7, "private"));

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, chatId: 7 }));
  });

  it("registers every supported command and exposes the commands menu button", async () => {
    const setMyCommands = vi.fn(async () => true as const);
    const setChatMenuButton = vi.fn(async () => true as const);
    const bot = {
      api: { setMyCommands, setChatMenuButton },
      catch: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", 7, bot);

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
    const adapter = new GrammyTelegramAdapter("test-token", 7, bot);

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
    const editMessageReplyMarkup = vi.fn(async () => true as const);
    const bot = {
      api: { sendRichMessage, editMessageText, editMessageReplyMarkup },
      catch: vi.fn(),
      on: vi.fn(),
    } as unknown as Bot;
    const adapter = new GrammyTelegramAdapter("test-token", 7, bot);

    const ref = await adapter.sendRichMessage(42, "# Result\n\n- passed", "9", [
      [{ text: "Continue", callbackData: "thread:abc" }],
    ]);
    await adapter.editRichMessage(ref, "# Final\n\n**done**");
    await adapter.editMessageKeyboard(ref, [
      [{ text: "切换到此任务", callbackData: "switch:abc" }],
    ]);

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
    expect(editMessageReplyMarkup).toHaveBeenCalledWith(42, 13, {
      reply_markup: {
        inline_keyboard: [[{ text: "切换到此任务", callback_data: "switch:abc" }]],
      },
    });
  });
});
