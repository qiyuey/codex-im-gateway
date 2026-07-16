import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeStatusWriter,
  readRuntimeHealth,
  resolveRuntimeStatusPath,
} from "../src/runtime/runtime-status.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("runtime status", () => {
  it("reports a live compatible heartbeat and then a clean stop", () => {
    const directory = temporaryDirectory();
    const env = { CODEX_IM_DATA_DIR: directory };
    let now = 1_000;
    const writer = new RuntimeStatusWriter(resolveRuntimeStatusPath(env), () => now, process.pid);

    writer.start(60_000);
    expect(readRuntimeHealth(env, 1_100)).toMatchObject({
      running: true,
      state: "running",
      pid: process.pid,
      compatible: true,
      heartbeatAgeMs: 100,
    });

    now = 1_200;
    writer.stop();
    expect(readRuntimeHealth(env, 1_300)).toMatchObject({
      running: false,
      state: "stopped",
      pid: process.pid,
    });
  });

  it("treats malformed status as unknown", () => {
    const directory = temporaryDirectory();
    const env = { CODEX_IM_DATA_DIR: directory };
    writeFileSync(resolveRuntimeStatusPath(env), "not-json");
    expect(readRuntimeHealth(env)).toMatchObject({ running: false, state: "unknown" });
  });

  it("writes owner-only status files atomically", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "runtime-status.json");
    const writer = new RuntimeStatusWriter(path);
    writer.start(60_000);
    writer.stop();
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ state: "stopped" });
  });

  it("does not let an old daemon overwrite a newer daemon heartbeat", () => {
    const directory = temporaryDirectory();
    const path = join(directory, "runtime-status.json");
    const oldWriter = new RuntimeStatusWriter(path, () => 1_000, process.pid);
    const newWriter = new RuntimeStatusWriter(path, () => 2_000, process.pid + 1);
    oldWriter.start(60_000);
    newWriter.start(60_000);

    oldWriter.stop();

    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      state: "running",
      pid: process.pid + 1,
      heartbeatAt: 2_000,
    });
    newWriter.stop();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "gateway-status-"));
  directories.push(directory);
  return directory;
}
