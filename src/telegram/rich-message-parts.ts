import type { TelegramApi, TelegramInlineButton, TelegramMessageRef } from "./types.js";

export async function sendRichMessageParts(
  api: TelegramApi,
  chatId: number,
  parts: readonly string[],
  topicId?: string | null,
  inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
): Promise<TelegramMessageRef> {
  const first = parts[0];
  if (!first) throw new Error("Rich message must contain at least one part");

  const message = await api.sendRichMessage(chatId, first, topicId, inlineKeyboard);
  for (const part of parts.slice(1)) await api.sendRichMessage(chatId, part, topicId);
  return message;
}

export async function editRichMessageParts(
  api: TelegramApi,
  ref: TelegramMessageRef,
  parts: readonly string[],
  inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
): Promise<void> {
  const first = parts[0];
  if (!first) throw new Error("Rich message must contain at least one part");

  await api.editRichMessage(ref, first, inlineKeyboard);
  for (const part of parts.slice(1)) await api.sendRichMessage(ref.chatId, part, ref.topicId);
}
