import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveDatabasePath } from "../config/paths.js";
import { eventStates } from "../core/types.js";
import { LocalKillSwitch } from "../security/kill-switch.js";
import { openEventStore, openNotificationStore } from "../storage/open-store.js";

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
      notifications: z.object({
        deadLetter: z.number(),
        delivered: z.number(),
        leased: z.number(),
        queued: z.number(),
      }),
    }),
  },
  async () =>
    withStore(({ store }) => {
      const notificationContext = openNotificationStore();
      try {
        return success({
          status: "ok" as const,
          inboundEnabled: new LocalKillSwitch().isInboundEnabled(),
          databasePath: resolveDatabasePath(),
          ...store.counts(),
          notifications: notificationContext.store.counts(),
        });
      } finally {
        notificationContext.database.close();
      }
    }),
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
  "telegram_deliver",
  {
    description:
      "Durably queue one explicit final task result for Telegram delivery. Use only when the user or scheduled-task contract explicitly requires Telegram delivery.",
    inputSchema: z.object({
      cwd: z.string().min(1).max(4096).describe("Absolute task workspace path"),
      title: z.string().min(1).max(200),
      message: z.string().min(1).max(12_000),
      dedupeKey: z.string().min(1).max(256).optional(),
    }),
    outputSchema: z.object({
      notificationId: z.string(),
      state: z.string(),
      duplicate: z.boolean(),
    }),
  },
  async ({ cwd, title, message, dedupeKey }) => {
    const context = openNotificationStore();
    try {
      const idempotencyKey = `explicit:${dedupeKey ?? randomUUID()}`;
      const duplicate = context.store.findByIdempotencyKey(idempotencyKey) !== null;
      const notification = context.store.enqueue({
        idempotencyKey,
        channel: "telegram",
        cwd: resolve(cwd),
        title,
        message,
        source: { kind: "notification_only" },
      });
      return success({ notificationId: notification.id, state: notification.state, duplicate });
    } finally {
      context.database.close();
    }
  },
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
