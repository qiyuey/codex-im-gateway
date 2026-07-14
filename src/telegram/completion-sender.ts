import type { CanonicalTurnResult } from "../codex/app-server-client.js";
import type { CompletionSender } from "../dispatcher/dispatcher.js";
import { renderCompletion, taskActionKeyboard } from "./render.js";
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
    const message = await this.api.sendRichMessage(
      this.chatId,
      renderCompletion(result),
      null,
      taskActionKeyboard(result.threadId),
    );
    return { messageId: message.messageId };
  }
}
