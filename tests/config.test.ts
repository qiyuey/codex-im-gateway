import { delimiter, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";

describe("loadRuntimeConfig", () => {
  it("parses identities, workspaces, and polling interval", () => {
    const config = loadRuntimeConfig({
      TELEGRAM_BOT_TOKEN: "secret",
      TELEGRAM_ALLOWED_USER_ID: "7",
      TELEGRAM_ALLOWED_CHAT_ID: "42",
      CODEX_IM_GATEWAY_ALLOWED_WORKSPACES: [`./one`, `./two`].join(delimiter),
      CODEX_IM_GATEWAY_DISPATCH_INTERVAL_MS: "250",
    });
    expect(config).toEqual({
      telegramBotToken: "secret",
      telegramAllowedUserId: 7,
      telegramAllowedChatId: 42,
      allowedWorkspaces: [resolve("./one"), resolve("./two")],
      dispatchIntervalMs: 250,
    });
  });

  it("rejects missing credentials", () => {
    expect(() => loadRuntimeConfig({})).toThrow();
  });
});
