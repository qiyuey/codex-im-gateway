import {
  type CompletionEventType,
  completionEventTypes,
  type EnqueueCompletionInput,
  type EnqueueNotificationInput,
} from "./types.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;
const MAX_NOTIFICATION_TITLE_LENGTH = 200;
const MAX_NOTIFICATION_MESSAGE_LENGTH = 12_000;

export function parseCompletionEventType(value: unknown): CompletionEventType {
  if (typeof value === "string" && completionEventTypes.includes(value as CompletionEventType)) {
    return value as CompletionEventType;
  }
  return "completed";
}

export function validateEnqueueInput(input: EnqueueCompletionInput): void {
  assertNonEmpty(input.idempotencyKey, "idempotencyKey", MAX_IDENTIFIER_LENGTH * 2);
  assertNonEmpty(input.codexThreadId, "codexThreadId", MAX_IDENTIFIER_LENGTH);
  assertNonEmpty(input.codexTurnId, "codexTurnId", MAX_IDENTIFIER_LENGTH);
  assertNonEmpty(input.cwd, "cwd", MAX_CWD_LENGTH);
}

export function validateNotificationInput(input: EnqueueNotificationInput): void {
  assertNonEmpty(input.idempotencyKey, "idempotencyKey", MAX_IDENTIFIER_LENGTH * 2);
  assertNonEmpty(input.cwd, "cwd", MAX_CWD_LENGTH);
  assertNonEmpty(input.title, "title", MAX_NOTIFICATION_TITLE_LENGTH);
  assertNonEmpty(input.message, "message", MAX_NOTIFICATION_MESSAGE_LENGTH);
  if (input.channel !== "telegram") throw new Error("Unsupported notification channel");
  if (input.source.kind !== "notification_only") {
    assertNonEmpty(input.source.codexThreadId, "source.codexThreadId", MAX_IDENTIFIER_LENGTH);
  }
  if (input.source.kind === "bound_task") {
    assertNonEmpty(input.source.codexTurnId, "source.codexTurnId", MAX_IDENTIFIER_LENGTH);
  }
}

function assertNonEmpty(value: string, name: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${name} must contain 1-${maxLength} safe characters`);
  }
}
