import type { OutboundNotification } from "../core/types.js";
import type { NotificationSender } from "../dispatcher/notification-dispatcher.js";
import { renderNotification } from "./render.js";
import type { TelegramApi } from "./types.js";

export class TelegramNotificationSender implements NotificationSender {
  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
  ) {}

  async sendNotification(
    notification: OutboundNotification,
  ): Promise<{ readonly messageId: string }> {
    const keyboard =
      notification.source.kind === "bound_task"
        ? [[{ text: "Switch", callbackData: `thread:${notification.source.codexThreadId}` }]]
        : undefined;
    const message = await this.api.sendRichMessage(
      this.chatId,
      renderNotification(notification),
      null,
      keyboard,
    );
    return { messageId: message.messageId };
  }
}
