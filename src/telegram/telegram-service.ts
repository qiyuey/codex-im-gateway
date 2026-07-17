import { randomBytes } from "node:crypto";
import type {
  AppServerClient,
  CompletedTurnRef,
  ResolvedServerRequest,
  UserInputRequest,
  WatchedThreadSnapshot,
} from "../codex/app-server-client.js";
import { type CodexAppUiState, loadCodexAppUiState } from "../codex/app-ui-state.js";
import type { ToolRequestUserInputAnswer } from "../codex/protocol/v2/ToolRequestUserInputAnswer.js";
import { ThreadQueue } from "../concurrency/thread-queue.js";
import { authorizedWorkspaces, type RuntimeConfig } from "../config/runtime-config.js";
import { type GatewayLanguage, type MessageKey, translate } from "../core/i18n.js";
import { routeMessage } from "../router/router.js";
import { isWorkspaceAllowed } from "../security/workspace.js";
import type { GatewayStateStore } from "../storage/gateway-state-store.js";
import {
  renderCompletionParts,
  renderStreaming,
  renderUserInputAnswered,
  renderUserInputQuestion,
  TASK_SWITCH_CALLBACK_PREFIX,
  THREAD_PICKER_CALLBACK_DATA,
  taskActionKeyboard,
  taskSwitchKeyboard,
} from "./render.js";
import { editRichMessageParts } from "./rich-message-parts.js";
import {
  buildThreadProjectCatalog,
  NO_PROJECT_ID,
  type ProjectThread,
  type ThreadProjectCatalog,
} from "./thread-projects.js";
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramMessage,
  TelegramMessageRef,
} from "./types.js";

const THREAD_CALLBACK_PREFIX = "thread:";
const PROJECT_CALLBACK_PREFIX = "project:";
const THREAD_PICKER_PROJECTS_CALLBACK_DATA = "threads:projects";
const THREAD_PICKER_BACK_CALLBACK_DATA = "threads:back";
const THREAD_PICKER_CANCEL_CALLBACK_DATA = "threads:cancel";
const NEW_TASK_CALLBACK_PREFIX = "new:";
const NEW_TASK_NO_DIRECTORY_CALLBACK_DATA = `${NEW_TASK_CALLBACK_PREFIX}none`;
const NEW_TASK_CANCEL_CALLBACK_DATA = `${NEW_TASK_CALLBACK_PREFIX}cancel`;
const MUTE_CALLBACK_PREFIX = "mute:";
const USER_INPUT_CALLBACK_PREFIX = "input:";
const DEFAULT_USER_INPUT_TTL_MS = 10 * 60_000;

interface ActiveTurnContext {
  readonly ref: TelegramMessageRef;
  readonly cwd: string;
}

interface PendingUserInput {
  readonly token: string;
  readonly request: UserInputRequest;
  readonly context: ActiveTurnContext;
  readonly answers: Record<string, ToolRequestUserInputAnswer>;
  readonly expiresAt: number;
  readonly timer: NodeJS.Timeout;
  questionIndex: number;
  promptRef: TelegramMessageRef | null;
}

export class TelegramService {
  private readonly queue = new ThreadQueue();
  private readonly background = new Set<Promise<unknown>>();
  private readonly activeTurnContexts = new Map<string, ActiveTurnContext>();
  private readonly pendingUserInputs = new Map<string, PendingUserInput>();
  private readonly pendingInputByMessage = new Map<string, string>();
  private readonly pendingInputByRequest = new Map<string, string>();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(
    private readonly config: RuntimeConfig,
    private readonly api: TelegramApi,
    private readonly state: GatewayStateStore,
    private readonly appServer: TelegramCodexService,
    private readonly editDebounceMs = 750,
    private readonly inboundEnabled: () => boolean = () => true,
    private readonly appUiStateLoader: () => Promise<CodexAppUiState | null> = loadCodexAppUiState,
  ) {
    this.unsubscribe.push(
      this.appServer.onUserInputRequest((request) => {
        this.trackBackground(
          this.handleUserInputRequest(request).catch(() => {
            try {
              this.appServer.rejectUserInput(request.id, "Telegram input bridge failed");
            } catch {
              // The app-server connection may already be closing.
            }
          }),
        );
      }),
      this.appServer.onServerRequestResolved((request) => {
        this.resolvePendingServerRequest(request);
      }),
      this.appServer.onTurnCompleted((turn) => {
        this.resolvePendingTurn(turn);
      }),
    );
  }

  async handleMessage(message: TelegramMessage): Promise<void> {
    if (!this.inboundEnabled() || !this.isAuthorized(message)) return;
    if (await this.handlePendingInputReply(message)) return;
    const command = parseCommand(message.text);
    if (command) {
      await this.handleCommand(message, command.name, command.argument);
      return;
    }
    await this.handlePrompt(message);
  }

  async handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
    if (!this.inboundEnabled() || !this.isAuthorizedSource(query)) {
      await this.api.answerCallbackQuery(query.queryId);
      return;
    }
    if (query.data.startsWith(USER_INPUT_CALLBACK_PREFIX)) {
      await this.handleUserInputCallback(query);
      return;
    }
    if (query.data.startsWith(NEW_TASK_CALLBACK_PREFIX)) {
      await this.handleNewTaskCallback(query, query.data.slice(NEW_TASK_CALLBACK_PREFIX.length));
      return;
    }
    if (query.data === THREAD_PICKER_CALLBACK_DATA) {
      await this.api.answerCallbackQuery(query.queryId);
      await this.sendThreadProjectPicker(query.chatId, query.topicId);
      return;
    }
    if (query.data === THREAD_PICKER_PROJECTS_CALLBACK_DATA) {
      await this.api.answerCallbackQuery(query.queryId);
      await this.editThreadProjectPicker(query);
      return;
    }
    if (query.data === THREAD_PICKER_BACK_CALLBACK_DATA) {
      await this.closeThreadPicker(query, this.text("returned"));
      return;
    }
    if (query.data === THREAD_PICKER_CANCEL_CALLBACK_DATA) {
      await this.closeThreadPicker(query, this.text("cancelledPicker"));
      return;
    }
    if (query.data.startsWith(PROJECT_CALLBACK_PREFIX)) {
      await this.handleProjectCallback(query, query.data.slice(PROJECT_CALLBACK_PREFIX.length));
      return;
    }
    if (query.data.startsWith(MUTE_CALLBACK_PREFIX)) {
      await this.handleMuteCallback(query, query.data.slice(MUTE_CALLBACK_PREFIX.length));
      return;
    }
    if (query.data.startsWith(TASK_SWITCH_CALLBACK_PREFIX)) {
      await this.handleThreadSelectionCallback(
        query,
        query.data.slice(TASK_SWITCH_CALLBACK_PREFIX.length),
        false,
      );
      return;
    }
    if (!query.data.startsWith(THREAD_CALLBACK_PREFIX)) {
      await this.api.answerCallbackQuery(query.queryId, this.text("unsupportedAction"));
      return;
    }
    const threadId = query.data.slice(THREAD_CALLBACK_PREFIX.length);
    const legacyBinding = this.state.findMessageBinding(
      "telegram",
      String(query.chatId),
      query.messageId,
    );
    await this.handleThreadSelectionCallback(
      query,
      threadId,
      legacyBinding?.codexThreadId !== threadId,
    );
  }

  private async handleThreadSelectionCallback(
    query: TelegramCallbackQuery,
    threadId: string,
    replaceSourceMessage: boolean,
  ): Promise<void> {
    if (!threadId) {
      await this.api.answerCallbackQuery(query.queryId, this.text("taskUnavailable"));
      return;
    }
    try {
      const resumed = await this.appServer.resumeThread(threadId);
      if (!(await isWorkspaceAllowed(resumed.cwd, authorizedWorkspaces(this.config)))) {
        await this.api.answerCallbackQuery(query.queryId, this.text("taskUnavailable"));
        return;
      }
      const snapshot = await this.appServer.readThreadSnapshot(threadId);
      this.state.selectAndWatchThread(
        "telegram",
        String(query.chatId),
        query.topicId,
        threadId,
        watchBaseline(snapshot),
        Date.now(),
        true,
      );
      await this.api.answerCallbackQuery(
        query.queryId,
        this.text("switchedAndWatching", { thread: threadId.slice(0, 8) }),
      );
      if (replaceSourceMessage) {
        await this.api
          .editTextMessage(
            {
              chatId: query.chatId,
              messageId: query.messageId,
              topicId: query.topicId,
            },
            `✅ ${this.text("switchedAndWatching", { thread: threadId.slice(0, 8) })}`,
            [],
          )
          .catch(() => undefined);
      }
    } catch {
      await this.api.answerCallbackQuery(query.queryId, this.text("taskUnavailable"));
    }
  }

  private async handleMuteCallback(query: TelegramCallbackQuery, threadId: string): Promise<void> {
    if (!threadId) {
      await this.api.answerCallbackQuery(query.queryId, this.text("taskUnavailable"));
      return;
    }
    this.state.muteThread(
      { channel: "telegram", chatId: String(query.chatId), topicId: query.topicId },
      threadId,
    );
    await this.api.answerCallbackQuery(query.queryId, this.text("mutedKeepCurrent"));
    await this.api
      .editMessageKeyboard(
        {
          chatId: query.chatId,
          messageId: query.messageId,
          topicId: query.topicId,
        },
        taskSwitchKeyboard(threadId, this.config.language),
      )
      .catch(() => undefined);
  }

  private async handleNewTaskCallback(
    query: TelegramCallbackQuery,
    directoryId: string,
  ): Promise<void> {
    if (directoryId === "cancel") {
      await this.api.answerCallbackQuery(query.queryId);
      await this.api.editTextMessage(
        { chatId: query.chatId, messageId: query.messageId, topicId: query.topicId },
        this.text("cancelledNewTask"),
        [],
      );
      return;
    }

    const directoryIndex = Number(directoryId);
    const cwd =
      directoryId === "none"
        ? this.config.tasksWorkspace
        : Number.isSafeInteger(directoryIndex) && directoryIndex >= 0
          ? this.config.allowedWorkspaces[directoryIndex]
          : undefined;
    if (cwd === undefined) {
      await this.api.answerCallbackQuery(query.queryId, this.text("directoryUnavailable"));
      return;
    }

    await this.api.answerCallbackQuery(query.queryId);
    try {
      const response = await this.appServer.startThread(cwd);
      this.state.selectAndWatchThread(
        "telegram",
        String(query.chatId),
        query.topicId,
        response.thread.id,
      );
      await this.api.editTextMessage(
        { chatId: query.chatId, messageId: query.messageId, topicId: query.topicId },
        this.text("createdAndWatching", { thread: response.thread.id }),
        [],
      );
    } catch {
      await this.api.editTextMessage(
        { chatId: query.chatId, messageId: query.messageId, topicId: query.topicId },
        this.text("newTaskFailed"),
        [],
      );
    }
  }

  private async handleUserInputRequest(request: UserInputRequest): Promise<void> {
    const context = this.activeTurnContexts.get(request.params.threadId);
    if (!context) {
      this.appServer.rejectUserInput(
        request.id,
        "No exact Telegram context is attached to this Codex turn",
      );
      return;
    }
    if (request.params.questions.some((question) => question.isSecret)) {
      await this.api.sendTextMessage(
        context.ref.chatId,
        this.text("secretInput"),
        context.ref.topicId,
      );
      this.appServer.rejectUserInput(request.id, "Secret input is not supported through Telegram");
      return;
    }
    if (request.params.questions.length === 0) {
      this.appServer.respondToUserInput(request.id, { answers: {} });
      return;
    }

    const token = randomBytes(12).toString("base64url");
    const autoResolutionMs = request.params.autoResolutionMs;
    const ttlMs =
      autoResolutionMs !== null && autoResolutionMs > 0
        ? autoResolutionMs
        : DEFAULT_USER_INPUT_TTL_MS;
    let pending: PendingUserInput;
    const timer = setTimeout(() => {
      this.expirePendingInput(pending, autoResolutionMs === null);
    }, ttlMs);
    timer.unref();
    pending = {
      token,
      request,
      context,
      answers: {},
      expiresAt: Date.now() + ttlMs,
      timer,
      questionIndex: 0,
      promptRef: null,
    };
    this.pendingUserInputs.set(token, pending);
    this.pendingInputByRequest.set(requestKey(request.id), token);

    try {
      await this.presentPendingQuestion(pending);
    } catch {
      this.cleanupPendingInput(pending);
      this.appServer.rejectUserInput(request.id, "Telegram could not present the input request");
    }
  }

  private async presentPendingQuestion(pending: PendingUserInput): Promise<void> {
    const question = pending.request.params.questions[pending.questionIndex];
    if (!question) throw new Error("Missing request_user_input question");
    const keyboard = question.options?.map((option, optionIndex) => [
      {
        text: option.label.slice(0, 48),
        callbackData: `${USER_INPUT_CALLBACK_PREFIX}${pending.token}:${pending.questionIndex}:${optionIndex}`,
      },
    ]);
    const ref = await this.api.sendTextMessage(
      pending.context.ref.chatId,
      renderUserInputQuestion({
        threadId: pending.request.params.threadId,
        cwd: pending.context.cwd,
        question,
        index: pending.questionIndex,
        total: pending.request.params.questions.length,
        language: this.config.language,
      }),
      pending.context.ref.topicId,
      keyboard?.length ? keyboard : undefined,
    );
    if (pending.promptRef) {
      this.pendingInputByMessage.delete(
        messageKey(pending.promptRef.chatId, pending.promptRef.messageId),
      );
    }
    pending.promptRef = ref;
    this.pendingInputByMessage.set(messageKey(ref.chatId, ref.messageId), pending.token);
  }

  private async handleUserInputCallback(query: TelegramCallbackQuery): Promise<void> {
    const [token, questionIndexText, optionIndexText, extra] = query.data
      .slice(USER_INPUT_CALLBACK_PREFIX.length)
      .split(":");
    const pending = token ? this.pendingUserInputs.get(token) : undefined;
    const questionIndex = Number(questionIndexText);
    const optionIndex = Number(optionIndexText);
    if (
      extra !== undefined ||
      !pending ||
      !Number.isSafeInteger(questionIndex) ||
      !Number.isSafeInteger(optionIndex) ||
      Date.now() >= pending.expiresAt
    ) {
      await this.api.answerCallbackQuery(query.queryId, this.text("inputRequestExpired"));
      return;
    }
    if (
      pending.context.ref.chatId !== query.chatId ||
      pending.context.ref.topicId !== query.topicId ||
      pending.promptRef?.messageId !== query.messageId ||
      pending.questionIndex !== questionIndex
    ) {
      await this.api.answerCallbackQuery(query.queryId, this.text("questionInactive"));
      return;
    }
    const question = pending.request.params.questions[questionIndex];
    const option = question?.options?.[optionIndex];
    if (!question || !option) {
      await this.api.answerCallbackQuery(query.queryId, this.text("optionUnavailable"));
      return;
    }

    await this.api.answerCallbackQuery(query.queryId, this.text("answerRecorded"));
    await this.submitPendingAnswer(pending, option.label);
  }

  private async handlePendingInputReply(message: TelegramMessage): Promise<boolean> {
    if (!message.replyToMessageId) return false;
    const token = this.pendingInputByMessage.get(
      messageKey(message.chatId, message.replyToMessageId),
    );
    const pending = token ? this.pendingUserInputs.get(token) : undefined;
    if (!pending) return false;
    if (
      pending.context.ref.chatId !== message.chatId ||
      pending.context.ref.topicId !== message.topicId ||
      pending.promptRef?.messageId !== message.replyToMessageId ||
      Date.now() >= pending.expiresAt
    ) {
      await this.api.sendTextMessage(
        message.chatId,
        this.text("inputRequestExpired"),
        message.topicId,
      );
      return true;
    }
    const answer = message.text.trim();
    if (!answer) {
      await this.api.sendTextMessage(
        message.chatId,
        this.text("sendNonEmptyAnswer"),
        message.topicId,
      );
      return true;
    }
    await this.submitPendingAnswer(pending, answer);
    return true;
  }

  private async submitPendingAnswer(pending: PendingUserInput, answer: string): Promise<void> {
    const question = pending.request.params.questions[pending.questionIndex];
    if (!question) return;
    pending.answers[question.id] = { answers: [answer] };
    const promptRef = pending.promptRef;
    pending.questionIndex += 1;
    if (pending.questionIndex < pending.request.params.questions.length) {
      if (promptRef) {
        await this.api
          .editTextMessage(
            promptRef,
            renderUserInputAnswered(question, answer, this.config.language),
            [],
          )
          .catch(() => undefined);
      }
      try {
        await this.presentPendingQuestion(pending);
      } catch {
        this.cleanupPendingInput(pending);
        this.appServer.rejectUserInput(
          pending.request.id,
          "Telegram could not present the remaining input questions",
        );
      }
      return;
    }

    try {
      this.appServer.respondToUserInput(pending.request.id, { answers: pending.answers });
      this.cleanupPendingInput(pending);
      if (promptRef) {
        await this.api
          .editTextMessage(
            promptRef,
            renderUserInputAnswered(question, answer, this.config.language),
            [],
          )
          .catch(() => undefined);
      }
    } catch {
      this.cleanupPendingInput(pending);
      if (promptRef) {
        await this.api
          .editTextMessage(promptRef, this.text("answerCouldNotBeSent"), [])
          .catch(() => undefined);
      }
    }
  }

  private resolvePendingServerRequest(request: ResolvedServerRequest): void {
    const token = this.pendingInputByRequest.get(requestKey(request.requestId));
    const pending = token ? this.pendingUserInputs.get(token) : undefined;
    if (pending && pending.request.params.threadId === request.threadId) {
      this.expirePendingInput(pending, false);
    }
  }

  private resolvePendingTurn(turn: CompletedTurnRef): void {
    for (const pending of this.pendingUserInputs.values()) {
      if (
        pending.request.params.threadId === turn.threadId &&
        pending.request.params.turnId === turn.turnId
      ) {
        this.expirePendingInput(pending, false);
      }
    }
  }

  private expirePendingInput(pending: PendingUserInput, reject: boolean): void {
    if (this.pendingUserInputs.get(pending.token) !== pending) return;
    this.cleanupPendingInput(pending);
    if (reject) {
      try {
        this.appServer.rejectUserInput(pending.request.id, "Telegram input request expired");
      } catch {
        // The app-server connection may already be closing.
      }
    }
    if (pending.promptRef) {
      void this.api
        .editTextMessage(pending.promptRef, this.text("codexInputExpired"), [])
        .catch(() => undefined);
    }
  }

  private cleanupPendingInput(pending: PendingUserInput): void {
    clearTimeout(pending.timer);
    this.pendingUserInputs.delete(pending.token);
    this.pendingInputByRequest.delete(requestKey(pending.request.id));
    if (pending.promptRef) {
      this.pendingInputByMessage.delete(
        messageKey(pending.promptRef.chatId, pending.promptRef.messageId),
      );
    }
  }

  private async handleProjectCallback(
    query: TelegramCallbackQuery,
    projectId: string,
  ): Promise<void> {
    const catalog = await this.loadThreadProjectCatalog();
    const project = catalog.projects.find((candidate) => candidate.id === projectId);
    const threads = projectId === NO_PROJECT_ID ? catalog.noProjectThreads : project?.threads;
    if (!threads) {
      await this.api.answerCallbackQuery(query.queryId, this.text("projectUnavailable"));
      return;
    }

    await this.api.answerCallbackQuery(query.queryId);
    const label = project?.label ?? this.text("otherTasks");
    const text = threads.length
      ? this.text("chooseTaskInProject", { project: label })
      : this.text("noProjectTasks", { project: label });
    const keyboard = threads
      .slice(0, 10)
      .map((thread) => [threadButton(thread, this.config.language)]);
    keyboard.push(
      threadPickerNavigationRow(THREAD_PICKER_PROJECTS_CALLBACK_DATA, this.config.language),
    );
    await this.api.editTextMessage(
      {
        chatId: query.chatId,
        messageId: query.messageId,
        topicId: query.topicId,
      },
      text,
      keyboard,
    );
  }

  async drain(): Promise<void> {
    for (const pending of [...this.pendingUserInputs.values()]) {
      this.expirePendingInput(pending, true);
    }
    await Promise.allSettled([...this.background]);
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  private trackBackground(task: Promise<unknown>): void {
    this.background.add(task);
    void task.then(
      () => this.background.delete(task),
      () => this.background.delete(task),
    );
  }

  private isAuthorized(message: TelegramMessage): boolean {
    return !message.isForwarded && this.isAuthorizedSource(message);
  }

  private isAuthorizedSource(source: {
    readonly chatId: number;
    readonly chatType: string;
    readonly userId: number;
  }): boolean {
    return (
      source.chatType === "private" &&
      source.userId === this.config.telegramAllowedUserId &&
      source.chatId === this.config.telegramAllowedChatId
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
      await this.api.sendTextMessage(
        message.chatId,
        active
          ? this.text("currentThread", {
              thread: active,
              watchState: this.state.isThreadMuted(
                { channel: "telegram", chatId: String(message.chatId), topicId: message.topicId },
                active,
              )
                ? this.text("muted")
                : this.text("watching"),
            })
          : this.text("noThreadSelected"),
        message.topicId,
      );
      return;
    }
    if (command === "detach") {
      const detached = this.state.detach("telegram", String(message.chatId), message.topicId);
      await this.api.sendTextMessage(
        message.chatId,
        detached ? this.text("threadDetached") : this.text("noThreadSelected"),
        message.topicId,
      );
      return;
    }
    if (command === "mute") {
      const active = this.state.getActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
      );
      if (active) {
        this.state.muteThread(
          { channel: "telegram", chatId: String(message.chatId), topicId: message.topicId },
          active,
        );
      }
      await this.api.sendTextMessage(
        message.chatId,
        active ? this.text("notificationsMuted") : this.text("noThreadSelected"),
        message.topicId,
      );
      return;
    }
    if (command === "unmute") {
      const active = this.state.getActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
      );
      if (active) {
        this.state.unmuteThread(
          { channel: "telegram", chatId: String(message.chatId), topicId: message.topicId },
          active,
        );
      }
      await this.api.sendTextMessage(
        message.chatId,
        active ? this.text("notificationsUnmuted") : this.text("noThreadSelected"),
        message.topicId,
      );
      return;
    }
    if (command === "threads") {
      await this.sendThreadProjectPicker(message.chatId, message.topicId);
      return;
    }
    if (command === "use") {
      if (!argument) {
        await this.api.sendTextMessage(message.chatId, this.text("usageUse"), message.topicId);
        return;
      }
      const thread = await this.resolveThread(argument);
      if (!thread) {
        await this.api.sendTextMessage(
          message.chatId,
          this.text("threadNotFound"),
          message.topicId,
        );
        return;
      }
      try {
        const snapshot = await this.appServer.readThreadSnapshot(thread.id);
        this.state.selectAndWatchThread(
          "telegram",
          String(message.chatId),
          message.topicId,
          thread.id,
          watchBaseline(snapshot),
        );
      } catch {
        await this.api.sendTextMessage(
          message.chatId,
          this.text("threadUnavailable"),
          message.topicId,
        );
        return;
      }
      await this.api.sendTextMessage(
        message.chatId,
        this.text("usingAndWatching", { thread: thread.id }),
        message.topicId,
      );
      return;
    }
    if (command === "new") {
      await this.api.sendTextMessage(
        message.chatId,
        this.text("chooseNewTaskDirectory"),
        message.topicId,
        newTaskDirectoryKeyboard(this.config.allowedWorkspaces, this.config.language),
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
      await this.api.sendTextMessage(
        message.chatId,
        stopped || cancelled ? this.text("interruptRequested") : this.text("noActiveTurn"),
        message.topicId,
      );
      return;
    }
    await this.api.sendTextMessage(message.chatId, this.text("commandList"), message.topicId);
  }

  private async handlePrompt(message: TelegramMessage): Promise<void> {
    const chatId = String(message.chatId);
    const replyBinding = message.replyToMessageId
      ? this.state.findMessageBinding("telegram", chatId, message.replyToMessageId)
      : null;
    const active = this.state.getActiveThread("telegram", chatId, message.topicId);
    const oneShotRoute = this.state.takeNextMessageRoute("telegram", chatId, message.topicId);
    const decision = routeMessage({
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      replyBinding: replyBinding
        ? { codexThreadId: replyBinding.codexThreadId, codexTurnId: replyBinding.codexTurnId }
        : null,
      topicBinding: message.topicId && active ? { codexThreadId: active, codexTurnId: null } : null,
      explicitThreadId: oneShotRoute,
      activeThreadId: active,
    });
    if (decision.kind === "error") {
      const text =
        decision.code === "unknown_reply"
          ? this.text("unknownReply")
          : this.text("noThreadSelectedHelp");
      await this.api.sendTextMessage(message.chatId, text, message.topicId);
      return;
    }

    let resumed: Awaited<ReturnType<TelegramCodexService["resumeThread"]>>;
    try {
      resumed = await this.appServer.resumeThread(decision.threadId);
    } catch {
      await this.rejectUnavailableRoute(message, decision, "unavailable");
      return;
    }
    if (!(await isWorkspaceAllowed(resumed.cwd, authorizedWorkspaces(this.config)))) {
      await this.rejectUnavailableRoute(message, decision, "workspace_not_allowed");
      return;
    }
    if (!this.queue.isBusy(decision.threadId)) {
      try {
        const snapshot = await this.appServer.readThreadSnapshot(decision.threadId);
        if (snapshot.latestTurn?.status === "in_progress") {
          await this.api.sendTextMessage(message.chatId, this.text("taskBusy"), message.topicId);
          return;
        }
      } catch {
        await this.rejectUnavailableRoute(message, decision, "unavailable");
        return;
      }
    }

    const placeholder = await this.api.sendTextMessage(
      message.chatId,
      `⏳ ${this.text("codexWorking")}`,
      message.topicId,
    );
    this.state.bindMessage("telegram", chatId, placeholder.messageId, decision.threadId, "pending");
    const task = this.queue.enqueue(decision.threadId, () =>
      this.runFollowUp(decision.threadId, message.text, placeholder, resumed.cwd),
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
    cwd: string,
  ): Promise<void> {
    const editor = new StreamingEditor(
      this.api,
      placeholder,
      this.editDebounceMs,
      this.config.language,
      this.config.tasksWorkspace,
    );
    const context = { ref: placeholder, cwd } satisfies ActiveTurnContext;
    this.activeTurnContexts.set(threadId, context);
    try {
      const result = await this.appServer.runTurn(threadId, prompt, (text) => editor.update(text));
      await editor.finish(result);
      this.state.recordTerminalDelivery(
        {
          channel: "telegram",
          chatId: String(placeholder.chatId),
          topicId: placeholder.topicId,
        },
        threadId,
        result.turnId,
        "telegram_turn",
        null,
        placeholder.messageId,
      );
      this.state.acknowledgeWatchedState(
        {
          channel: "telegram",
          chatId: String(placeholder.chatId),
          topicId: placeholder.topicId,
        },
        threadId,
        { turnId: result.turnId },
      );
      try {
        const snapshot = await this.appServer.readThreadSnapshot(threadId);
        if (snapshot.blockedGoal) {
          this.state.acknowledgeWatchedState(
            {
              channel: "telegram",
              chatId: String(placeholder.chatId),
              topicId: placeholder.topicId,
            },
            threadId,
            { blockedGoalUpdatedAt: snapshot.blockedGoal.updatedAt },
          );
        }
      } catch {
        // Watching is best-effort and must not turn a completed Telegram response into a failure.
      }
    } catch {
      await editor.fail();
    } finally {
      if (this.activeTurnContexts.get(threadId) === context) {
        this.activeTurnContexts.delete(threadId);
      }
    }
  }

  private async rejectUnavailableRoute(
    message: TelegramMessage,
    decision: Extract<ReturnType<typeof routeMessage>, { kind: "routed" }>,
    reason: "unavailable" | "workspace_not_allowed",
  ): Promise<void> {
    const selectionBacked = decision.source === "active" || decision.source === "topic";
    const detached =
      selectionBacked &&
      this.state.detachIfActiveThread(
        "telegram",
        String(message.chatId),
        message.topicId,
        decision.threadId,
      );
    const text = detached
      ? this.text(reason === "unavailable" ? "activeTaskUnavailable" : "activeWorkspaceNotAllowed")
      : this.text(reason === "unavailable" ? "threadUnavailable" : "workspaceNotAllowed");
    await this.api.sendTextMessage(
      message.chatId,
      text,
      message.topicId,
      detached
        ? [[{ text: this.text("chooseTask"), callbackData: THREAD_PICKER_CALLBACK_DATA }]]
        : undefined,
    );
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
      !(await isWorkspaceAllowed(match.cwd, authorizedWorkspaces(this.config)))
    )
      return null;
    return match;
  }

  private async loadThreadProjectCatalog(): Promise<ThreadProjectCatalog> {
    const threads: ProjectThread[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const response = await this.appServer.listThreads(100, cursor);
      threads.push(...response.data);
      const nextCursor = response.nextCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return buildThreadProjectCatalog(
      threads,
      authorizedWorkspaces(this.config),
      await this.appUiStateLoader(),
    );
  }

  private async sendThreadProjectPicker(chatId: number, topicId: string | null): Promise<void> {
    const catalog = await this.loadThreadProjectCatalog();
    await this.api.sendTextMessage(
      chatId,
      this.text("chooseProject"),
      topicId,
      threadProjectKeyboard(catalog, this.config.language),
    );
  }

  private async editThreadProjectPicker(query: TelegramCallbackQuery): Promise<void> {
    const catalog = await this.loadThreadProjectCatalog();
    await this.api.editTextMessage(
      {
        chatId: query.chatId,
        messageId: query.messageId,
        topicId: query.topicId,
      },
      this.text("chooseProject"),
      threadProjectKeyboard(catalog, this.config.language),
    );
  }

  private async closeThreadPicker(query: TelegramCallbackQuery, text: string): Promise<void> {
    await this.api.answerCallbackQuery(query.queryId);
    await this.api.editTextMessage(
      {
        chatId: query.chatId,
        messageId: query.messageId,
        topicId: query.topicId,
      },
      text,
      [],
    );
  }

  private text(key: MessageKey, values: Readonly<Record<string, string | number>> = {}): string {
    return translate(this.config.language, key, values);
  }
}

export type TelegramCodexService = Pick<
  AppServerClient,
  | "interruptThread"
  | "listThreads"
  | "onServerRequestResolved"
  | "onTurnCompleted"
  | "onUserInputRequest"
  | "readThreadSnapshot"
  | "rejectUserInput"
  | "respondToUserInput"
  | "resumeThread"
  | "runTurn"
  | "startThread"
>;

class StreamingEditor {
  private text = "";
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly api: TelegramApi,
    private readonly ref: TelegramMessageRef,
    private readonly debounceMs: number,
    private readonly language: GatewayLanguage,
    private readonly tasksWorkspace: string,
  ) {}

  update(text: string): void {
    this.text = text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.api
        .editRichMessage(this.ref, renderStreaming(this.text, false, this.language))
        .catch(() => undefined);
    }, this.debounceMs);
  }

  async finish(result: Awaited<ReturnType<TelegramCodexService["runTurn"]>>): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await editRichMessageParts(
      this.api,
      this.ref,
      renderCompletionParts(
        {
          ...result,
          finalMessage: result.finalMessage || this.text,
        },
        this.language,
        result.cwd === this.tasksWorkspace ? "Tasks" : undefined,
      ),
      taskActionKeyboard(result.threadId, this.language),
    );
  }

  async fail(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.api.editTextMessage(this.ref, translate(this.language, "turnFailed"));
  }
}

function parseCommand(text: string): { name: string; argument: string } | null {
  const match = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  const name = match?.[1];
  return name ? { name: name.toLowerCase(), argument: match[2]?.trim() ?? "" } : null;
}

function threadButton(thread: ProjectThread, language: GatewayLanguage) {
  return {
    text: `${thread.id.slice(0, 8)} · ${(
      thread.name ?? (thread.preview || translate(language, "untitled"))
    ).slice(0, 48)}`,
    callbackData: `${THREAD_CALLBACK_PREFIX}${thread.id}`,
  };
}

function threadProjectKeyboard(catalog: ThreadProjectCatalog, language: GatewayLanguage) {
  const keyboard = catalog.projects.slice(0, 20).map((project) => [
    {
      text: `📁 ${project.label}`,
      callbackData: `${PROJECT_CALLBACK_PREFIX}${project.id}`,
    },
  ]);
  keyboard.push([
    {
      text: `📋 ${translate(language, "otherTasks")}`,
      callbackData: `${PROJECT_CALLBACK_PREFIX}${NO_PROJECT_ID}`,
    },
  ]);
  keyboard.push(threadPickerNavigationRow(THREAD_PICKER_BACK_CALLBACK_DATA, language));
  return keyboard;
}

function newTaskDirectoryKeyboard(allowedWorkspaces: readonly string[], language: GatewayLanguage) {
  const keyboard = allowedWorkspaces.map((workspace, index) => [
    {
      text: `📁 ${directoryButtonLabel(workspace)}`,
      callbackData: `${NEW_TASK_CALLBACK_PREFIX}${index}`,
    },
  ]);
  keyboard.push([
    {
      text: `📋 ${translate(language, "noDirectoryTask")}`,
      callbackData: NEW_TASK_NO_DIRECTORY_CALLBACK_DATA,
    },
  ]);
  keyboard.push([
    {
      text: translate(language, "cancelled"),
      callbackData: NEW_TASK_CANCEL_CALLBACK_DATA,
    },
  ]);
  return keyboard;
}

function directoryButtonLabel(directory: string): string {
  const maxLength = 56;
  return directory.length <= maxLength ? directory : `…${directory.slice(-(maxLength - 1))}`;
}

function threadPickerNavigationRow(backCallbackData: string, language: GatewayLanguage) {
  return [
    { text: translate(language, "back"), callbackData: backCallbackData },
    { text: translate(language, "cancelled"), callbackData: THREAD_PICKER_CANCEL_CALLBACK_DATA },
  ];
}

function watchBaseline(snapshot: WatchedThreadSnapshot) {
  return {
    turnId: snapshot.latestTerminalTurnId,
    blockedGoalUpdatedAt: snapshot.blockedGoal?.updatedAt ?? null,
  };
}

function messageKey(chatId: number, messageId: string): string {
  return `${chatId}:${messageId}`;
}

function requestKey(requestId: string | number): string {
  return `${typeof requestId}:${requestId}`;
}
