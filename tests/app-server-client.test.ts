import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerClient } from "../src/codex/app-server-client.js";

const fakeServer = fileURLToPath(new URL("./fixtures/fake-app-server.mjs", import.meta.url));
const terminalTurnId = "019f0000-0000-7000-8000-000000000001";
let client: AppServerClient | null = null;

afterEach(async () => {
  await client?.close();
  client = null;
});

describe("AppServerClient", { timeout: 15_000 }, () => {
  it("initializes before reading a canonical turn result", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });

    const initialized = await client.connect();
    const result = await client.readTurn("thread-1", terminalTurnId);

    expect(initialized).toMatchObject({ userAgent: "fake", platformOs: "test" });
    expect(result).toEqual({
      threadId: "thread-1",
      turnId: terminalTurnId,
      status: "completed",
      finalMessage: "final answer",
      cwd: "/workspace/example",
      durationMs: null,
    });
  });

  it("surfaces JSON-RPC errors", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    await expect(client.request("unknown", {})).rejects.toThrow("app-server error -32601");
  });

  it("reconnects on the next request after the app-server exits", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    await client.request("test/exit", {});
    await vi.waitFor(() => expect(client?.isConnected()).toBe(false));

    const [turn, snapshot] = await Promise.all([
      client.readTurn("thread-1", terminalTurnId),
      client.readThreadSnapshot("thread-1"),
    ]);

    expect(client.isConnected()).toBe(true);
    expect(turn.finalMessage).toBe("final answer");
    expect(snapshot.latestTerminalTurnId).toBe(terminalTurnId);
  });

  it("ignores rollout and commentary-only pseudo-turns in watched snapshots", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    const snapshot = await client.readThreadSnapshot("thread-1");

    expect(snapshot).toMatchObject({
      threadId: "thread-1",
      cwd: "/workspace/example",
      latestTerminalTurnId: terminalTurnId,
      latestTurn: {
        turnId: terminalTurnId,
        status: "completed",
        finalMessage: "final answer",
      },
      latestTerminalTurn: {
        turnId: terminalTurnId,
        status: "completed",
        finalMessage: "final answer",
      },
      blockedGoal: null,
    });
  });

  it("never promotes commentary to an exact turn's final message", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    const result = await client.readTurn("thread-1", "019f0000-0000-7000-8000-000000000002");

    expect(result.status).toBe("completed");
    expect(result.finalMessage).toBe("");
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
      durationMs: null,
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

  it("passes the dedicated cwd when starting a task without a project", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();

    const started = await client.startThread("/workspace/tasks");

    expect(started.cwd).toBe("/workspace/tasks");
    expect(started.thread.cwd).toBe("/workspace/tasks");
  });

  it("round-trips an experimental request_user_input server request", async () => {
    client = new AppServerClient({ command: process.execPath, args: [fakeServer] });
    await client.connect();
    const requests: string[] = [];
    const unsubscribe = client.onUserInputRequest((request) => {
      requests.push(request.params.questions[0]?.question ?? "");
      client?.respondToUserInput(request.id, {
        answers: { choice: { answers: ["Safe"] } },
      });
    });

    const result = await client.runTurn("thread-1", "needs input");
    unsubscribe();

    expect(requests).toEqual(["Which path should Codex use?"]);
    expect(result).toMatchObject({
      threadId: "thread-1",
      turnId: "turn-stream",
      finalMessage: "selected Safe",
      durationMs: 1250,
    });
  });
});
