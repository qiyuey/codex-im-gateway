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

export interface TelegramCallbackQuery {
  readonly queryId: string;
  readonly chatId: number;
  readonly chatType: string;
  readonly userId: number;
  readonly topicId: string | null;
  readonly messageId: string;
  readonly data: string;
}

export interface TelegramInlineButton {
  readonly text: string;
  readonly callbackData: string;
}

export interface TelegramApi {
  sendTextMessage(
    chatId: number,
    text: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef>;
  sendRichMessage(
    chatId: number,
    markdown: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef>;
  editTextMessage(
    ref: TelegramMessageRef,
    text: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void>;
  editRichMessage(
    ref: TelegramMessageRef,
    markdown: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void>;
  answerCallbackQuery(queryId: string, text?: string): Promise<void>;
}
