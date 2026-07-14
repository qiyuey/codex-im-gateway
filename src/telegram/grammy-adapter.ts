import { Bot, GrammyError, HttpError } from "grammy";
import type { TelegramApi, TelegramMessage, TelegramMessageRef } from "./types.js";

export const TELEGRAM_COMMANDS = [
  { command: "threads", description: "List available Codex threads" },
  { command: "use", description: "Select a thread by ID or prefix" },
  { command: "current", description: "Show the current Codex thread" },
  { command: "new", description: "Create and select a new thread" },
  { command: "detach", description: "Clear the current thread selection" },
  { command: "stop", description: "Stop the active turn and queued prompts" },
] as const;

export class GrammyTelegramAdapter implements TelegramApi {
  private handler: ((message: TelegramMessage) => Promise<void>) | null = null;

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
    await this.bot.start({ allowed_updates: ["message"] });
  }

  stop(): void {
    this.bot.stop();
  }

  async sendMessage(
    chatId: number,
    html: string,
    topicId?: string | null,
  ): Promise<TelegramMessageRef> {
    const message = await this.bot.api.sendMessage(chatId, html, {
      parse_mode: "HTML",
      ...(topicId ? { message_thread_id: Number(topicId) } : {}),
    });
    return { chatId, messageId: String(message.message_id), topicId: topicId ?? null };
  }

  async editMessage(ref: TelegramMessageRef, html: string): Promise<void> {
    await this.bot.api.editMessageText(ref.chatId, Number(ref.messageId), html, {
      parse_mode: "HTML",
    });
  }
}
