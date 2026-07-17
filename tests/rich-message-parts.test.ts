import { describe, expect, it, vi } from "vitest";
import { editRichMessageParts, sendRichMessageParts } from "../src/telegram/rich-message-parts.js";
import type { TelegramApi } from "../src/telegram/types.js";

describe("Rich message part delivery", () => {
  it("sends every part in order and attaches actions only to the first", async () => {
    const sendRichMessage = vi.fn(
      async (chatId: number, _markdown: string, topicId?: string | null, _keyboard?: unknown) => ({
        chatId,
        messageId: String(sendRichMessage.mock.calls.length),
        topicId: topicId ?? null,
      }),
    );
    const api = { sendRichMessage } as unknown as TelegramApi;
    const keyboard = [[{ text: "Switch", callbackData: "switch:thread-1" }]];

    const first = await sendRichMessageParts(
      api,
      42,
      ["part 1", "part 2", "part 3"],
      "9",
      keyboard,
    );

    expect(first.messageId).toBe("1");
    expect(sendRichMessage.mock.calls.map((call) => call[1])).toEqual([
      "part 1",
      "part 2",
      "part 3",
    ]);
    expect(sendRichMessage.mock.calls.every((call) => call[2] === "9")).toBe(true);
    expect(sendRichMessage.mock.calls[0]?.[3]).toBe(keyboard);
    expect(sendRichMessage.mock.calls.slice(1).every((call) => call[3] === undefined)).toBe(true);
  });

  it("edits the first part in place and sends the remaining parts to the same topic", async () => {
    const editRichMessage = vi.fn(async () => undefined);
    const sendRichMessage = vi.fn(
      async (chatId: number, _markdown: string, topicId?: string | null) => ({
        chatId,
        messageId: "2",
        topicId: topicId ?? null,
      }),
    );
    const api = { editRichMessage, sendRichMessage } as unknown as TelegramApi;
    const ref = { chatId: 42, messageId: "1", topicId: "9" };
    const keyboard = [[{ text: "Switch", callbackData: "switch:thread-1" }]];

    await editRichMessageParts(api, ref, ["part 1", "part 2"], keyboard);

    expect(editRichMessage).toHaveBeenCalledWith(ref, "part 1", keyboard);
    expect(sendRichMessage).toHaveBeenCalledWith(42, "part 2", "9");
  });
});
