import { delimiter, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexChatsWorkspace } from "../src/codex/chats-workspace.js";
import { authorizedWorkspaces, loadRuntimeConfig } from "../src/config/runtime-config.js";

describe("loadRuntimeConfig", () => {
  it("parses identities, workspaces, and polling interval", () => {
    const config = loadRuntimeConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_ID: "7",
      TELEGRAM_ALLOWED_CHAT_ID: "7",
      CODEX_IM_ALLOWED_WORKSPACES: [`./one`, `./two`].join(delimiter),
      CODEX_IM_DISPATCH_INTERVAL_MS: "250",
    });
    expect(config).toEqual({
      telegramBotToken: "secret",
      telegramAllowedUserId: 7,
      telegramAllowedChatId: 7,
      allowedWorkspaces: [resolve("./one"), resolve("./two")],
      dispatchIntervalMs: 250,
      language: "zh",
    });
  });

  it("uses the Codex-managed Chats workspace without exposing configuration", () => {
    expect(resolveCodexChatsWorkspace("/Users/example")).toBe("/Users/example/Documents/Codex");

    const config = loadRuntimeConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_ID: "7",
      TELEGRAM_ALLOWED_CHAT_ID: "7",
      CODEX_IM_ALLOWED_WORKSPACES: "./one",
      CODEX_IM_CHATS_WORKSPACE: "./override",
      CODEX_IM_TASKS_WORKSPACE: "./legacy-override",
    });

    expect(config).not.toHaveProperty("chatsWorkspace");
    expect(authorizedWorkspaces(config)).toContain(resolveCodexChatsWorkspace());
    expect(authorizedWorkspaces(config)).not.toContain(resolve("./override"));
    expect(authorizedWorkspaces(config)).not.toContain(resolve("./legacy-override"));
  });

  it("supports English mode", () => {
    const config = loadRuntimeConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_ID: "7",
      TELEGRAM_ALLOWED_CHAT_ID: "7",
      CODEX_IM_ALLOWED_WORKSPACES: "./one",
      CODEX_IM_LANGUAGE: "en",
    });

    expect(config.language).toBe("en");
  });

  it("rejects unsupported languages", () => {
    expect(() =>
      loadRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_ID: "7",
        TELEGRAM_ALLOWED_CHAT_ID: "7",
        CODEX_IM_ALLOWED_WORKSPACES: "./one",
        CODEX_IM_LANGUAGE: "fr",
      }),
    ).toThrow();
  });

  it("rejects missing credentials", () => {
    expect(() => loadRuntimeConfig({})).toThrow();
  });

  it("rejects a chat ID that does not match the sole allowed private user", () => {
    expect(() =>
      loadRuntimeConfig({
        TELEGRAM_BOT_TOKEN: "secret",
        TELEGRAM_ALLOWED_USER_ID: "7",
        TELEGRAM_ALLOWED_CHAT_ID: "42",
        CODEX_IM_ALLOWED_WORKSPACES: "./one",
      }),
    ).toThrow("TELEGRAM_ALLOWED_CHAT_ID must equal TELEGRAM_ALLOWED_USER_ID");
  });
});
