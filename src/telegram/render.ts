import type { CanonicalTurnResult } from "../codex/app-server-client.js";

const TELEGRAM_MESSAGE_LIMIT = 4_096;

export function escapeTelegramHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function renderCompletion(result: CanonicalTurnResult, title = "Codex task"): string {
  const icon = result.status === "completed" ? "✅" : result.status === "interrupted" ? "⏹" : "❌";
  const body = result.finalMessage.trim() || "No final agent message was returned.";
  const shortThread = result.threadId.slice(0, 8);
  return (
    `${icon} <b>${escapeAndLimit(title, 200)}</b>\n\n${escapeAndLimit(body, 3_000)}\n\n` +
    `<code>${escapeAndLimit(shortThread, 100)}</code> · ${escapeAndLimit(result.cwd, 500)}`
  );
}

export function renderStreaming(text: string, done: boolean): string {
  const body = text.trim() || (done ? "No final agent message was returned." : "Codex is working…");
  return `${done ? "✅" : "⏳"} ${escapeAndLimit(body, TELEGRAM_MESSAGE_LIMIT - 8)}`;
}

function escapeAndLimit(value: string, limit: number): string {
  const escaped = escapeTelegramHtml(value);
  if (escaped.length <= limit) return escaped;
  let truncated = escaped.slice(0, limit - 1);
  if (truncated.lastIndexOf("&") > truncated.lastIndexOf(";")) {
    truncated = truncated.slice(0, truncated.lastIndexOf("&"));
  }
  return `${truncated}…`;
}
