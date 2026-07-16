import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompletedTurnRef,
  ResolvedServerRequest,
  UserInputRequest,
} from "../src/codex/app-server-client.js";
import type { CodexAppUiState } from "../src/codex/app-ui-state.js";
import type { RuntimeConfig } from "../src/config/runtime-config.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { GatewayStateStore } from "../src/storage/gateway-state-store.js";
import { type TelegramCodexService, TelegramService } from "../src/telegram/telegram-service.js";
import type {
  TelegramApi,
  TelegramCallbackQuery,
  TelegramInlineButton,
  TelegramMessage,
  TelegramMessageRef,
} from "../src/telegram/types.js";

let directory: string;
let database: GatewayDatabase;
let state: GatewayStateStore;
let api: FakeTelegramApi;
let codex: FakeCodexService;
let service: TelegramService;
let config: RuntimeConfig;
let appUiState: CodexAppUiState | null;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "gateway-telegram-")));
  database = new GatewayDatabase(":memory:");
  state = new GatewayStateStore(database);
  api = new FakeTelegramApi();
  codex = createFakeCodex();
  appUiState = null;
  config = {
    telegramBotToken: "test-token",
    telegramAllowedUserId: 7,
    telegramAllowedChatId: 42,
    allowedWorkspaces: [directory],
    tasksWorkspace: join(directory, "Tasks"),
    dispatchIntervalMs: 100,
    language: "zh",
  };
  service = new TelegramService(
    config,
    api,
    state,
    codex as unknown as TelegramCodexService,
    0,
    () => true,
    async () => appUiState,
  );
});

afterEach(async () => {
  await service.drain();
  database.close();
  await rm(directory, { force: true, recursive: true });
});

describe("TelegramService", () => {
  it("renders command UI in English mode", async () => {
    await service.drain();
    config = { ...config, language: "en" };
    service = new TelegramService(
      config,
      api,
      state,
      codex as unknown as TelegramCodexService,
      0,
      () => true,
      async () => appUiState,
    );

    await service.handleMessage(message({ text: "/current" }));

    expect(api.sent.at(-1)?.content).toBe("No task selected.");
  });

  it("silently ignores unauthorized users and non-private chats", async () => {
    await service.handleMessage(message({ userId: 999 }));
    await service.handleMessage(message({ chatType: "group" }));
    await service.handleMessage(message({ isForwarded: true }));
    expect(api.sent).toHaveLength(0);
    expect(codex.runTurn).not.toHaveBeenCalled();
  });

  it("routes a reply by its durable binding before the active thread", async () => {
    state.bindMessage("telegram", "42", "50", "historical-thread", "old-turn");
    state.setActiveThread("telegram", "42", null, "active-thread");

    await service.handleMessage(message({ replyToMessageId: "50", text: "continue this" }));
    await service.drain();

    expect(codex.runTurn).toHaveBeenCalledWith(
      "historical-thread",
      "continue this",
      expect.any(Function),
    );
    expect(api.edits.at(-1)?.content).toContain("final answer");
    expect(api.edits.at(-1)?.format).toBe("rich_markdown");
    const placeholder = api.sent[0];
    if (!placeholder) throw new Error("Expected a streaming placeholder");
    expect(state.findMessageBinding("telegram", "42", placeholder.messageId)).toMatchObject({
      codexThreadId: "historical-thread",
      codexTurnId: "new-turn",
    });
    expect(
      state.getTerminalDeliveryMessageId(
        { channel: "telegram", chatId: "42" },
        "historical-thread",
        "new-turn",
      ),
    ).toBe(placeholder.messageId);
  });

  it("does not fall back from an unknown replied message", async () => {
    state.setActiveThread("telegram", "42", null, "active-thread");
    await service.handleMessage(message({ replyToMessageId: "missing" }));
    await service.drain();

    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.sent[0]?.content).toContain("这条消息未关联可继续对话的 Codex 任务");
    expect(api.sent[0]?.content).toContain("不要继续引用回复这条通知");
  });

  it("rejects a durable binding whose resumed workspace is not allowed", async () => {
    state.bindMessage("telegram", "42", "50", "outside-thread", "old-turn");
    codex.resumeThread.mockResolvedValue({ cwd: "/workspace/not-allowed" });
    await service.handleMessage(message({ replyToMessageId: "50" }));

    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.sent[0]?.content).toContain("工作区不在允许范围内");
  });

  it("shows directory choices before creating a task", async () => {
    await service.handleMessage(message({ text: "/new" }));

    expect(codex.startThread).not.toHaveBeenCalled();
    expect(api.sent.at(-1)).toMatchObject({
      content: "请选择新任务使用的目录：",
      inlineKeyboard: [
        [{ text: expect.stringContaining("gateway-telegram-"), callbackData: "new:0" }],
        [{ text: "📋 无项目任务（Tasks）", callbackData: "new:none" }],
        [{ text: "✖️ 取消", callbackData: "new:cancel" }],
      ],
    });

    await service.handleCallbackQuery(callbackQuery({ data: "new:0" }));

    expect(codex.startThread).toHaveBeenCalledWith(directory);
    expect(state.getActiveThread("telegram", "42")).toBe("created-thread");
    expect(state.getThreadWatch("telegram", "42")?.codexThreadId).toBe("created-thread");
    expect(api.edits.at(-1)?.content).toContain("已创建并切换到任务 created-thread");
    expect(api.edits.at(-1)?.inlineKeyboard).toEqual([]);
  });

  it("creates a task in the dedicated projectless workspace when Tasks is selected", async () => {
    await service.handleMessage(message({ text: "/new" }));
    await service.handleCallbackQuery(callbackQuery({ data: "new:none" }));

    expect(codex.startThread).toHaveBeenCalledWith(config.tasksWorkspace);
    expect(state.getActiveThread("telegram", "42")).toBe("created-thread");
  });

  it("rejects stale or malformed new-task directory callbacks", async () => {
    await service.handleCallbackQuery(callbackQuery({ data: "new:99" }));

    expect(codex.startThread).not.toHaveBeenCalled();
    expect(api.callbackAnswers.at(-1)?.text).toBe("此目录已不可用。");
  });

  it("selects an unambiguous allowed thread by short id and detaches it", async () => {
    codex.listThreads.mockResolvedValue({
      data: [{ id: "abcdef12-full", cwd: directory, name: "Example", preview: "Example" }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await service.handleMessage(message({ text: "/use abcdef12" }));
    expect(state.getActiveThread("telegram", "42")).toBe("abcdef12-full");
    expect(state.getThreadWatch("telegram", "42")?.codexThreadId).toBe("abcdef12-full");

    await service.handleMessage(message({ text: "/mute" }));
    expect(state.getActiveThread("telegram", "42")).toBe("abcdef12-full");
    expect(state.isThreadMuted({ channel: "telegram", chatId: "42" }, "abcdef12-full")).toBe(true);

    await service.handleMessage(message({ text: "/unmute" }));
    expect(state.isThreadMuted({ channel: "telegram", chatId: "42" }, "abcdef12-full")).toBe(false);

    await service.handleMessage(message({ text: "/use abcdef12" }));

    await service.handleMessage(message({ text: "/detach" }));
    expect(state.getActiveThread("telegram", "42")).toBeNull();
  });

  it("mutes the exact watched task from its status-card action", async () => {
    state.selectAndWatchThread("telegram", "42", null, "thread-1");

    await service.handleCallbackQuery(callbackQuery({ messageId: "200", data: "mute:thread-1" }));

    expect(state.isThreadMuted({ channel: "telegram", chatId: "42" }, "thread-1")).toBe(true);
    expect(state.getActiveThread("telegram", "42")).toBe("thread-1");
    expect(api.callbackAnswers.at(-1)?.text).toBe("已停止此任务的完成通知。");
    expect(api.edits).toHaveLength(0);
    expect(api.keyboardEdits).toEqual([
      {
        ref: { chatId: 42, messageId: "200", topicId: null },
        inlineKeyboard: [[{ text: "切换到此任务", callbackData: "switch:thread-1" }]],
      },
    ]);
  });

  it("preserves a persistent task card when its switch action is selected", async () => {
    await service.handleCallbackQuery(callbackQuery({ messageId: "201", data: "switch:thread-1" }));

    expect(state.getActiveThread("telegram", "42")).toBe("thread-1");
    expect(api.callbackAnswers.at(-1)?.text).toBe("已切换到任务 thread-1。");
    expect(api.edits).toHaveLength(0);
  });

  it("preserves an already-delivered legacy task card when switching", async () => {
    state.bindMessage("telegram", "42", "202", "legacy-thread", "turn-1");

    await service.handleCallbackQuery(
      callbackQuery({ messageId: "202", data: "thread:legacy-thread" }),
    );

    expect(state.getActiveThread("telegram", "42")).toBe("legacy-thread");
    expect(api.callbackAnswers.at(-1)?.text).toBe("已切换到任务 legacy-t。");
    expect(api.edits).toHaveLength(0);
  });

  it("returns projects first, then their threads, and selects a thread", async () => {
    await mkdir(join(directory, ".git"));
    appUiState = appState([directory]);
    codex.listThreads.mockResolvedValue({
      data: [
        { id: "abcdef12-full", cwd: directory, name: "Example", preview: "Example" },
        { id: "outside-thread", cwd: "/workspace/not-allowed", name: "Hidden", preview: "" },
      ],
      nextCursor: null,
      backwardsCursor: null,
    });

    await service.handleMessage(message({ text: "/threads", topicId: "9" }));

    expect(api.sent[0]).toMatchObject({
      content: "请选择项目：",
      format: "plain_text",
      topicId: "9",
    });
    expect(api.sent[0]?.inlineKeyboard).toHaveLength(3);
    expect(api.sent[0]?.inlineKeyboard?.[0]?.[0]).toMatchObject({
      text: expect.stringContaining("gateway-telegram-"),
      callbackData: expect.stringMatching(/^project:[A-Za-z0-9_-]{16}$/),
    });
    expect(api.sent[0]?.inlineKeyboard?.[1]?.[0]).toEqual({
      text: "📋 其他任务",
      callbackData: "project:none",
    });
    const projectCallback = api.sent[0]?.inlineKeyboard?.[0]?.[0]?.callbackData;
    if (!projectCallback) throw new Error("Expected a project callback");

    await service.handleCallbackQuery(callbackQuery({ data: projectCallback, topicId: "9" }));

    expect(api.sent).toHaveLength(1);
    expect(api.edits[0]).toMatchObject({
      ref: { chatId: 42, messageId: "100", topicId: "9" },
      content: expect.stringContaining("请选择“gateway-telegram-"),
      format: "plain_text",
      inlineKeyboard: [
        [{ text: "abcdef12 · Example", callbackData: "thread:abcdef12-full" }],
        [
          { text: "⬅️ 返回", callbackData: "threads:projects" },
          { text: "✖️ 取消", callbackData: "threads:cancel" },
        ],
      ],
    });

    await service.handleCallbackQuery(
      callbackQuery({ data: "thread:abcdef12-full", topicId: "9" }),
    );

    expect(codex.resumeThread).toHaveBeenCalledWith("abcdef12-full");
    expect(state.getActiveThread("telegram", "42", "9")).toBe("abcdef12-full");
    expect(api.callbackAnswers.at(-1)).toEqual({
      queryId: "callback-1",
      text: "已切换到任务 abcdef12。",
    });
    expect(api.edits[1]).toMatchObject({
      ref: { chatId: 42, messageId: "100", topicId: "9" },
      content: "✅ 已切换到任务 abcdef12。",
      format: "plain_text",
      inlineKeyboard: [],
    });
    expect(state.getThreadWatch("telegram", "42", "9")?.codexThreadId).toBe("abcdef12-full");
  });

  it("opens the allowed task picker from an unbound notification action", async () => {
    codex.listThreads.mockResolvedValue({
      data: [{ id: "projectless-thread", cwd: directory, name: "Quick task", preview: "" }],
      nextCursor: null,
      backwardsCursor: null,
    });

    await service.handleCallbackQuery(callbackQuery({ data: "threads", messageId: "60" }));

    expect(api.callbackAnswers.at(-1)).toEqual({ queryId: "callback-1", text: undefined });
    expect(api.sent[0]).toMatchObject({
      content: "请选择项目：",
      inlineKeyboard: [
        [{ text: "📋 其他任务", callbackData: "project:none" }],
        [
          { text: "⬅️ 返回", callbackData: "threads:back" },
          { text: "✖️ 取消", callbackData: "threads:cancel" },
        ],
      ],
    });
    expect(api.edits).toHaveLength(0);
  });

  it("rejects malformed task-picker callback data", async () => {
    await service.handleCallbackQuery(callbackQuery({ data: "threads:unexpected" }));

    expect(codex.listThreads).not.toHaveBeenCalled();
    expect(api.callbackAnswers.at(-1)).toEqual({
      queryId: "callback-1",
      text: "不支持此操作。",
    });
  });

  it("groups allowed threads without a Git project under Tasks", async () => {
    codex.listThreads.mockResolvedValue({
      data: [{ id: "projectless-thread", cwd: directory, name: "Quick task", preview: "" }],
      nextCursor: null,
      backwardsCursor: null,
    });

    await service.handleMessage(message({ text: "/threads" }));

    expect(api.sent[0]?.inlineKeyboard).toEqual([
      [{ text: "📋 其他任务", callbackData: "project:none" }],
      [
        { text: "⬅️ 返回", callbackData: "threads:back" },
        { text: "✖️ 取消", callbackData: "threads:cancel" },
      ],
    ]);

    await service.handleCallbackQuery(callbackQuery({ data: "project:none" }));

    expect(api.sent).toHaveLength(1);
    expect(api.edits[0]).toMatchObject({
      content: "请选择“其他任务”中的任务：",
      format: "plain_text",
      inlineKeyboard: [
        [{ text: "projectl · Quick task", callbackData: "thread:projectless-thread" }],
        [
          { text: "⬅️ 返回", callbackData: "threads:projects" },
          { text: "✖️ 取消", callbackData: "threads:cancel" },
        ],
      ],
    });
  });

  it("returns from tasks to projects and cancels without changing the active thread", async () => {
    state.selectAndWatchThread("telegram", "42", null, "current-thread");
    codex.listThreads.mockResolvedValue({
      data: [{ id: "projectless-thread", cwd: directory, name: "Quick task", preview: "" }],
      nextCursor: null,
      backwardsCursor: null,
    });

    await service.handleCallbackQuery(callbackQuery({ data: "project:none" }));
    await service.handleCallbackQuery(callbackQuery({ data: "threads:projects" }));

    expect(api.edits.at(-1)).toMatchObject({
      content: "请选择项目：",
      inlineKeyboard: [
        [{ text: "📋 其他任务", callbackData: "project:none" }],
        [
          { text: "⬅️ 返回", callbackData: "threads:back" },
          { text: "✖️ 取消", callbackData: "threads:cancel" },
        ],
      ],
    });

    await service.handleCallbackQuery(callbackQuery({ data: "threads:cancel" }));

    expect(api.edits.at(-1)).toMatchObject({
      content: "已取消选择任务。",
      inlineKeyboard: [],
    });
    expect(state.getActiveThread("telegram", "42")).toBe("current-thread");
  });

  it("closes the project picker when returning from its top level", async () => {
    await service.handleCallbackQuery(callbackQuery({ data: "threads:back" }));

    expect(api.edits.at(-1)).toMatchObject({ content: "已返回。", inlineKeyboard: [] });
  });

  it("shows an empty Tasks group and removes the project keyboard", async () => {
    await mkdir(join(directory, ".git"));

    await service.handleCallbackQuery(callbackQuery({ data: "project:none" }));

    expect(api.sent).toHaveLength(0);
    expect(api.edits[0]).toMatchObject({
      content: "“其他任务”中没有可用任务。",
      format: "plain_text",
      inlineKeyboard: [
        [
          { text: "⬅️ 返回", callbackData: "threads:projects" },
          { text: "✖️ 取消", callbackData: "threads:cancel" },
        ],
      ],
    });
  });

  it("shows projects from every configured allowed workspace", async () => {
    const secondDirectory = await realpath(await mkdtemp(join(tmpdir(), "gateway-financial-")));
    try {
      await Promise.all([mkdir(join(directory, ".git")), mkdir(join(secondDirectory, ".git"))]);
      config = { ...config, allowedWorkspaces: [directory, secondDirectory] };
      appUiState = appState([directory, secondDirectory]);
      service = new TelegramService(
        config,
        api,
        state,
        codex as unknown as TelegramCodexService,
        0,
        () => true,
        async () => appUiState,
      );
      codex.listThreads
        .mockResolvedValueOnce({
          data: [{ id: "gateway-thread", cwd: directory, name: "Gateway", preview: "" }],
          nextCursor: "next-page",
          backwardsCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: "financial-thread", cwd: secondDirectory, name: "Financial", preview: "" }],
          nextCursor: null,
          backwardsCursor: null,
        });

      await service.handleMessage(message({ text: "/threads" }));

      expect(api.sent[0]?.inlineKeyboard?.map((row) => row[0]?.text)).toEqual([
        expect.stringContaining("gateway-telegram-"),
        expect.stringContaining("gateway-financial-"),
        "📋 其他任务",
        "⬅️ 返回",
      ]);
      expect(codex.listThreads).toHaveBeenNthCalledWith(2, 100, "next-page");
    } finally {
      await rm(secondDirectory, { force: true, recursive: true });
    }
  });

  it("does not select a callback thread outside the workspace allowlist", async () => {
    codex.resumeThread.mockResolvedValue({ cwd: "/workspace/not-allowed" });

    await service.handleCallbackQuery(callbackQuery({ data: "thread:outside-thread" }));

    expect(state.getActiveThread("telegram", "42")).toBeNull();
    expect(api.callbackAnswers.at(-1)?.text).toBe("此任务已不可用。");
  });

  it("answers request_user_input from an exact one-time Telegram task card", async () => {
    let releaseInput!: () => void;
    const inputAnswered = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    codex.respondToUserInput.mockImplementation(() => releaseInput());
    codex.runTurn.mockImplementation(
      async (threadId: string, _text: string, _onDelta?: (text: string) => void) => {
        codex.emitUserInputRequest(userInputRequest(threadId));
        await inputAnswered;
        return {
          threadId,
          turnId: "new-turn",
          status: "completed" as const,
          finalMessage: "used the safe path",
          cwd: directory,
          durationMs: 1_250,
        };
      },
    );
    state.setActiveThread("telegram", "42", null, "active-thread");

    await service.handleMessage(message({ text: "continue" }));
    await vi.waitFor(() => expect(api.sent).toHaveLength(2));
    const questionCard = api.sent[1];
    const optionButton = questionCard?.inlineKeyboard?.[0]?.[0];
    if (!questionCard || !optionButton) throw new Error("Expected a Telegram input card");

    expect(questionCard.content).toContain("等待输入");
    expect(questionCard.format).toBe("plain_text");
    expect(optionButton.text).toBe("Safe");
    await service.handleCallbackQuery(
      callbackQuery({
        messageId: questionCard.messageId,
        data: optionButton.callbackData,
      }),
    );
    await service.drain();

    expect(codex.respondToUserInput).toHaveBeenCalledWith("request-1", {
      answers: { choice: { answers: ["Safe"] } },
    });
    expect(api.edits.some((edit) => edit.content.includes("已将输入发送给 Codex"))).toBe(true);
    expect(api.edits.at(-1)?.content).not.toContain("Reply to continue");
    expect(api.edits.at(-1)?.inlineKeyboard?.[0]?.map((button) => button.text)).toEqual([
      "切换到此任务",
      "停止此任务通知",
    ]);

    await service.handleCallbackQuery(
      callbackQuery({
        messageId: questionCard.messageId,
        data: optionButton.callbackData,
      }),
    );
    expect(api.callbackAnswers.at(-1)?.text).toBe("此输入请求已过期。");
  });

  it("accepts free-form input only as a reply to the exact request card", async () => {
    let releaseInput!: () => void;
    const inputAnswered = new Promise<void>((resolve) => {
      releaseInput = resolve;
    });
    codex.respondToUserInput.mockImplementation(() => releaseInput());
    codex.runTurn.mockImplementation(async (threadId: string) => {
      codex.emitUserInputRequest(freeformUserInputRequest(threadId));
      await inputAnswered;
      return {
        threadId,
        turnId: "new-turn",
        status: "completed" as const,
        finalMessage: "used the custom answer",
        cwd: directory,
        durationMs: 500,
      };
    });
    state.setActiveThread("telegram", "42", null, "active-thread");

    await service.handleMessage(message({ text: "continue" }));
    await vi.waitFor(() => expect(api.sent).toHaveLength(2));
    const questionCard = api.sent[1];
    if (!questionCard) throw new Error("Expected a Telegram input card");
    expect(questionCard.inlineKeyboard).toBeUndefined();

    await service.handleMessage(
      message({ replyToMessageId: questionCard.messageId, text: "Use the custom path" }),
    );
    await service.drain();

    expect(codex.respondToUserInput).toHaveBeenCalledWith("request-freeform", {
      answers: { details: { answers: ["Use the custom path"] } },
    });
    expect(codex.runTurn).toHaveBeenCalledOnce();
  });
});

function appState(projectRoots: readonly string[]): CodexAppUiState {
  return {
    projectRoots,
    projectOrder: projectRoots,
    projectlessThreadIds: new Set(),
    threadWorkspaceRootHints: new Map(),
    threadProjectAssignments: new Map(),
    deletedThreadIds: new Set(),
    threadDescriptions: new Map(),
  };
}

class FakeTelegramApi implements TelegramApi {
  readonly sent: Array<
    TelegramMessageRef & {
      content: string;
      format: "plain_text" | "rich_markdown";
      inlineKeyboard?: readonly (readonly TelegramInlineButton[])[];
    }
  > = [];
  readonly edits: Array<{
    ref: TelegramMessageRef;
    content: string;
    format: "plain_text" | "rich_markdown";
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[];
  }> = [];
  readonly callbackAnswers: Array<{ queryId: string; text?: string }> = [];
  readonly keyboardEdits: Array<{
    ref: TelegramMessageRef;
    inlineKeyboard: readonly (readonly TelegramInlineButton[])[];
  }> = [];

  async sendTextMessage(
    chatId: number,
    text: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef> {
    return this.recordSent(chatId, text, "plain_text", topicId, inlineKeyboard);
  }

  async sendRichMessage(
    chatId: number,
    markdown: string,
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<TelegramMessageRef> {
    return this.recordSent(chatId, markdown, "rich_markdown", topicId, inlineKeyboard);
  }

  async editTextMessage(
    ref: TelegramMessageRef,
    text: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void> {
    this.edits.push({
      ref,
      content: text,
      format: "plain_text",
      ...(inlineKeyboard ? { inlineKeyboard } : {}),
    });
  }

  async editRichMessage(
    ref: TelegramMessageRef,
    markdown: string,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void> {
    this.edits.push({
      ref,
      content: markdown,
      format: "rich_markdown",
      ...(inlineKeyboard ? { inlineKeyboard } : {}),
    });
  }

  async editMessageKeyboard(
    ref: TelegramMessageRef,
    inlineKeyboard: readonly (readonly TelegramInlineButton[])[],
  ): Promise<void> {
    this.keyboardEdits.push({ ref, inlineKeyboard });
  }

  private recordSent(
    chatId: number,
    content: string,
    format: "plain_text" | "rich_markdown",
    topicId?: string | null,
    inlineKeyboard?: readonly (readonly TelegramInlineButton[])[],
  ): TelegramMessageRef {
    const ref = {
      chatId,
      messageId: String(100 + this.sent.length),
      topicId: topicId ?? null,
      content,
      format,
      ...(inlineKeyboard ? { inlineKeyboard } : {}),
    };
    this.sent.push(ref);
    return ref;
  }

  async answerCallbackQuery(queryId: string, text?: string): Promise<void> {
    this.callbackAnswers.push({ queryId, ...(text ? { text } : {}) });
  }
}

type FakeCodexService = Omit<
  TelegramCodexService,
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
> & {
  listThreads: ReturnType<typeof vi.fn>;
  readThreadSnapshot: ReturnType<typeof vi.fn>;
  resumeThread: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
  respondToUserInput: ReturnType<typeof vi.fn>;
  rejectUserInput: ReturnType<typeof vi.fn>;
  emitUserInputRequest(request: UserInputRequest): void;
};

function createFakeCodex(): FakeCodexService {
  const userInputHandlers = new Set<(request: UserInputRequest) => void>();
  const resolvedHandlers = new Set<(request: ResolvedServerRequest) => void>();
  const completedHandlers = new Set<(turn: CompletedTurnRef) => void>();
  return {
    interruptThread: vi.fn(async () => false),
    onUserInputRequest: vi.fn((handler: (request: UserInputRequest) => void) => {
      userInputHandlers.add(handler);
      return () => userInputHandlers.delete(handler);
    }),
    onServerRequestResolved: vi.fn((handler: (request: ResolvedServerRequest) => void) => {
      resolvedHandlers.add(handler);
      return () => resolvedHandlers.delete(handler);
    }),
    onTurnCompleted: vi.fn((handler: (turn: CompletedTurnRef) => void) => {
      completedHandlers.add(handler);
      return () => completedHandlers.delete(handler);
    }),
    respondToUserInput: vi.fn(),
    rejectUserInput: vi.fn(),
    emitUserInputRequest(request: UserInputRequest) {
      for (const handler of userInputHandlers) handler(request);
    },
    resumeThread: vi.fn(async () => ({ cwd: directory })),
    listThreads: vi.fn(async () => ({ data: [], nextCursor: null, backwardsCursor: null })),
    readThreadSnapshot: vi.fn(async (threadId: string) => ({
      threadId,
      cwd: directory,
      latestTurn: {
        threadId,
        turnId: "existing-turn",
        status: "completed" as const,
        finalMessage: "existing answer",
        cwd: directory,
      },
      latestTerminalTurn: {
        threadId,
        turnId: "existing-turn",
        status: "completed" as const,
        finalMessage: "existing answer",
        cwd: directory,
      },
      latestTerminalTurnId: "existing-turn",
      blockedGoal: null,
    })),
    runTurn: vi.fn(async (threadId: string, _text: string, onDelta?: (text: string) => void) => {
      onDelta?.("partial");
      return {
        threadId,
        turnId: "new-turn",
        status: "completed" as const,
        finalMessage: "final answer",
        cwd: directory,
      };
    }),
    startThread: vi.fn(async () => ({ thread: { id: "created-thread" } })),
  } as unknown as FakeCodexService;
}

function userInputRequest(threadId: string): UserInputRequest {
  return {
    id: "request-1",
    method: "item/tool/requestUserInput",
    params: {
      threadId,
      turnId: "new-turn",
      itemId: "input-item",
      autoResolutionMs: null,
      questions: [
        {
          id: "choice",
          header: "Choose",
          question: "Which path should Codex use?",
          isOther: true,
          isSecret: false,
          options: [
            { label: "Safe", description: "Use the safer path." },
            { label: "Fast", description: "Use the faster path." },
          ],
        },
      ],
    },
  };
}

function freeformUserInputRequest(threadId: string): UserInputRequest {
  return {
    id: "request-freeform",
    method: "item/tool/requestUserInput",
    params: {
      threadId,
      turnId: "new-turn",
      itemId: "input-freeform",
      autoResolutionMs: null,
      questions: [
        {
          id: "details",
          header: "Details",
          question: "What should Codex use?",
          isOther: true,
          isSecret: false,
          options: null,
        },
      ],
    },
  };
}

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    messageId: "10",
    chatId: 42,
    chatType: "private",
    userId: 7,
    topicId: null,
    replyToMessageId: null,
    isForwarded: false,
    text: "hello",
    ...overrides,
  };
}

function callbackQuery(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
  return {
    queryId: "callback-1",
    chatId: 42,
    chatType: "private",
    userId: 7,
    topicId: null,
    messageId: "100",
    data: "thread:example-thread",
    ...overrides,
  };
}
