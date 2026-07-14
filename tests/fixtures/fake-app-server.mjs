import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
let initialized = false;

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
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
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { thread: { id: "thread-fresh", cwd: message.params.cwd }, cwd: message.params.cwd } })}\n`,
    );
  } else if (message.method === "thread/resume" && message.params.threadId === "thread-fresh") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32600, message: "no rollout found" } })}\n`,
    );
  } else if (message.method === "thread/resume") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { cwd: "/workspace/example" } })}\n`,
    );
  } else if (message.method === "turn/start") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { turn: { id: "turn-stream", status: "inProgress", items: [] } } })}\n`,
    );
    setTimeout(() => {
      process.stdout.write(
        `${JSON.stringify({ method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: "turn-stream", itemId: "agent-1", delta: "streamed " } })}\n`,
      );
      process.stdout.write(
        `${JSON.stringify({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-stream", status: "completed", items: [{ type: "agentMessage", id: "agent-1", text: "streamed final", phase: null, memoryCitation: null }] } } })}\n`,
      );
    }, 0);
  } else if (message.id) {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32601, message: "unknown method" } })}\n`,
    );
  }
});
