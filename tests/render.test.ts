import { describe, expect, it } from "vitest";
import { escapeTelegramHtml, renderCompletion, renderStreaming } from "../src/telegram/render.js";

describe("Telegram rendering", () => {
  it("strictly escapes Telegram HTML", () => {
    expect(escapeTelegramHtml('<script>& "safe"')).toBe('&lt;script&gt;&amp; "safe"');
    expect(
      renderCompletion({
        threadId: "thread",
        turnId: "turn",
        status: "completed",
        finalMessage: "<b>untrusted</b>",
        cwd: "/tmp/<secret>",
      }),
    ).not.toContain("<b>untrusted</b>");
  });

  it("caps streaming messages without cutting an HTML entity", () => {
    const rendered = renderStreaming("&".repeat(10_000), false);
    expect(rendered.length).toBeLessThanOrEqual(4_096);
    expect(rendered.endsWith("&…")).toBe(false);
  });
});
