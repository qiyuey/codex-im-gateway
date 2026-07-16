import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { z } from "zod";
import type { GatewayLanguage } from "../core/i18n.js";

const environmentSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_ALLOWED_USER_ID: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  TELEGRAM_ALLOWED_CHAT_ID: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  CODEX_IM_ALLOWED_WORKSPACES: z.string().min(1),
  CODEX_IM_TASKS_WORKSPACE: z.string().min(1).optional(),
  CODEX_IM_DISPATCH_INTERVAL_MS: z.coerce.number().int().min(100).default(1_000),
  CODEX_IM_LANGUAGE: z.enum(["zh", "en"]).default("zh"),
});

export interface RuntimeConfig {
  readonly telegramBotToken: string;
  readonly telegramAllowedUserId: number;
  readonly telegramAllowedChatId: number;
  readonly allowedWorkspaces: readonly string[];
  readonly tasksWorkspace: string;
  readonly dispatchIntervalMs: number;
  readonly language: GatewayLanguage;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = environmentSchema.parse(env);
  if (parsed.TELEGRAM_ALLOWED_CHAT_ID !== parsed.TELEGRAM_ALLOWED_USER_ID) {
    throw new Error(
      "TELEGRAM_ALLOWED_CHAT_ID must equal TELEGRAM_ALLOWED_USER_ID for private-chat-only access",
    );
  }
  const allowedWorkspaces = parsed.CODEX_IM_ALLOWED_WORKSPACES.split(delimiter)
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(path));
  if (allowedWorkspaces.length === 0) throw new Error("At least one workspace must be allowed");
  return {
    telegramBotToken: parsed.TELEGRAM_BOT_TOKEN,
    telegramAllowedUserId: parsed.TELEGRAM_ALLOWED_USER_ID,
    telegramAllowedChatId: parsed.TELEGRAM_ALLOWED_CHAT_ID,
    allowedWorkspaces,
    tasksWorkspace: resolve(
      parsed.CODEX_IM_TASKS_WORKSPACE ?? join(homedir(), "Documents", "Codex"),
    ),
    dispatchIntervalMs: parsed.CODEX_IM_DISPATCH_INTERVAL_MS,
    language: parsed.CODEX_IM_LANGUAGE,
  };
}

export function authorizedWorkspaces(config: RuntimeConfig): readonly string[] {
  return [...new Set([...config.allowedWorkspaces, config.tasksWorkspace])];
}
