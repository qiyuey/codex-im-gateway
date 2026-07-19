import type { NotificationSource } from "../core/types.js";

const CODEX_TURN_METADATA_KEY = "x-codex-turn-metadata";
const MAX_IDENTIFIER_LENGTH = 256;

export function notificationSourceFromRequestMeta(
  meta: unknown,
  hostThreadId?: unknown,
): NotificationSource {
  const requestMeta = asRecord(meta);
  const turnMetadata = asRecord(requestMeta?.[CODEX_TURN_METADATA_KEY]);
  const topLevelThreadId = safeIdentifier(requestMeta?.threadId);
  const threadId = safeIdentifier(turnMetadata?.thread_id);
  const sessionId = safeIdentifier(turnMetadata?.session_id);
  const turnId = safeIdentifier(turnMetadata?.turn_id);

  if (
    topLevelThreadId !== null &&
    threadId !== null &&
    sessionId !== null &&
    turnId !== null &&
    topLevelThreadId === threadId &&
    threadId === sessionId
  ) {
    return {
      kind: "bound_task",
      codexThreadId: threadId,
      codexTurnId: turnId,
    };
  }

  const inheritedThreadId = safeIdentifier(hostThreadId);
  if (inheritedThreadId === null || hasConflictingIdentity(meta, inheritedThreadId)) {
    return { kind: "notification_only" };
  }
  return { kind: "bound_thread", codexThreadId: inheritedThreadId };
}

function hasConflictingIdentity(meta: unknown, inheritedThreadId: string): boolean {
  const requestMeta = asRecord(meta);
  const turnMetadata = asRecord(requestMeta?.[CODEX_TURN_METADATA_KEY]);
  const candidates = [
    requestMeta?.threadId,
    turnMetadata?.thread_id,
    turnMetadata?.session_id,
  ].filter((value) => value !== undefined);
  return candidates.some((value) => safeIdentifier(value) !== inheritedThreadId);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function safeIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value)
  ) {
    return null;
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}
