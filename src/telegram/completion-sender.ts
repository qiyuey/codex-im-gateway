import type { CanonicalTurnResult } from "../codex/app-server-client.js";
import type { CompletionSender } from "../dispatcher/dispatcher.js";
import { renderCompletion } from "./render.js";
import type { TelegramApi } from "./types.js";

export class TelegramCompletionSender implements CompletionSender {
  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
  ) {}

  async sendCompletion(
    result: CanonicalTurnResult,
    _eventId: string,
  ): Promise<{ readonly messageId: string }> {
    const message = await this.api.sendMessage(this.chatId, renderCompletion(result));
    return { messageId: message.messageId };
  }
}
