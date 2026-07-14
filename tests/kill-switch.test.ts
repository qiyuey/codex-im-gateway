import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalKillSwitch } from "../src/security/kill-switch.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("LocalKillSwitch", () => {
  it("persists inbound disablement until explicitly enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "gateway-kill-switch-"));
    directories.push(directory);
    const env = { CODEX_IM_GATEWAY_DATA_DIR: directory };
    const first = new LocalKillSwitch(env);

    expect(first.isInboundEnabled()).toBe(true);
    first.disable();
    expect(new LocalKillSwitch(env).isInboundEnabled()).toBe(false);
    first.enable();
    expect(first.isInboundEnabled()).toBe(true);
  });
});
