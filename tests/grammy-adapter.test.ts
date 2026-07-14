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
});
