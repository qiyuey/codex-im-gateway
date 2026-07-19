import { describe, expect, it } from "vitest";
import { notificationSourceFromRequestMeta } from "../src/mcp/request-source.js";

describe("Codex MCP request identity", () => {
  it("binds a notification when all trusted Codex thread identities agree", () => {
    expect(
      notificationSourceFromRequestMeta({
        progressToken: 1,
        threadId: "thread-1",
        "x-codex-turn-metadata": {
          session_id: "thread-1",
          thread_id: "thread-1",
          turn_id: "turn-1",
          workspace_kind: "local",
        },
      }),
    ).toEqual({
      kind: "bound_task",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
  });

  it.each([
    ["missing metadata", undefined],
    ["non-object metadata", "thread-1"],
    ["missing top-level thread", codexMeta({ topLevelThreadId: undefined })],
    ["missing turn", codexMeta({ turnId: undefined })],
    ["thread mismatch", codexMeta({ nestedThreadId: "thread-2" })],
    ["session mismatch", codexMeta({ sessionId: "thread-2" })],
    ["unsafe identifier", codexMeta({ turnId: " turn-1" })],
  ])("falls back to notification-only for %s", (_label, meta) => {
    expect(notificationSourceFromRequestMeta(meta)).toEqual({ kind: "notification_only" });
  });

  it("ignores model-visible lookalike fields outside request metadata", () => {
    expect(
      notificationSourceFromRequestMeta({
        codexThreadId: "thread-1",
        codexTurnId: "turn-1",
      }),
    ).toEqual({ kind: "notification_only" });
  });

  it("binds the switch action to the trusted inherited Codex thread without turn metadata", () => {
    expect(notificationSourceFromRequestMeta(undefined, "thread-1")).toEqual({
      kind: "bound_thread",
      codexThreadId: "thread-1",
    });
  });

  it("fails closed when request metadata conflicts with the inherited Codex thread", () => {
    expect(notificationSourceFromRequestMeta(codexMeta(), "thread-2")).toEqual({
      kind: "bound_task",
      codexThreadId: "thread-1",
      codexTurnId: "turn-1",
    });
    expect(
      notificationSourceFromRequestMeta(
        { threadId: "thread-2", "x-codex-turn-metadata": { thread_id: "thread-2" } },
        "thread-1",
      ),
    ).toEqual({ kind: "notification_only" });
  });
});

function codexMeta(
  overrides: {
    topLevelThreadId?: string | undefined;
    nestedThreadId?: string;
    sessionId?: string;
    turnId?: string | undefined;
  } = {},
) {
  const topLevelThreadId = Object.hasOwn(overrides, "topLevelThreadId")
    ? overrides.topLevelThreadId
    : "thread-1";
  const turnId = Object.hasOwn(overrides, "turnId") ? overrides.turnId : "turn-1";
  return {
    ...(topLevelThreadId === undefined ? {} : { threadId: topLevelThreadId }),
    "x-codex-turn-metadata": {
      thread_id: overrides.nestedThreadId ?? "thread-1",
      session_id: overrides.sessionId ?? "thread-1",
      ...(turnId === undefined ? {} : { turn_id: turnId }),
    },
  };
}
