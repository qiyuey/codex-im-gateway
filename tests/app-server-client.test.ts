import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AppServerClient } from "../src/codex/app-server-client.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
let client: AppServerClient | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

describe("AppServerClient", () => {
  it("initializes before reading a canonical turn result", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });

    const initialized = await client.connect();
    const result = await client.readTurn("thread-1", "turn-1");

    expect(initialized).toMatchObject({ userAgent: "fake", platformOs: "test" });
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finalMessage: "final answer",
      cwd: "/workspace/example",
    });
  });

  it("surfaces JSON-RPC errors", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    await expect(client.request("unknown", {})).rejects.toThrow("app-server error -32601");
  });

  it("streams a follow-up turn and returns its canonical final message", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();
    const deltas: string[] = [];

    const result = await client.runTurn("thread-1", "continue", (text) => deltas.push(text));

    expect(deltas).toEqual(["streamed "]);
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: "turn-stream",
      status: "completed",
      finalMessage: "streamed final",
      cwd: "/workspace/example",
    });
  });

  it("runs the first turn without resuming an unmaterialized new thread", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    const started = await client.startThread("/workspace/fresh");
    const result = await client.runTurn(started.thread.id, "first turn");

    expect(result).toMatchObject({
      threadId: "thread-fresh",
      turnId: "turn-stream",
      status: "completed",
      cwd: "/workspace/fresh",
    });
  });
});
