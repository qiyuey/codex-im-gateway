import {
  type CompletionEventType,
  completionEventTypes,
  type EnqueueCompletionInput,
} from "./types.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CWD_LENGTH = 4096;

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

function assertNonEmpty(value: string, name: string, maxLength: number): void {
  if (value.length === 0 || value.length > maxLength || value.includes("\0")) {
    throw new Error(`${name} must contain 1-${maxLength} safe characters`);
  }
}
