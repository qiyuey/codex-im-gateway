import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectGatewayHealth } from "../src/application/health.js";
import { RuntimeStatusWriter, resolveRuntimeStatusPath } from "../src/runtime/runtime-status.js";
import { LocalKillSwitch } from "../src/security/kill-switch.js";

describe("collectGatewayHealth", () => {
  it("requires a live compatible daemon and respects the selected data directory", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-health-"));
    const env = { CODEX_IM_DATA_DIR: directory };
    const status = new RuntimeStatusWriter(resolveRuntimeStatusPath(env));
    try {
      status.start(60_000);
      expect(collectGatewayHealth(env)).toMatchObject({
        status: "ok",
        inboundEnabled: true,
        runtime: { running: true, pid: process.pid, compatible: true },
      });

      new LocalKillSwitch(env).disable();
      expect(collectGatewayHealth(env).inboundEnabled).toBe(false);

      status.stop();
      expect(collectGatewayHealth(env)).toMatchObject({
        status: "degraded",
        runtime: { running: false, state: "stopped" },
      });
    } finally {
      status.stop();
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
