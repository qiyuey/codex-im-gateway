import { basename } from "node:path";
import type { CanonicalTurnResult, WatchedThreadSnapshot } from "../codex/app-server-client.js";
import type { ToolRequestUserInputQuestion } from "../codex/protocol/v2/ToolRequestUserInputQuestion.js";
import { type GatewayLanguage, translate } from "../core/i18n.js";
import type { NotificationSource, OutboundNotification } from "../core/types.js";
import {
  escapeRichMarkdownText,
  prepareRichMarkdown,
  richMarkdownInlineCode,
} from "./rich-markdown.js";
import type { TelegramInlineButton } from "./types.js";

export const THREAD_PICKER_CALLBACK_DATA = "threads";
export const TASK_SWITCH_CALLBACK_PREFIX = "switch:";

export function renderCompletion(
  result: CanonicalTurnResult,
  language: GatewayLanguage,
  projectOverride?: string,
): string {
  const icon = result.status === "completed" ? "✅" : result.status === "interrupted" ? "⏹" : "❌";
  const body = result.finalMessage.trim() || translate(language, "noFinalMessage");
  const shortThread = result.threadId.slice(0, 8);
  const duration = formatDuration(result.durationMs);
  const context =
    `**${translate(language, "project")}:** ${richMarkdownInlineCode(projectOverride ?? projectLabel(result.cwd))} · ` +
    `**${translate(language, "thread")}:** ${richMarkdownInlineCode(shortThread)}` +
    `${duration ? ` · **${translate(language, "duration")}:** ${escapeRichMarkdownText(duration)}` : ""}`;
  const heading = translate(language, "taskStatus", {
    task: translate(language, "task"),
    status: statusHeading(result.status, language),
  });
  return prepareRichMarkdown(
    `# ${icon} ${escapeRichMarkdownText(heading)}\n\n` + `${body}\n\n---\n\n${context}`,
  );
}

export function renderStreaming(text: string, done: boolean, language: GatewayLanguage): string {
  const body =
    text.trim() ||
    (done ? translate(language, "noFinalMessage") : translate(language, "codexWorking"));
  return prepareRichMarkdown(`${done ? "✅" : "⏳"}\n\n${body}`);
}

export function renderNotification(
  notification: OutboundNotification,
  language: GatewayLanguage,
): string {
  const source =
    notification.source.kind === "notification_only"
      ? `\n\n> ℹ️ ${translate(language, "notificationOnly")}`
      : "";
  return prepareRichMarkdown(
    `# 📬 ${escapeRichMarkdownText(notification.title)}\n\n` +
      `${notification.message.trim()}\n\n---\n\n` +
      `**${translate(language, "project")}:** ${richMarkdownInlineCode(projectLabel(notification.cwd))}` +
      source,
  );
}

export function notificationActionKeyboard(
  source: NotificationSource,
  language: GatewayLanguage,
): readonly (readonly TelegramInlineButton[])[] {
  return source.kind === "bound_task"
    ? [taskSwitchButtonRow(source.codexThreadId, language)]
    : [[{ text: translate(language, "chooseTask"), callbackData: THREAD_PICKER_CALLBACK_DATA }]];
}

export function renderWatchedBlocked(
  snapshot: WatchedThreadSnapshot,
  language: GatewayLanguage,
  projectOverride?: string,
): string {
  const body =
    snapshot.latestTurn?.finalMessage.trim() ||
    snapshot.blockedGoal?.objective.trim() ||
    translate(language, "watchedTaskBlocked");
  return prepareRichMarkdown(
    `# ⚠️ ${translate(language, "statusBlocked")}\n\n` +
      `${body}\n\n---\n\n` +
      `**${translate(language, "project")}:** ${richMarkdownInlineCode(projectOverride ?? projectLabel(snapshot.cwd))} · ` +
      `**${translate(language, "thread")}:** ${richMarkdownInlineCode(snapshot.threadId.slice(0, 8))}`,
  );
}

export function taskActionKeyboard(
  threadId: string,
  language: GatewayLanguage,
): readonly (readonly TelegramInlineButton[])[] {
  return [
    [
      ...taskSwitchButtonRow(threadId, language),
      { text: translate(language, "stopNotifications"), callbackData: `mute:${threadId}` },
    ],
  ];
}

export function taskSwitchKeyboard(
  threadId: string,
  language: GatewayLanguage,
): readonly (readonly TelegramInlineButton[])[] {
  return [taskSwitchButtonRow(threadId, language)];
}

function taskSwitchButtonRow(
  threadId: string,
  language: GatewayLanguage,
): readonly TelegramInlineButton[] {
  return [
    {
      text: translate(language, "switchTask"),
      callbackData: `${TASK_SWITCH_CALLBACK_PREFIX}${threadId}`,
    },
  ];
}

export function renderUserInputQuestion(input: {
  readonly threadId: string;
  readonly cwd: string;
  readonly question: ToolRequestUserInputQuestion;
  readonly index: number;
  readonly total: number;
  readonly language: GatewayLanguage;
}): string {
  const options = input.question.options
    ?.map(
      (option, index) =>
        `${index + 1}. ${limitText(option.label, 120)} — ${limitText(option.description, 400)}`,
    )
    .join("\n");
  return (
    `${translate(input.language, "codexNeedsInput")}\n${translate(input.language, "statusWaitingInput")}\n` +
    `${translate(input.language, "project")}: ${limitText(projectLabel(input.cwd), 120)}\n` +
    `${translate(input.language, "thread")}: ${limitText(input.threadId.slice(0, 8), 100)}\n\n` +
    `${limitText(input.question.header, 120)} (${input.index + 1}/${input.total})\n` +
    `${limitText(input.question.question, 1_200)}` +
    `${options ? `\n\n${options}` : ""}\n\n` +
    translate(input.language, "chooseOption")
  );
}

export function renderUserInputAnswered(
  question: ToolRequestUserInputQuestion,
  answer: string,
  language: GatewayLanguage,
): string {
  return (
    `${translate(language, "inputSent")}\n\n` +
    `${limitText(question.header, 120)}\n` +
    `${limitText(question.question, 1_200)}\n\n` +
    `${translate(language, "answer")}: ${limitText(answer, 1_000)}`
  );
}

function statusHeading(status: CanonicalTurnResult["status"], language: GatewayLanguage): string {
  if (status === "completed") return translate(language, "statusCompleted");
  if (status === "interrupted") return translate(language, "statusInterrupted");
  if (status === "failed") return translate(language, "statusFailed");
  return translate(language, "statusRunning");
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
