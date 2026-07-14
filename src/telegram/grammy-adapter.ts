import { Bot, GrammyError, HttpError } from "grammy";
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramInlineButton,
  TelegramMessage,
  TelegramMessageRef,
} from "./types.js";

export const TELEGRAM_COMMANDS = [
  { command: "threads", description: "Choose a Codex thread" },
  { command: "use", description: "Select a thread by ID or prefix" },
  { command: "current", description: "Show the current Codex thread" },
  { command: "new", description: "Create and select a new thread" },
  { command: "mute", description: "Mute watched-thread notifications" },
  { command: "detach", description: "Clear the current thread selection" },
  { command: "stop", description: "Stop the active turn and queued prompts" },
] as const;

export class GrammyTelegramAdapter implements TelegramApi {
  private handler: ((message: TelegramMessage) => Promise<void>) | null = null;
  private callbackHandler: ((query: TelegramCallbackQuery) => Promise<void>) | null = null;

  constructor(
    token: string,
    private readonly bot: Bot = new Bot(token),
  ) {
    this.bot.on("message:text", async (context) => {
      const message = context.message;
      if (!this.handler || !message.from) return;
      await this.handler({
        messageId: String(message.message_id),
        chatId: message.chat.id,
        chatType: message.chat.type,
        userId: message.from.id,
        topicId: message.message_thread_id === undefined ? null : String(message.message_thread_id),
        replyToMessageId:
          message.reply_to_message === undefined
            ? null
            : String(message.reply_to_message.message_id),
        isForwarded: message.forward_origin !== undefined,
        text: message.text,
      });
    });
    this.bot.on("callback_query:data", async (context) => {
      const query = context.callbackQuery;
      const message = query.message;
      if (!this.callbackHandler || !message) {
        await context.answerCallbackQuery();
        return;
      }
      await this.callbackHandler({
        queryId: query.id,
        chatId: message.chat.id,
        chatType: message.chat.type,
        userId: query.from.id,
        topicId:
          "message_thread_id" in message && message.message_thread_id !== undefined
            ? String(message.message_thread_id)
            : null,
        messageId: String(message.message_id),
        data: query.data,
      });
    });
    this.bot.catch(({ error }) => {
      const kind =
        error instanceof GrammyError
          ? "telegram_api"
          : error instanceof HttpError
            ? "telegram_http"
            : "telegram_unknown";
      process.stderr.write(
        `${JSON.stringify({ level: "error", event: "telegram_update_failed", kind })}\n`,
      );
    });
  }

  onMessage(handler: (message: TelegramMessage) => Promise<void>): void {
    this.handler = handler;
  }

  onCallbackQuery(handler: (query: TelegramCallbackQuery) => Promise<void>): void {
    this.callbackHandler = handler;
  }

  async configureCommandMenu(chatId: number): Promise<void> {
    await Promise.all([
      this.bot.api.setMyCommands(TELEGRAM_COMMANDS, {
        scope: { type: "chat", chat_id: chatId },
      }),
      this.bot.api.setChatMenuButton({
        chat_id: chatId,
        menu_button: { type: "commands" },
      }),
    ]);
  }

  async start(): Promise<void> {
    await this.bot.start({ allowed_updates: ["message", "callback_query"] });
  }

  stop(): void {
    this.bot.stop();
  }

  async sendTextMessage(
    chatId: number,
    text: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef> {
    const message = await this.bot.api.sendMessage(
      chatId,
      text,
      messageOptions(topicId, inlineKeyboard),
    );
    return { chatId, messageId: String(message.message_id), topicId: topicId ?? null };
  }

  async sendRichMessage(
    chatId: number,
    markdown: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef> {
    const message = await this.bot.api.sendRichMessage(
      chatId,
      { markdown },
      messageOptions(topicId, inlineKeyboard),
    );
    return { chatId, messageId: String(message.message_id), topicId: topicId ?? null };
  }

  async editTextMessage(
    ref: TelegramMessageRef,
    text: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void> {
    await this.bot.api.editMessageText(
      ref.chatId,
      Number(ref.messageId),
      text,
      editOptions(inlineKeyboard),
    );
  }

  async editRichMessage(
    ref: TelegramMessageRef,
    markdown: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void> {
    await this.bot.api.editMessageText(
      ref.chatId,
      Number(ref.messageId),
      { markdown },
      editOptions(inlineKeyboard),
    );
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    await this.bot.api.answerCallbackQuery(queryId, text ? { text } : undefined);
  }
}

function messageOptions(
  topicId?: string | null,
  inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
) {
  return {
    ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    ...editOptions(inlineKeyboard),
  };
}

function editOptions(inlineKeyboard?: readonly (readonly TelegramInlineButton[])[]) {
  return inlineKeyboard
    ? {
        reply_markup: {
          inline_keyboard: inlineKeyboard.map((row) =>
            row.map((button) => ({
              text: button.text,
              callback_data: button.callbackData,
            })),
          ),
        },
      }
    : {};
}
