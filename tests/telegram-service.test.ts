import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "../src/config/runtime-config.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { GatewayStateStore } from "../src/storage/gateway-state-store.js";
import { type TelegramCodexService, TelegramService } from "../src/telegram/telegram-service.js";
import type { TelegramApi, TelegramMessage, TelegramMessageRef } from "../src/telegram/types.js";

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
    expect(api.edits.at(-1)?.html).toContain("final answer");
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
    expect(api.sent[0]?.html).toContain("not bound");
  });

  it("rejects a durable binding whose resumed workspace is not allowed", async () => {
    state.bindMessage("telegram", "42", "50", "outside-thread", "old-turn");
    codex.resumeThread.mockResolvedValue({ cwd: "/workspace/not-allowed" });
    await service.handleMessage(message({ replyToMessageId: "50" }));

    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(api.sent[0]?.html).toContain("workspace is not allowed");
  });

  it("creates and selects a workspace-scoped thread", async () => {
    await service.handleMessage(message({ text: "/new" }));
    expect(codex.startThread).toHaveBeenCalledWith(directory);
    expect(state.getActiveThread("telegram", "42")).toBe("created-thread");
  });

  it("selects an unambiguous allowed thread by short id and detaches it", async () => {
    codex.listThreads.mockResolvedValue({
      data: [{ id: "abcdef12-full", cwd: directory, name: "Example", preview: "Example" }],
      nextCursor: null,
      backwardsCursor: null,
    });
    await service.handleMessage(message({ text: "/use abcdef12" }));
    expect(state.getActiveThread("telegram", "42")).toBe("abcdef12-full");

    await service.handleMessage(message({ text: "/detach" }));
    expect(state.getActiveThread("telegram", "42")).toBeNull();
  });
});

class FakeTelegramApi implements TelegramApi {
  readonly sent: Array<TelegramMessageRef & { html: string }> = [];
  readonly edits: Array<{ ref: TelegramMessageRef; html: string }> = [];

  async sendMessage(
    chatId: number,
    html: string,
    topicId?: string | null,
  ): Promise<TelegramMessageRef> {
    const ref = {
      chatId,
      messageId: String(100 + this.sent.length),
      topicId: topicId ?? null,
      html,
    };
    this.sent.push(ref);
    return ref;
  }

  async editMessage(ref: TelegramMessageRef, html: string): Promise<void> {
    this.edits.push({ ref, html });
  }
}

type FakeCodexService = Omit<
  TelegramCodexService,
  "listThreads" | "resumeThread" | "runTurn" | "startThread"
> & {
  listThreads: ReturnType<typeof vi.fn>;
  resumeThread: ReturnType<typeof vi.fn>;
  runTurn: ReturnType<typeof vi.fn>;
  startThread: ReturnType<typeof vi.fn>;
};

function createFakeCodex(): FakeCodexService {
  return {
    interruptThread: vi.fn(async () => false),
    resumeThread: vi.fn(async () => ({ cwd: directory })),
    listThreads: vi.fn(async () => ({ data: [], nextCursor: null, backwardsCursor: null })),
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
