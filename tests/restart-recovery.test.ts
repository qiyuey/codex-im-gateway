import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GatewayDatabase } from "../src/storage/database.js";
import { CompletionEventStore } from "../src/storage/event-store.js";

describe("restart recovery", () => {
  it("persists an event and recovers its expired lease after reopening SQLite", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-restart-"));
    const path = join(directory, "gateway.sqlite");
    try {
      const firstDatabase = new GatewayDatabase(path);
      const firstStore = new CompletionEventStore(firstDatabase);
      firstStore.enqueue(
        {
          idempotencyKey: "thread:turn",
          codexThreadId: "thread",
          codexTurnId: "turn",
          cwd: "/workspace",
          eventType: "completed",
        },
        1_000,
      );
      expect(firstStore.leaseNext({ now: 1_100, leaseDurationMs: 100 })?.state).toBe("leased");
      firstDatabase.close();

      const reopenedDatabase = new GatewayDatabase(path);
      const reopenedStore = new CompletionEventStore(reopenedDatabase);
      expect(reopenedStore.recoverExpired(1_201)).toBe(1);
      expect(reopenedStore.leaseNext({ now: 1_201 })).toMatchObject({
        codexThreadId: "thread",
        attemptCount: 2,
      });
      reopenedDatabase.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
