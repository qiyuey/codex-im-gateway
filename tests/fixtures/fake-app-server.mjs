import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let initialized = false;
let experimentalApi = false;
let pendingInputThreadId = null;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    experimentalApi = message.params.capabilities?.experimentalApi === true;
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { userAgent: "fake", codexHome: "/tmp", platformFamily: "unix", platformOs: "test" } })}\n`,
    );
  } else if (message.method === "initialized") {
    initialized = true;
  } else if (message.method === "thread/read") {
    if (!initialized) throw new Error("not initialized");
    process.stdout.write(
      `${JSON.stringify({
        id: message.id,
        result: {
          thread: {
            id: message.params.threadId,
            cwd: "/workspace/example",
            turns: [
              {
                id: "turn-1",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    id: "message-1",
                    text: "draft",
                    phase: null,
                    memoryCitation: null,
                  },
                  {
                    type: "agentMessage",
                    id: "message-2",
                    text: "final answer",
                    phase: null,
                    memoryCitation: null,
                  },
                ],
              },
            ],
          },
        },
      })}\n`,
    );
  } else if (message.method === "thread/start") {
    if (message.params.sandbox !== "danger-full-access") {
      throw new Error("thread/start must use danger-full-access");
    }
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-fresh", cwd: message.params.cwd }, cwd: message.params.cwd } })}\n`,
    );
  } else if (message.method === "thread/goal/get") {
    process.stdout.write(`${JSON.stringify({ id: message.id, result: { goal: null } })}\n`);
  } else if (message.method === "thread/resume" && message.params.threadId === "thread-fresh") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32600, message: "no rollout found" } })}\n`,
    );
  } else if (message.method === "thread/resume") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { cwd: "/workspace/example" } })}\n`,
    );
  } else if (message.method === "turn/start") {
    if (message.params.sandboxPolicy?.type !== "dangerFullAccess") {
      throw new Error("turn/start must use dangerFullAccess");
    }
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-stream", status: "inProgress", items: [] } } })}\n`,
    );
    if (message.params.input?.[0]?.text === "needs input") {
      if (!experimentalApi) throw new Error("experimental API was not enabled");
      pendingInputThreadId = message.params.threadId;
      setTimeout(() => {
        process.stdout.write(
          `${JSON.stringify({
            id: "request-input-1",
            method: "item/tool/requestUserInput",
            params: {
              threadId: message.params.threadId,
              turnId: "turn-stream",
              itemId: "input-1",
              autoResolutionMs: null,
              questions: [
                {
                  id: "choice",
                  header: "Choose",
                  question: "Which path should Codex use?",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "Safe", description: "Use the safer path." },
                    { label: "Fast", description: "Use the faster path." },
                  ],
                },
              ],
            },
          })}\n`,
        );
      }, 0);
      return;
    }
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: "turn-stream", itemId: "agent-1", delta: "streamed " } })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-stream", status: "completed", items: [{ type: "agentMessage", id: "agent-1", text: "streamed final", phase: null, memoryCitation: null }] } } })}\n`,
      );
    }, 0);
  } else if (message.id === "request-input-1" && message.result) {
    const answer = message.result.answers?.choice?.answers?.[0] ?? "missing";
    process.stdout.write(
      `${JSON.stringify({ method: "turn/completed", params: { threadId: pendingInputThreadId, turn: { id: "turn-stream", status: "completed", items: [{ type: "agentMessage", id: "agent-1", text: `selected ${answer}`, phase: null, memoryCitation: null }], durationMs: 1250 } } })}\n`,
    );
    pendingInputThreadId = null;
  } else if (message.id) {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32601, message: "unknown method" } })}\n`,
    );
  }
});
