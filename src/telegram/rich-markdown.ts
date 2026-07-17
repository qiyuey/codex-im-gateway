import { isSafeRichMarkdownDestination, sanitizeRichHtmlTags } from "./rich-html-sanitizer.js";

const DEFAULT_RICH_MARKDOWN_LIMIT = 32_768;
const MAX_RICH_MARKDOWN_LINES = 450;
const RICH_MARKDOWN_LINK_PATTERN = /(!?)\[([^\]\n]+)]\(([^\s)]+)(?:\s+"[^"\n]*")?\)/g;

interface MarkdownFence {
  readonly marker: "`" | "~";
  readonly length: number;
  readonly opener: string;
}

export function prepareRichMarkdown(value: string, limit = DEFAULT_RICH_MARKDOWN_LIMIT): string {
  const normalized = normalizeRichMarkdown(value);
  if (!normalized) return "_No content._";

  const lines = normalized.split("\n");
  const lineLimited =
    lines.length > MAX_RICH_MARKDOWN_LINES
      ? `${lines.slice(0, MAX_RICH_MARKDOWN_LINES).join("\n").trimEnd()}\n\n…`
      : normalized;
  return fitAndCloseRichMarkdown(lineLimited, limit);
}

export function prepareRichMarkdownParts(
  value: string,
  limit = DEFAULT_RICH_MARKDOWN_LIMIT,
): readonly string[] {
  const normalized = normalizeRichMarkdown(value);
  if (!normalized) return ["_No content._"];
  if (limit < 8) throw new Error("Rich Markdown part limit must be at least 8 characters");

  const parts: string[] = [];
  let current: string[] = [];
  let fence: MarkdownFence | null = null;
  let reopenedFence = false;

  const flush = () => {
    if (!hasChunkContent(current, fence)) return;
    parts.push(renderChunk(current, fence));
    current = fence ? [fence.opener] : [];
    reopenedFence = fence !== null;
  };

  for (const sourceLine of normalized.split("\n")) {
    let remaining = sourceLine;
    let wholeLine = true;

    while (true) {
      if (
        wholeLine &&
        fence &&
        isClosingFence(remaining, fence) &&
        isOnlyReopenedFence(current, fence, reopenedFence)
      ) {
        current = [];
        fence = null;
        reopenedFence = false;
        break;
      }

      const nextFence: MarkdownFence | null = wholeLine ? transitionFence(fence, remaining) : fence;
      if (chunkFits([...current, remaining], nextFence, limit)) {
        current.push(remaining);
        fence = nextFence;
        break;
      }

      if (hasChunkContent(current, fence)) {
        const freshPart = fence ? [fence.opener] : [];
        if (!chunkFits([...freshPart, remaining], nextFence, limit)) {
          const prefixLength = largestFittingPrefix(current, remaining, fence, limit);
          if (prefixLength > 0) {
            const safeLength = avoidSplittingSurrogatePair(remaining, prefixLength);
            current.push(remaining.slice(0, safeLength));
            flush();
            remaining = remaining.slice(safeLength);
            wholeLine = false;
            continue;
          }
        }
        flush();
        continue;
      }

      const prefixLength = largestFittingPrefix(current, remaining, fence, limit);
      if (prefixLength <= 0) throw new Error("Unable to split Rich Markdown within the limit");
      const safeLength = avoidSplittingSurrogatePair(remaining, prefixLength);
      current.push(remaining.slice(0, safeLength));
      flush();
      remaining = remaining.slice(safeLength);
      wholeLine = false;
    }
  }

  flush();
  return parts.length > 0 ? parts : [fitAndCloseRichMarkdown(normalized, limit)];
}

export function escapeRichMarkdownText(value: string): string {
  return value.replaceAll("\\", "\\\\").replace(/([`*_{}[\]<>()#+\-.!|])/g, "\\$1");
}

export function richMarkdownInlineCode(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const fence = normalized.includes("`") ? "``" : "`";
  return `${fence}${normalized}${fence}`;
}

function closeOpenCodeFence(value: string): string {
  const fences = value.match(/^\s*(```+|~~~+)/gm) ?? [];
  if (fences.length % 2 === 0) return value;
  const marker = fences.at(-1)?.trim().startsWith("~") ? "~~~" : "```";
  return `${value}\n${marker}`;
}

function normalizeRichMarkdown(value: string): string {
  return sanitizeRichMarkdown(value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim());
}

function chunkFits(lines: readonly string[], fence: MarkdownFence | null, limit: number): boolean {
  const rendered = renderChunk(lines, fence);
  return rendered.length <= limit && rendered.split("\n").length <= MAX_RICH_MARKDOWN_LINES;
}

function renderChunk(lines: readonly string[], fence: MarkdownFence | null): string {
  return fence ? `${lines.join("\n")}\n${fence.marker.repeat(fence.length)}` : lines.join("\n");
}

function hasChunkContent(lines: readonly string[], fence: MarkdownFence | null): boolean {
  return lines.length > 0 && !(fence !== null && lines.length === 1 && lines[0] === fence.opener);
}

function isOnlyReopenedFence(
  lines: readonly string[],
  fence: MarkdownFence | null,
  reopenedFence: boolean,
): boolean {
  return reopenedFence && fence !== null && lines.length === 1 && lines[0] === fence.opener;
}

function transitionFence(fence: MarkdownFence | null, line: string): MarkdownFence | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const token = match?.[1];
  if (!token) return fence;
  const marker = token[0] as "`" | "~";
  if (!fence) return { marker, length: token.length, opener: line };
  return isClosingFence(line, fence) ? null : fence;
}

function isClosingFence(line: string, fence: MarkdownFence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  const token = match?.[1];
  return (
    token !== undefined &&
    token[0] === fence.marker &&
    token.length >= fence.length &&
    match?.[2]?.trim() === ""
  );
}

function largestFittingPrefix(
  current: readonly string[],
  line: string,
  fence: MarkdownFence | null,
  limit: number,
): number {
  let low = 0;
  let high = line.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (chunkFits([...current, line.slice(0, middle)], fence, limit)) low = middle;
    else high = middle - 1;
  }
  return low;
}

function avoidSplittingSurrogatePair(value: string, index: number): number {
  if (index <= 0 || index >= value.length) return index;
  const previous = value.charCodeAt(index - 1);
  const next = value.charCodeAt(index);
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? index - 1
    : index;
}

function fitAndCloseRichMarkdown(value: string, limit: number): string {
  const closed = closeOpenCodeFence(value);
  if (closed.length <= limit) return closed;

  let end = Math.max(0, limit - 4);
  while (end > 0) {
    const candidate = closeOpenCodeFence(`${value.slice(0, end).trimEnd()}\n\n…`);
    if (candidate.length <= limit) return candidate;
    end -= Math.max(1, candidate.length - limit);
  }
  return "…".slice(0, limit);
}

function sanitizeRichMarkdown(value: string): string {
  const safeLinks = value.replace(
    RICH_MARKDOWN_LINK_PATTERN,
    (match, marker: string, label: string, url: string) =>
      isSafeRichMarkdownDestination(url, marker === "!")
        ? match
        : `${label} (${escapeRichMarkdownText(url)})`,
  );
  return sanitizeRichHtmlTags(safeLinks);
}
