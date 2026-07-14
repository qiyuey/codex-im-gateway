import type { AppServerClient } from "../codex/app-server-client.js";
import { ThreadQueue } from "../concurrency/thread-queue.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import { routeMessage } from "../router/router.js";
import { isWorkspaceAllowed } from "../security/workspace.js";
import type { GatewayStateStore } from "../storage/gateway-state-store.js";
import { escapeTelegramHtml, renderStreaming } from "./render.js";
import type { TelegramApi, TelegramMessage, TelegramMessageRef } from "./types.js";

export class TelegramService {
  private readonly queue = new ThreadQueue();
  private readonly background = new Set<Promise<unknown>>();

  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: TelegramApi,
    private readonly state: GatewayStateStore,
    private readonly appServer: TelegramCodexService,
    private readonly editDebounceMs = 750,
    private readonly inboundEnabled: () => boolean = () => true,
  ) {}

  async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.inboundEnabled() || !this.isAuthorized(message)) return;
    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command.name, command.argument);
      return;
    }
    await this.handlePrompt(message);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  private isAuthorized(message: TelegramMessage): boolean {
    return (
      message.chatType === "private" &&
      !message.isForwarded &&
      message.userId === this.config.telegramAllowedUserId &&
      message.chatId === this.config.telegramAllowedChatId
    );
  }

  private async handleCommand(
    message: TelegramMessage,
    command: string,
    argument: string,
  ): Promise<void> {
    if (command === "current") {
      const active = this.state.getActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
      );
      await this.api.sendMessage(
        message.chatId,
        active
          ? `Current thread: <code>${escapeTelegramHtml(active)}</code>`
          : "No thread selected.",
        message.topicId,
      );
      return;
    }
    if (command === "detach") {
      const detached = this.state.detach("telegram", String(message.chatId), message.topicId);
      await this.api.sendMessage(
        message.chatId,
        detached ? "Thread detached." : "No thread was selected.",
        message.topicId,
      );
      return;
    }
    if (command === "threads") {
      const response = await this.appServer.listThreads(20);
      const allowed = [];
      for (const thread of response.data) {
        if (await isWorkspaceAllowed(thread.cwd, this.config.allowedWorkspaces))
          allowed.push(thread);
        if (allowed.length === 10) break;
      }
      const html = allowed.length
        ? allowed
            .map(
              (thread) =>
                `<code>${escapeTelegramHtml(thread.id.slice(0, 8))}</code> ${escapeTelegramHtml(thread.name ?? (thread.preview.slice(0, 80) || "Untitled"))}`,
            )
            .join("\n")
        : "No available threads.";
      await this.api.sendMessage(message.chatId, html, message.topicId);
      return;
    }
    if (command === "use") {
      if (!argument) {
        await this.api.sendMessage(
          message.chatId,
          "Usage: <code>/use &lt;thread&gt;</code>",
          message.topicId,
        );
        return;
      }
      const thread = await this.resolveThread(argument);
      if (!thread) {
        await this.api.sendMessage(
          message.chatId,
          "Thread not found or workspace is not allowed.",
          message.topicId,
        );
        return;
      }
      this.state.setActiveThread("telegram", String(message.chatId), message.topicId, thread.id);
      await this.api.sendMessage(
        message.chatId,
        `Using <code>${escapeTelegramHtml(thread.id)}</code>.`,
        message.topicId,
      );
      return;
    }
    if (command === "new") {
      const cwd = this.config.allowedWorkspaces[0];
      if (!cwd) throw new Error("No allowed workspace configured");
      const response = await this.appServer.startThread(cwd);
      this.state.setActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
        response.thread.id,
      );
      await this.api.sendMessage(
        message.chatId,
        `Created <code>${escapeTelegramHtml(response.thread.id)}</code>.`,
        message.topicId,
      );
      return;
    }
    if (command === "stop") {
      const active = this.state.getActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
      );
      const cancelled = active ? this.queue.cancelPending(active) : false;
      const stopped = active ? await this.appServer.interruptThread(active) : false;
      await this.api.sendMessage(
        message.chatId,
        stopped || cancelled
          ? "Interrupt requested; queued follow-ups cancelled."
          : "No active turn to stop.",
        message.topicId,
      );
      return;
    }
    await this.api.sendMessage(
      message.chatId,
      "Commands: /threads /use /current /new /detach /stop",
      message.topicId,
    );
  }

  private async handlePrompt(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chatId);
    const replyBinding = message.replyToMessageId
      ? this.state.findMessageBinding("telegram", chatId, message.replyToMessageId)
      : null;
    const active = this.state.getActiveThread("telegram", chatId, message.topicId);
    const decision = routeMessage({
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      replyBinding: replyBinding
        ? { codexThreadId: replyBinding.codexThreadId, codexTurnId: replyBinding.codexTurnId }
        : null,
      topicBinding: message.topicId && active ? { codexThreadId: active, codexTurnId: null } : null,
      activeThreadId: active,
    });
    if (decision.kind === "error") {
      const text =
        decision.code === "unknown_reply"
          ? "That message is not bound to an available Codex thread."
          : "Select a thread with /threads and /use, or create one with /new.";
      await this.api.sendMessage(message.chatId, text, message.topicId);
      return;
    }

    const resumed = await this.appServer.resumeThread(decision.threadId);
    if (!(await isWorkspaceAllowed(resumed.cwd, this.config.allowedWorkspaces))) {
      await this.api.sendMessage(
        message.chatId,
        "That thread's workspace is not allowed.",
        message.topicId,
      );
      return;
    }

    const placeholder = await this.api.sendMessage(
      message.chatId,
      "⏳ Codex is working…",
      message.topicId,
    );
    this.state.bindMessage("telegram", chatId, placeholder.messageId, decision.threadId, "pending");
    const task = this.queue.enqueue(decision.threadId, () =>
      this.runFollowUp(decision.threadId, message.text, placeholder),
    );
    this.background.add(task);
    void task.then(
      () => this.background.delete(task),
      () => this.background.delete(task),
    );
  }

  private async runFollowUp(
    threadId: string,
    prompt: string,
    placeholder: TelegramMessageRef,
  ): Promise<void> {
    const editor = new StreamingEditor(this.api, placeholder, this.editDebounceMs);
    try {
      const result = await this.appServer.runTurn(threadId, prompt, (text) => editor.update(text));
      await editor.finish(result.finalMessage);
      this.state.bindMessage(
        "telegram",
        String(placeholder.chatId),
        placeholder.messageId,
        threadId,
        result.turnId,
      );
      this.state.setActiveThread(
        "telegram",
        String(placeholder.chatId),
        placeholder.topicId,
        threadId,
      );
    } catch {
      await editor.fail();
    }
  }

  private async resolveThread(prefix: string) {
    const response = await this.appServer.listThreads(100);
    const matches = response.data.filter(
      (thread) => thread.id === prefix || thread.id.startsWith(prefix),
    );
    const match = matches[0];
    if (
      matches.length !== 1 ||
      !match ||
      !(await isWorkspaceAllowed(match.cwd, this.config.allowedWorkspaces))
    )
      return null;
    return match;
  }
}

export type TelegramCodexService = Pick<
  AppServerClient,
  "interruptThread" | "listThreads" | "resumeThread" | "runTurn" | "startThread"
>;

class StreamingEditor {
  private text = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly api: TelegramApi,
    private readonly ref: TelegramMessageRef,
    private readonly debounceMs: number,
  ) {}

  update(text: string): void {
    this.text = text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.api.editMessage(this.ref, renderStreaming(this.text, false)).catch(() => undefined);
    }, this.debounceMs);
  }

  async finish(text: string): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.api.editMessage(this.ref, renderStreaming(text || this.text, true));
  }

  async fail(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.api.editMessage(this.ref, "❌ Codex turn failed. Check the local gateway logs.");
  }
}

function parseCommand(text: string): { name: string; argument: string } | null {
  const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const name = match?.[1];
  return name ? { name: name.toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}
