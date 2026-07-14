export interface TelegramMessage {
  readonly messageId: string;
  readonly chatId: number;
  readonly chatType: string;
  readonly userId: number;
  readonly topicId: string | null;
  readonly replyToMessageId: string | null;
  readonly isForwarded: boolean;
  readonly text: string;
}

export interface TelegramMessageRef {
  readonly chatId: number;
  readonly messageId: string;
  readonly topicId: string | null;
}

export interface TelegramApi {
  sendMessage(chatId: number, html: string, topicId?: string | null): Promise<TelegramMessageRef>;
  editMessage(ref: TelegramMessageRef, html: string): Promise<void>;
}
