import { basename } from "node:path";
import type { CanonicalTurnResult, WatchedThreadSnapshot } from "../codex/app-server-client.js";
import type { ToolRequestUserInputQuestion } from "../codex/protocol/v2/ToolRequestUserInputQuestion.js";
import { type GatewayLanguage, translate } from "../core/i18n.js";
import type { NotificationSource, OutboundNotification } from "../core/types.js";
import {
  escapeRichMarkdownText,
  prepareRichMarkdown,
  prepareRichMarkdownParts,
  richMarkdownInlineCode,
} from "./rich-markdown.js";
import type { TelegramInlineButton } from "./types.js";

export const THREAD_PICKER_CALLBACK_DATA = "threads";
export const TASK_SWITCH_CALLBACK_PREFIX = "switch:";

const CODEX_APP_ONLY_DIRECTIVES = new Set([
  "created-thread",
  "git-stage",
  "git-commit",
  "git-create-branch",
  "git-push",
  "git-create-pr",
]);

export function renderCompletion(
  result: CanonicalTurnResult,
  language: GatewayLanguage,
  projectOverride?: string,
): string {
  return renderCompletionParts(result, language, projectOverride)[0] ?? "";
}

export function renderCompletionParts(
  result: CanonicalTurnResult,
  language: GatewayLanguage,
  projectOverride?: string,
): readonly string[] {
  const icon = result.status === "completed" ? "✅" : result.status === "interrupted" ? "⏹" : "❌";
  const body =
    stripTrailingCodexAppDirectives(result.finalMessage) || translate(language, "noFinalMessage");
  const shortThread = result.threadId.slice(0, 8);
  const duration = formatDuration(result.durationMs);
  const heading = [projectOverride ?? projectLabel(result.cwd), shortThread, duration]
    .filter((value): value is string => Boolean(value))
    .map(escapeRichMarkdownText)
    .join(" · ");
  return prepareRichMarkdownParts(`# ${icon} ${heading}\n\n${body}`);
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
  return renderNotificationParts(notification, language)[0] ?? "";
}

export function renderNotificationParts(
  notification: OutboundNotification,
  language: GatewayLanguage,
): readonly string[] {
  const source =
    notification.source.kind === "notification_only"
      ? `\n\n> ℹ️ ${translate(language, "notificationOnly")}`
      : "";
  return prepareRichMarkdownParts(
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
  return renderWatchedBlockedParts(snapshot, language, projectOverride)[0] ?? "";
}

export function renderWatchedBlockedParts(
  snapshot: WatchedThreadSnapshot,
  language: GatewayLanguage,
  projectOverride?: string,
): readonly string[] {
  const body =
    snapshot.latestTurn?.finalMessage.trim() ||
    snapshot.blockedGoal?.objective.trim() ||
    translate(language, "watchedTaskBlocked");
  return prepareRichMarkdownParts(
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

function projectLabel(cwd: string): string {
  return basename(cwd) || cwd;
}

function stripTrailingCodexAppDirectives(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const inFence = fencedCodeLines(lines);
  let end = lines.length - 1;

  while (end >= 0 && lines[end]?.trim() === "") end -= 1;

  let removed = false;
  while (end >= 0 && !inFence[end] && isCodexAppOnlyDirective(lines[end] ?? "")) {
    removed = true;
    end -= 1;
    while (end >= 0 && lines[end]?.trim() === "") end -= 1;
  }

  return (removed ? lines.slice(0, end + 1).join("\n") : value).trim();
}

function isCodexAppOnlyDirective(line: string): boolean {
  const match = /^::([a-z][a-z0-9-]*)\{.*\}[ \t]*$/.exec(line);
  return match?.[1] !== undefined && CODEX_APP_ONLY_DIRECTIVES.has(match[1]);
}

function fencedCodeLines(lines: readonly string[]): boolean[] {
  const result: boolean[] = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    result[index] = fence !== null;
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const token = match?.[1];
    if (!token) continue;

    const marker = token[0] as "`" | "~";
    if (!fence) {
      fence = { marker, length: token.length };
      continue;
    }
    if (marker === fence.marker && token.length >= fence.length && match?.[2]?.trim() === "") {
      fence = null;
    }
  }

  return result;
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
