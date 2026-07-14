import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompletedTurnRef,
  ResolvedServerRequest,
  UserInputRequest,
} from "../src/codex/app-server-client.js";
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

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "gateway-telegram-")));
  database = new GatewayDatabase(":memory:");
  state = new GatewayStateStore(database);
  api = new FakeTelegramApi();
  codex = createFakeCodex();
  config = {
    telegramBotToken: "test-token",
    telegramAllowedUserId: 7,
    telegramAllowedChatId: 42,
    allowedWorkspaces: [directory],
    dispatchIntervalMs: 100,
  };
  service = new TelegramService(config, api, state, codex as unknown as TelegramCodexService, 0);
});

afterEach(async () => {
  await service.drain();
  database.close();
  await rm(directory, { force: true, recursive: true });
});

describe("TelegramService", () => {
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
  });

  it("does not fall back from an unknown replied message", async () => {
    state.setActiveThread("telegram", "42", null, "active-thread");
    await service.handleMessage(message({ replyToMessageId: "missing" }));
    await service.drain();

    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.sent[0]?.content).toContain("not bound");
  });

  it("rejects a durable binding whose resumed workspace is not allowed", async () => {
    state.bindMessage("telegram", "42", "50", "outside-thread", "old-turn");
    codex.resumeThread.mockResolvedValue({ cwd: "/workspace/not-allowed" });
    await service.handleMessage(message({ replyToMessageId: "50" }));

    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.sent[0]?.content).toContain("workspace is not allowed");
  });

  it("creates and selects a workspace-scoped thread", async () => {
    await service.handleMessage(message({ text: "/new" }));
    expect(codex.startThread).toHaveBeenCalledWith(directory);
    expect(state.getActiveThread("telegram", "42")).toBe("created-thread");
    expect(state.getThreadWatch("telegram", "42")?.codexThreadId).toBe("created-thread");
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
    expect(state.getThreadWatch("telegram", "42")).toBeNull();

    await service.handleMessage(message({ text: "/use abcdef12" }));

    await service.handleMessage(message({ text: "/detach" }));
    expect(state.getActiveThread("telegram", "42")).toBeNull();
  });

  it("mutes the exact watched task from its status-card action", async () => {
    state.selectAndWatchThread("telegram", "42", null, "thread-1");

    await service.handleCallbackQuery(callbackQuery({ messageId: "200", data: "mute:thread-1" }));

    expect(state.getThreadWatch("telegram", "42")).toBeNull();
    expect(state.getActiveThread("telegram", "42")).toBe("thread-1");
    expect(api.callbackAnswers.at(-1)?.text).toBe("Task notifications muted.");
  });

  it("returns projects first, then their threads, and selects a thread", async () => {
    await mkdir(join(directory, ".git"));
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
      content: "Select a project:",
      format: "plain_text",
      topicId: "9",
    });
    expect(api.sent[0]?.inlineKeyboard).toHaveLength(2);
    expect(api.sent[0]?.inlineKeyboard?.[0]?.[0]).toMatchObject({
      text: expect.stringContaining("gateway-telegram-"),
      callbackData: expect.stringMatching(/^project:[A-Za-z0-9_-]{16}$/),
    });
    expect(api.sent[0]?.inlineKeyboard?.[1]?.[0]).toEqual({
      text: "📋 Tasks",
      callbackData: "project:none",
    });
    const projectCallback = api.sent[0]?.inlineKeyboard?.[0]?.[0]?.callbackData;
    if (!projectCallback) throw new Error("Expected a project callback");

    await service.handleCallbackQuery(callbackQuery({ data: projectCallback, topicId: "9" }));

    expect(api.sent[1]).toMatchObject({
      content: expect.stringContaining("Select a thread in"),
      format: "plain_text",
      topicId: "9",
      inlineKeyboard: [[{ text: "abcdef12 · Example", callbackData: "thread:abcdef12-full" }]],
    });

    await service.handleCallbackQuery(
      callbackQuery({ data: "thread:abcdef12-full", topicId: "9" }),
    );

    expect(codex.resumeThread).toHaveBeenCalledWith("abcdef12-full");
    expect(state.getActiveThread("telegram", "42", "9")).toBe("abcdef12-full");
    expect(api.callbackAnswers.at(-1)).toEqual({
      queryId: "callback-1",
      text: "Switched to and watching abcdef12.",
    });
    expect(state.getThreadWatch("telegram", "42", "9")?.codexThreadId).toBe("abcdef12-full");
  });

  it("groups allowed threads without a Git project under Tasks", async () => {
    codex.listThreads.mockResolvedValue({
      data: [{ id: "projectless-thread", cwd: directory, name: "Quick task", preview: "" }],
      nextCursor: null,
      backwardsCursor: null,
    });

    await service.handleMessage(message({ text: "/threads" }));

    expect(api.sent[0]?.inlineKeyboard).toEqual([
      [{ text: "📋 Tasks", callbackData: "project:none" }],
    ]);

    await service.handleCallbackQuery(callbackQuery({ data: "project:none" }));

    expect(api.sent[1]).toMatchObject({
      content: "Select a thread in Tasks:",
      format: "plain_text",
      inlineKeyboard: [
        [{ text: "projectl · Quick task", callbackData: "thread:projectless-thread" }],
      ],
    });
  });

  it("shows an empty Tasks group without sending an invalid empty keyboard", async () => {
    await mkdir(join(directory, ".git"));

    await service.handleCallbackQuery(callbackQuery({ data: "project:none" }));

    expect(api.sent[0]).toMatchObject({
      content: "No available threads in Tasks.",
      format: "plain_text",
    });
    expect(api.sent[0]?.inlineKeyboard).toBeUndefined();
  });

  it("shows projects from every configured allowed workspace", async () => {
    const secondDirectory = await realpath(await mkdtemp(join(tmpdir(), "gateway-financial-")));
    try {
      await Promise.all([mkdir(join(directory, ".git")), mkdir(join(secondDirectory, ".git"))]);
      config = { ...config, allowedWorkspaces: [directory, secondDirectory] };
      service = new TelegramService(
        config,
        api,
        state,
        codex as unknown as TelegramCodexService,
        0,
      );
      codex.listThreads.mockResolvedValue({
        data: [
          { id: "gateway-thread", cwd: directory, name: "Gateway", preview: "" },
          { id: "financial-thread", cwd: secondDirectory, name: "Financial", preview: "" },
        ],
        nextCursor: null,
        backwardsCursor: null,
      });

      await service.handleMessage(message({ text: "/threads" }));

      expect(api.sent[0]?.inlineKeyboard?.map((row) => row[0]?.text)).toEqual([
        expect.stringContaining("gateway-telegram-"),
        expect.stringContaining("gateway-financial-"),
        "📋 Tasks",
      ]);
    } finally {
      await rm(secondDirectory, { force: true, recursive: true });
    }
  });

  it("does not select a callback thread outside the workspace allowlist", async () => {
    codex.resumeThread.mockResolvedValue({ cwd: "/workspace/not-allowed" });

    await service.handleCallbackQuery(callbackQuery({ data: "thread:outside-thread" }));

    expect(state.getActiveThread("telegram", "42")).toBeNull();
    expect(api.callbackAnswers.at(-1)?.text).toBe("Thread is not available.");
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

    expect(questionCard.content).toContain("Waiting for input");
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
    expect(api.edits.some((edit) => edit.content.includes("Input sent to Codex"))).toBe(true);
    expect(api.edits.at(-1)?.content).toContain("Reply to this message to continue the exact task");
    expect(api.edits.at(-1)?.inlineKeyboard?.[0]?.map((button) => button.text)).toEqual([
      "Continue",
      "Mute",
    ]);

    await service.handleCallbackQuery(
      callbackQuery({
        messageId: questionCard.messageId,
        data: optionButton.callbackData,
      }),
    );
    expect(api.callbackAnswers.at(-1)?.text).toBe("This input request has expired.");
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
