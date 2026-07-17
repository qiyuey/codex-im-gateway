import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/router/router.js";

describe("routeMessage", () => {
  it("uses a reply binding before topic, explicit, and active selections", () => {
    expect(
      routeMessage({
        replyToMessageId: "10",
        replyBinding: { codexThreadId: "reply", codexTurnId: "turn" },
        topicBinding: { codexThreadId: "topic", codexTurnId: null },
        explicitThreadId: "explicit",
        activeThreadId: "active",
      }),
    ).toEqual({ kind: "routed", threadId: "reply", source: "reply" });
  });

  it("never falls back when a replied message has no binding", () => {
    expect(
      routeMessage({ replyToMessageId: "missing", replyBinding: null, activeThreadId: "active" }),
    ).toEqual({ kind: "error", code: "unknown_reply" });
  });

  it("uses a one-shot explicit route for an otherwise unknown reply", () => {
    expect(
      routeMessage({
        replyToMessageId: "missing",
        replyBinding: null,
        explicitThreadId: "manually-selected",
        activeThreadId: "active",
      }),
    ).toEqual({ kind: "routed", threadId: "manually-selected", source: "explicit" });
  });

  it("requires an explicit selection when no route exists", () => {
    expect(routeMessage({})).toEqual({ kind: "error", code: "selection_required" });
  });
});
