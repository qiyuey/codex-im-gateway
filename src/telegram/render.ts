import { basename } from "node:path";
import type { CanonicalTurnResult, WatchedThreadSnapshot } from "../codex/app-server-client.js";
import type { ToolRequestUserInputQuestion } from "../codex/protocol/v2/ToolRequestUserInputQuestion.js";
import type { OutboundNotification } from "../core/types.js";
import {
  escapeRichMarkdownText,
  prepareRichMarkdown,
  richMarkdownInlineCode,
} from "./rich-markdown.js";
import type { TelegramInlineButton } from "./types.js";

export function renderCompletion(result: CanonicalTurnResult, title = "Codex task"): string {
  const icon = result.status === "completed" ? "✅" : result.status === "interrupted" ? "⏹" : "❌";
  const body = result.finalMessage.trim() || "No final agent message was returned.";
  const shortThread = result.threadId.slice(0, 8);
  const duration = formatDuration(result.durationMs);
  return prepareRichMarkdown(
    `# ${icon} ${escapeRichMarkdownText(title)}\n\n` +
      `- **Status:** ${escapeRichMarkdownText(statusLabel(result.status))}\n` +
      `- **Project:** ${richMarkdownInlineCode(projectLabel(result.cwd))}\n` +
      `- **Thread:** ${richMarkdownInlineCode(shortThread)}` +
      `${duration ? `\n- **Duration:** ${escapeRichMarkdownText(duration)}` : ""}\n\n` +
      `---\n\n${body}\n\n---\n\n` +
      `> ↩️ Reply to this message to continue the exact task.`,
  );
}

export function renderStreaming(text: string, done: boolean): string {
  const body = text.trim() || (done ? "No final agent message was returned." : "Codex is working…");
  return prepareRichMarkdown(`${done ? "✅" : "⏳"}\n\n${body}`);
}

export function renderNotification(notification: OutboundNotification): string {
  const source =
    notification.source.kind === "bound_task"
      ? "↩️ Reply to this message to continue the exact task."
      : "ℹ️ Notification only · replies do not continue a Codex task.";
  return prepareRichMarkdown(
    `# 📬 ${escapeRichMarkdownText(notification.title)}\n\n` +
      `${notification.message.trim()}\n\n---\n\n` +
      `**Project:** ${richMarkdownInlineCode(projectLabel(notification.cwd))}\n\n` +
      `> ${source}`,
  );
}

export function renderWatchedBlocked(snapshot: WatchedThreadSnapshot): string {
  const body =
    snapshot.latestTurn?.finalMessage.trim() ||
    snapshot.blockedGoal?.objective.trim() ||
    "The watched Codex task is blocked.";
  return prepareRichMarkdown(
    `# ⚠️ Watched Codex task\n\n` +
      `- **Status:** Blocked\n` +
      `- **Project:** ${richMarkdownInlineCode(projectLabel(snapshot.cwd))}\n` +
      `- **Thread:** ${richMarkdownInlineCode(snapshot.threadId.slice(0, 8))}\n\n` +
      `---\n\n${body}\n\n---\n\n` +
      `> ↩️ Reply to this message to continue the exact task.`,
  );
}

export function taskActionKeyboard(threadId: string): readonly (readonly TelegramInlineButton[])[] {
  return [
    [
      { text: "Continue", callbackData: `thread:${threadId}` },
      { text: "Mute", callbackData: `mute:${threadId}` },
    ],
  ];
}

export function renderUserInputQuestion(input: {
  readonly threadId: string;
  readonly cwd: string;
  readonly question: ToolRequestUserInputQuestion;
  readonly index: number;
  readonly total: number;
}): string {
  const options = input.question.options
    ?.map(
      (option, index) =>
        `${index + 1}. ${limitText(option.label, 120)} — ${limitText(option.description, 400)}`,
    )
    .join("\n");
  return (
    `🟡 Codex needs input\nStatus: Waiting for input\n` +
    `Project: ${limitText(projectLabel(input.cwd), 120)}\n` +
    `Thread: ${limitText(input.threadId.slice(0, 8), 100)}\n\n` +
    `${limitText(input.question.header, 120)} (${input.index + 1}/${input.total})\n` +
    `${limitText(input.question.question, 1_200)}` +
    `${options ? `\n\n${options}` : ""}\n\n` +
    `Choose an option, or reply to this message with a custom answer.`
  );
}

export function renderUserInputAnswered(
  question: ToolRequestUserInputQuestion,
  answer: string,
): string {
  return (
    `✅ Input sent to Codex\n\n` +
    `${limitText(question.header, 120)}\n` +
    `${limitText(question.question, 1_200)}\n\n` +
    `Answer: ${limitText(answer, 1_000)}`
  );
}

function statusLabel(status: CanonicalTurnResult["status"]): string {
  if (status === "completed") return "Completed";
  if (status === "interrupted") return "Stopped";
  if (status === "failed") return "Failed";
  return "Running";
}

function projectLabel(cwd: string): string {
  return basename(cwd) || cwd;
}

function formatDuration(durationMs: number | null | undefined): string | null {
  if (durationMs === null || durationMs === undefined || durationMs < 0) return null;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}m ${remainder}s` : `${minutes}m`;
}

function limitText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}
