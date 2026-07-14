import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveDatabasePath } from "../config/paths.js";
import { eventStates } from "../core/types.js";
import { LocalKillSwitch } from "../security/kill-switch.js";
import { openEventStore } from "../storage/open-store.js";

const server = new McpServer({ name: "codex-im-gateway", version: "0.1.0" });

server.registerTool(
  "gateway_health",
  {
    description: "Check the local gateway database and completion queue health.",
    outputSchema: z.object({
      databasePath: z.string(),
      deadLetter: z.number(),
      delivered: z.number(),
      leased: z.number(),
      queued: z.number(),
      status: z.literal("ok"),
      inboundEnabled: z.boolean(),
    }),
  },
  async () =>
    withStore(({ store }) =>
      success({
        status: "ok" as const,
        inboundEnabled: new LocalKillSwitch().isInboundEnabled(),
        databasePath: resolveDatabasePath(),
        ...store.counts(),
      }),
    ),
);

server.registerTool(
  "gateway_list_events",
  {
    description: "List completion event metadata without returning private payload content.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      state: z.enum(eventStates).optional(),
    }),
    outputSchema: z.object({
      events: z.array(
        z.object({
          attemptCount: z.number(),
          codexThreadId: z.string(),
          codexTurnId: z.string(),
          createdAt: z.number(),
          eventType: z.string(),
          id: z.string(),
          state: z.string(),
        }),
      ),
    }),
  },
  async ({ limit, state }) =>
    withStore(({ store }) =>
      success({
        events: store.list(state, limit).map((event) => ({
          attemptCount: event.attemptCount,
          codexThreadId: event.codexThreadId,
          codexTurnId: event.codexTurnId,
          createdAt: event.createdAt,
          eventType: event.eventType,
          id: event.id,
          state: event.state,
        })),
      }),
    ),
);

server.registerTool(
  "gateway_enqueue",
  {
    description:
      "Explicitly enqueue a Codex completion event for delivery testing or fallback production.",
    inputSchema: z.object({
      codexThreadId: z.string().min(1).max(256),
      codexTurnId: z.string().min(1).max(256),
      cwd: z.string().min(1).max(4096),
      eventType: z.enum(["completed", "failed", "blocked"]).default("completed"),
    }),
    outputSchema: z.object({ eventId: z.string(), state: z.string() }),
  },
  async ({ codexThreadId, codexTurnId, cwd, eventType }) =>
    withStore(({ store }) => {
      const event = store.enqueue({
        codexThreadId,
        codexTurnId,
        cwd,
        eventType,
        idempotencyKey: `${codexThreadId}:${codexTurnId}`,
        payload: {},
      });
      return success({ eventId: event.id, state: event.state });
    }),
);

function withStore<T>(operation: (context: ReturnType<typeof openEventStore>) => T): T {
  const context = openEventStore();
  try {
    return operation(context);
  } finally {
    context.database.close();
  }
}

function success<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

await server.connect(new StdioServerTransport());
