import { describe, expect, it } from "vitest";
import { renderCompletion, renderNotification, renderStreaming } from "../src/telegram/render.js";
import { prepareRichMarkdown } from "../src/telegram/rich-markdown.js";

describe("Telegram rendering", () => {
  it("preserves Codex Markdown in streaming output", () => {
    const rendered = renderStreaming("## Analysis\n\n- **Result**\n- `code`", false);
    expect(rendered).toContain("## Analysis");
    expect(rendered).toContain("- **Result**");
    expect(rendered).toContain("- `code`");
  });

  it("renders a bound task card with status, project, duration, and reply semantics", () => {
    const rendered = renderCompletion({
      threadId: "thread-123456",
      turnId: "turn-1",
      status: "completed",
      finalMessage: "Done.",
      cwd: "/workspace/financial",
      durationMs: 65_000,
    });

    expect(rendered).toContain("# ✅ Codex task");
    expect(rendered).toContain("- **Status:** Completed");
    expect(rendered).toContain("- **Project:** `financial`");
    expect(rendered).toContain("1m 5s");
    expect(rendered).toContain("continue the exact task");
  });

  it("preserves explicit notification Markdown for Rich Messages", () => {
    const rendered = renderNotification({
      id: "notification-1",
      idempotencyKey: "explicit:run-1",
      channel: "telegram",
      cwd: "/workspace/<private>",
      title: "Report <done>",
      message:
        "## 最终状态\n\n**完成**\n\n- [产物](https://example.com/report?a=1&b=2)\n- `QC`: 通过\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |",
      source: { kind: "notification_only" },
      state: "queued",
      attemptCount: 0,
      nextAttemptAt: 0,
      leaseExpiresAt: null,
      leaseToken: null,
      platformMessageId: null,
      lastError: null,
      createdAt: 0,
      updatedAt: 0,
    });

    expect(rendered).toContain("# 📬 Report \\<done\\>");
    expect(rendered).toContain("## 最终状态");
    expect(rendered).toContain("**完成**");
    expect(rendered).toContain("- [产物](https://example.com/report?a=1&b=2)");
    expect(rendered).toContain("- `QC`: 通过");
    expect(rendered).toContain("| 项目 | 结果 |");
    expect(rendered).not.toContain("<b>");
    expect(rendered).toContain("**Project:** `&lt;private&gt;`");
    expect(rendered).toContain("Notification only");
  });

  it("does not emit unsafe Markdown links", () => {
    const rendered = renderNotification(notificationFixture("[click](javascript:alert)"));
    expect(rendered).not.toContain("[click](javascript:alert)");
    expect(rendered).toContain("click (javascript:alert)");
  });

  it("renders quotes, ordered lists, emphasis, and fenced code", () => {
    const message = [
      "> *Important*",
      "",
      "1. ~~obsolete~~",
      "",
      "```ts",
      'const value = "<safe>";',
      "```",
    ].join("\n");
    const rendered = renderNotification(notificationFixture(message));

    expect(rendered).toContain("> *Important*");
    expect(rendered).toContain("1. ~~obsolete~~");
    expect(rendered).toContain('```ts\nconst value = "&lt;safe&gt;";\n```');
  });

  it("caps Rich Markdown and closes a truncated code fence", () => {
    const rendered = prepareRichMarkdown(
      `## Report\n\n\`\`\`ts\n${"const x = 1;\n".repeat(1_000)}`,
      1_000,
    );

    expect(rendered.length).toBeLessThanOrEqual(1_000);
    expect(rendered.endsWith("```"), rendered).toBe(true);
    expect(rendered).toContain("…");
  });

  it("escapes unsupported raw HTML tags before delivery", () => {
    const rendered = prepareRichMarkdown("<script>alert(1)</script> and <u>safe</u>");
    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("<u>safe</u>");
  });
});

function notificationFixture(message: string) {
  return {
    id: "notification-fixture",
    idempotencyKey: "explicit:fixture",
    channel: "telegram" as const,
    cwd: "/workspace/project",
    title: "Report",
    message,
    source: { kind: "notification_only" as const },
    state: "queued" as const,
    attemptCount: 0,
    nextAttemptAt: 0,
    leaseExpiresAt: null,
    leaseToken: null,
    platformMessageId: null,
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}
