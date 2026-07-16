import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { enqueueStopEvent } from "../src/hooks/stop.js";
import { GatewayDatabase } from "../src/storage/database.js";
import { CompletionEventStore } from "../src/storage/event-store.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Stop hook", () => {
  it("durably and idempotently captures a top-level completed turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-im-hook-"));
    roots.push(root);
    const env = { CODEX_IM_DATA_DIR: root };
    const input = {
      hook_event_name: "Stop",
      session_id: "thread-1",
      turn_id: "turn-1",
      transcript_path: "/sessions/thread-1.jsonl",
      cwd: "/workspace/example",
    };

    expect(enqueueStopEvent(input, env)).toBe(true);
    expect(enqueueStopEvent(input, env)).toBe(true);

    const database = new GatewayDatabase(join(root, "gateway.sqlite"));
    try {
      expect(new CompletionEventStore(database).list()).toEqual([
        expect.objectContaining({
          codexThreadId: "thread-1",
          codexTurnId: "turn-1",
          cwd: "/workspace/example",
          state: "queued",
        }),
      ]);
    } finally {
      database.close();
    }
  });

  it("ignores events other than the top-level Stop lifecycle event", () => {
    expect(enqueueStopEvent({ hook_event_name: "SubagentStop" }, {})).toBe(false);
  });

  it("ignores transcriptless internal and ephemeral sessions", () => {
    expect(
      enqueueStopEvent(
        {
          hook_event_name: "Stop",
          session_id: "ephemeral-thread",
          turn_id: "ephemeral-turn",
          transcript_path: null,
          cwd: "/workspace/example",
        },
        {},
      ),
    ).toBe(false);
  });
});
