const DEFAULT_RICH_MARKDOWN_LIMIT = 32_000;
const MAX_RICH_MARKDOWN_LINES = 450;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:", "tg:"]);
const RICH_HTML_TAGS = new Set([
  "a",
  "aside",
  "b",
  "blockquote",
  "caption",
  "cite",
  "code",
  "del",
  "details",
  "em",
  "figcaption",
  "figure",
  "i",
  "ins",
  "mark",
  "pre",
  "s",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "td",
  "tg-emoji",
  "tg-reference",
  "tg-spoiler",
  "th",
  "tr",
  "u",
]);

export function prepareRichMarkdown(value: string, limit = DEFAULT_RICH_MARKDOWN_LIMIT): string {
  const normalized = sanitizeRichMarkdown(
    value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim(),
  );
  if (!normalized) return "_No content._";

  const lines = normalized.split("\n");
  const lineLimited =
    lines.length > MAX_RICH_MARKDOWN_LINES
      ? `${lines.slice(0, MAX_RICH_MARKDOWN_LINES).join("\n").trimEnd()}\n\n…`
      : normalized;
  return fitAndCloseRichMarkdown(lineLimited, limit);
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
    /\[([^\]\n]+)]\(([^\s)]+)\)/g,
    (match, label: string, url: string) =>
      isSafeLink(url) ? match : `${label} (${escapeRichMarkdownText(url)})`,
  );
  return safeLinks.replace(/<\/?([A-Za-z][\w-]*)(?:\s[^<>]*)?>/g, (tag, name: string) =>
    RICH_HTML_TAGS.has(name.toLowerCase())
      ? tag
      : tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  );
}

function isSafeLink(value: string): boolean {
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}
