import { describe, expect, it } from "vitest";
import {
  renderCompletion,
  renderNotification,
  renderStreaming,
  taskActionKeyboard,
} from "../src/telegram/render.js";
import { prepareRichMarkdown } from "../src/telegram/rich-markdown.js";

describe("Telegram rendering", () => {
  it("preserves Codex Markdown in streaming output", () => {
    const rendered = renderStreaming("## Analysis\n\n- **Result**\n- `code`", false, "en");
    expect(rendered).toContain("## Analysis");
    expect(rendered).toContain("- **Result**");
    expect(rendered).toContain("- `code`");
  });

  it("renders a bound task card with the outcome first and compact context", () => {
    const rendered = renderCompletion(
      {
        threadId: "thread-123456",
        turnId: "turn-1",
        status: "completed",
        finalMessage: "Done.",
        cwd: "/workspace/financial",
        durationMs: 65_000,
      },
      "en",
    );

    expect(rendered).toContain("# ✅ Task completed");
    expect(rendered).toContain(
      "**Project:** `financial` · **Thread:** `thread-1` · **Duration:** 1m 5s",
    );
    expect(rendered).not.toContain("Reply to continue");
    expect(rendered.indexOf("Done.")).toBeLessThan(rendered.indexOf("**Project:**"));
  });

  it("labels projectless task cards as Tasks and keeps reusable task actions", () => {
    const rendered = renderCompletion(
      {
        threadId: "thread-123456",
        turnId: "turn-1",
        status: "completed",
        finalMessage: "Done.",
        cwd: "/Users/example/Documents/Codex",
        durationMs: null,
      },
      "en",
      "Tasks",
    );

    expect(rendered).toContain("**Project:** `Tasks`");
    expect(taskActionKeyboard("thread-123456", "en")).toEqual([
      [
        { text: "Switch to this task", callbackData: "switch:thread-123456" },
        { text: "Mute this task", callbackData: "mute:thread-123456" },
      ],
    ]);
  });

  it("preserves explicit notification Markdown for Rich Messages", () => {
    const rendered = renderNotification(
      {
        id: "notification-1",
        idempotencyKey: "explicit:run-1",
        channel: "telegram",
        cwd: "/workspace/<private>",
        title: "Report <done>",
        message:
          "## 最终状态\n\n**完成**\n\n- [产物](https://example.com/report?a=1&b=2)\n- `QC`: 通过\n\n| 项目 | 结果 |\n| --- | --- |\n| 测试 | 通过 |",
        source: { kind: "notification_only" },
        ingress: { producer: "internal", producerVersion: "0.1.0", protocolVersion: 1 },
        state: "queued",
        attemptCount: 0,
        nextAttemptAt: 0,
        leaseExpiresAt: null,
        leaseToken: null,
        platformMessageId: null,
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
      },
      "zh",
    );

    expect(rendered).toContain("# 📬 Report \\<done\\>");
    expect(rendered).toContain("## 最终状态");
    expect(rendered).toContain("**完成**");
    expect(rendered).toContain("- [产物](https://example.com/report?a=1&b=2)");
    expect(rendered).toContain("- `QC`: 通过");
    expect(rendered).toContain("| 项目 | 结果 |");
    expect(rendered).not.toContain("<b>");
    expect(rendered).toContain("**项目:** `&lt;private&gt;`");
    expect(rendered).toContain("这是一条独立通知");
    expect(rendered).toContain("请点击下方“选择任务”，再发送一条新消息");
  });

  it("does not emit unsafe Markdown links", () => {
    const rendered = renderNotification(notificationFixture("[click](javascript:alert)"), "en");
    expect(rendered).not.toContain("[click](javascript:alert)");
    expect(rendered).toContain("click (javascript:alert)");
  });

  it("preserves official Rich Markdown links, media entities, and in-document anchors", () => {
    const rendered = prepareRichMarkdown(
      [
        '<a name="chapter-1"></a>',
        "[anchor](#chapter-1)",
        "[web](https://telegram.org/)",
        "[mail](mailto:user@example.com)",
        "[phone](tel:+123456789)",
        "[mention](tg://user?id=123456789)",
        "![emoji](tg://emoji?id=5368324170671202286)",
        "![time](tg://time?unix=1784044800&format=wDT)",
        '![media](https://telegram.org/example/photo.jpg "caption")',
      ].join("\n"),
    );

    expect(rendered).toContain('<a name="chapter-1"></a>');
    expect(rendered).toContain("[anchor](#chapter-1)");
    expect(rendered).toContain("[web](https://telegram.org/)");
    expect(rendered).toContain("[mail](mailto:user@example.com)");
    expect(rendered).toContain("[phone](tel:+123456789)");
    expect(rendered).toContain("[mention](tg://user?id=123456789)");
    expect(rendered).toContain("![emoji](tg://emoji?id=5368324170671202286)");
    expect(rendered).toContain("![time](tg://time?unix=1784044800&format=wDT)");
    expect(rendered).toContain('![media](https://telegram.org/example/photo.jpg "caption")');
  });

  it("preserves the complete official Rich HTML formatting vocabulary", () => {
    const rendered = prepareRichMarkdown(
      [
        "<h1>Heading</h1><p>Paragraph<br/>next</p><footer>Footer</footer><hr/>",
        "<b>b</b><strong>strong</strong><i>i</i><em>em</em><u>u</u><ins>ins</ins>",
        "<s>s</s><strike>strike</strike><del>del</del><code>code</code><mark>mark</mark>",
        "<sub>sub</sub><sup>sup</sup><tg-spoiler>spoiler</tg-spoiler>",
        '<pre><code class="language-python">print(1)</code></pre>',
        '<tg-reference name="note-1">note</tg-reference>',
        '<tg-emoji emoji-id="5368324170671202286">👍</tg-emoji>',
        '<tg-time unix="1784044800" format="wDT">time</tg-time>',
        "<tg-math>x^2</tg-math><tg-math-block>E=mc^2</tg-math-block>",
        '<ol start="3" type="a" reversed><li value="7" type="i">item</li></ol>',
        '<ul><li><input type="checkbox" checked/>done</li></ul>',
        "<blockquote>quote<cite>author</cite></blockquote>",
        "<aside>pull<cite>author</cite></aside>",
        "<details open><summary>title</summary><p>body</p></details>",
      ].join("\n"),
    );

    expect(rendered).toContain("<h1>Heading</h1><p>Paragraph<br/>next</p>");
    expect(rendered).toContain('<code class="language-python">');
    expect(rendered).toContain('<tg-reference name="note-1">');
    expect(rendered).toContain('<tg-emoji emoji-id="5368324170671202286">');
    expect(rendered).toContain('<tg-time unix="1784044800" format="wDT">');
    expect(rendered).toContain("<tg-math>x^2</tg-math>");
    expect(rendered).toContain('<ol start="3" type="a" reversed>');
    expect(rendered).toContain('<input type="checkbox" checked/>');
    expect(rendered).toContain("<blockquote>quote<cite>author</cite></blockquote>");
    expect(rendered).toContain("<aside>pull<cite>author</cite></aside>");
    expect(rendered).toContain("<details open><summary>title</summary>");
  });

  it("preserves official Rich HTML media, map, gallery, and table attributes", () => {
    const rendered = prepareRichMarkdown(
      [
        '<figure><img src="https://telegram.org/photo.jpg" tg-spoiler/><figcaption>Photo<cite>Credit</cite></figcaption></figure>',
        '<video src="https://telegram.org/video.mp4" tg-spoiler></video>',
        '<audio src="https://telegram.org/audio.mp3"></audio>',
        '<img src="tg://emoji?id=5368324170671202286" alt="👍"/>',
        '<tg-map lat="41.9" long="12.5" zoom="14"/>',
        '<tg-collage><img src="https://telegram.org/a.jpg"/><video src="https://telegram.org/a.mp4"></video></tg-collage>',
        '<tg-slideshow><img src="https://telegram.org/b.jpg"/><figcaption>Slides</figcaption></tg-slideshow>',
        '<table bordered striped><caption>Metrics</caption><tr><td colspan="2" rowspan="2" align="left" valign="top">A</td></tr></table>',
      ].join("\n"),
    );

    expect(rendered).toContain('<img src="https://telegram.org/photo.jpg" tg-spoiler/>');
    expect(rendered).toContain('<video src="https://telegram.org/video.mp4" tg-spoiler>');
    expect(rendered).toContain('<audio src="https://telegram.org/audio.mp3">');
    expect(rendered).toContain('<img src="tg://emoji?id=5368324170671202286" alt="👍"/>');
    expect(rendered).toContain('<tg-map lat="41.9" long="12.5" zoom="14"/>');
    expect(rendered).toContain("<tg-collage>");
    expect(rendered).toContain("<tg-slideshow>");
    expect(rendered).toContain("<table bordered striped>");
    expect(rendered).toContain('<td colspan="2" rowspan="2" align="left" valign="top">');
  });

  it("rejects unsafe or out-of-contract Rich HTML attributes and entities", () => {
    const rendered = prepareRichMarkdown(
      [
        '<a href="javascript:alert(1)">unsafe</a>',
        '<img src="file:///private/data"/>',
        '<video src="https://telegram.org/v.mp4" onload="steal()"></video>',
        '<tg-map lat="91" long="12.5" zoom="14"/>',
        '<tg-time unix="1784044800" format="invalid">time</tg-time>',
        '<table style="color:red"><tr><td>A</td></tr></table>',
        "unsupported &copy; entity",
      ].join("\n"),
    );

    expect(rendered).toContain('&lt;a href="javascript:alert(1)"&gt;unsafe&lt;/a&gt;');
    expect(rendered).toContain('&lt;img src="file:///private/data"/&gt;');
    expect(rendered).toContain('&lt;video src="https://telegram.org/v.mp4" onload="steal()"&gt;');
    expect(rendered).toContain('&lt;tg-map lat="91" long="12.5" zoom="14"/&gt;');
    expect(rendered).toContain(
      '&lt;tg-time unix="1784044800" format="invalid"&gt;time&lt;/tg-time&gt;',
    );
    expect(rendered).toContain('&lt;table style="color:red"&gt;');
    expect(rendered).toContain("unsupported &amp;copy; entity");
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
    const rendered = renderNotification(notificationFixture(message), "en");

    expect(rendered).toContain("> *Important*");
    expect(rendered).toContain("1. ~~obsolete~~");
    expect(rendered).toContain('```ts\nconst value = "&lt;safe&gt;";\n```');
  });

  it("renders the same task card in Chinese mode", () => {
    const rendered = renderCompletion(
      {
        threadId: "thread-123456",
        turnId: "turn-1",
        status: "completed",
        finalMessage: "完成。",
        cwd: "/workspace/financial",
        durationMs: 65_000,
      },
      "zh",
    );

    expect(rendered).toContain("# ✅ 任务已完成");
    expect(rendered).toContain("**项目:** `financial` · **任务:** `thread-1` · **耗时:** 1m 5s");
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
    ingress: { producer: "internal" as const, producerVersion: "0.1.0", protocolVersion: 1 },
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
