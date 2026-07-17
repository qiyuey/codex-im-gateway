import type { GatewayLanguage } from "../core/i18n.js";
import type { OutboundNotification } from "../core/types.js";
import type { NotificationSender } from "../dispatcher/notification-dispatcher.js";
import { notificationActionKeyboard, renderNotificationParts } from "./render.js";
import { sendRichMessageParts } from "./rich-message-parts.js";
import type { TelegramApi } from "./types.js";

export class TelegramNotificationSender implements NotificationSender {
  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: number,
    private readonly language: GatewayLanguage = "zh",
  ) {}

  async sendNotification(
    notification: OutboundNotification,
  ): Promise<{ readonly messageId: string }> {
    const message = await sendRichMessageParts(
      this.api,
      this.chatId,
      renderNotificationParts(notification, this.language),
      null,
      notificationActionKeyboard(notification.source, this.language),
    );
    return { messageId: message.messageId };
  }
}
