import { randomUUID } from "node:crypto";
import { GATEWAY_PROTOCOL_VERSION, GATEWAY_RUNTIME_VERSION } from "../core/build-info.js";
import type {
  EnqueueNotificationInput,
  EventCounts,
  EventState,
  IngressProducer,
  OutboundNotification,
} from "../core/types.js";
import { validateNotificationInput } from "../core/validation.js";
import type { GatewayDatabase } from "./database.js";
import type { LeaseOptions, RetryOptions } from "./event-store.js";

interface NotificationRow {
  id: string;
  idempotency_key: string;
  channel: "telegram";
  cwd: string;
  title: string;
  message: string;
  source_kind: "notification_only" | "bound_thread" | "bound_task";
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  ingress_producer: IngressProducer;
  producer_version: string;
  protocol_version: number;
  state: EventState;
  attempt_count: number;
  next_attempt_at: number;
  lease_expires_at: number | null;
  lease_token: string | null;
  platform_message_id: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export class OutboundNotificationStore {
  constructor(private readonly database: GatewayDatabase) {}

  enqueue(input: EnqueueNotificationInput, now = Date.now()): OutboundNotification {
    validateNotificationInput(input);
    const id = randomUUID();
    this.database.connection
      .prepare(`
        INSERT INTO outbound_notifications (
          id, idempotency_key, channel, cwd, title, message,
          source_kind, codex_thread_id, codex_turn_id, state,
          ingress_producer, producer_version, protocol_version,
          next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .run(
        id,
        input.idempotencyKey,
        input.channel,
        input.cwd,
        input.title,
        input.message,
        input.source.kind,
        input.source.kind !== "notification_only" ? input.source.codexThreadId : null,
        input.source.kind === "bound_task" ? input.source.codexTurnId : null,
        input.ingress?.producer ?? "internal",
        input.ingress?.producerVersion ?? GATEWAY_RUNTIME_VERSION,
        input.ingress?.protocolVersion ?? GATEWAY_PROTOCOL_VERSION,
        now,
        now,
        now,
      );

    const notification = this.findByIdempotencyKey(input.idempotencyKey);
    if (!notification) throw new Error("Failed to enqueue outbound notification");
    return notification;
  }

  findByIdempotencyKey(idempotencyKey: string): OutboundNotification | null {
    const row = this.database.connection
      .prepare("SELECT * FROM outbound_notifications WHERE idempotency_key = ?")
      .get(idempotencyKey) as NotificationRow | undefined;
    return row ? mapNotification(row) : null;
  }

  list(state?: EventState, limit = 20): readonly OutboundNotification[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = state
      ? (this.database.connection
          .prepare(
            "SELECT * FROM outbound_notifications WHERE state = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(state, boundedLimit) as unknown as NotificationRow[])
      : (this.database.connection
          .prepare("SELECT * FROM outbound_notifications ORDER BY created_at DESC LIMIT ?")
          .all(boundedLimit) as unknown as NotificationRow[]);
    return rows.map(mapNotification);
  }

  leaseNext(options: LeaseOptions = {}): OutboundNotification | null {
    const now = options.now ?? Date.now();
    const leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");

    return this.database.transaction(() => {
      this.recoverExpired(now);
      const row = this.database.connection
        .prepare(`
          SELECT * FROM outbound_notifications
          WHERE state = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at
          LIMIT 1
        `)
        .get(now) as NotificationRow | undefined;
      if (!row) return null;

      const leaseToken = randomUUID();
      this.database.connection
        .prepare(`
          UPDATE outbound_notifications
          SET state = 'leased', attempt_count = attempt_count + 1,
              lease_expires_at = ?, lease_token = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'
        `)
        .run(now + leaseDurationMs, leaseToken, now, row.id);
      return this.getRequired(row.id);
    });
  }

  markDelivered(
    id: string,
    leaseToken: string,
    platformMessageId: string,
    now = Date.now(),
  ): OutboundNotification {
    const result = this.database.connection
      .prepare(`
        UPDATE outbound_notifications
        SET state = 'delivered', lease_expires_at = NULL, lease_token = NULL,
            platform_message_id = ?, last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `)
      .run(platformMessageId, now, id, leaseToken);
    if (result.changes !== 1) throw new Error("Notification lease is missing or stale");
    return this.getRequired(id);
  }

  markFailed(
    id: string,
    leaseToken: string,
    errorMessage: string,
    options: RetryOptions = {},
  ): OutboundNotification {
    const now = options.now ?? Date.now();
    const maxAttempts = options.maxAttempts ?? 8;
    const baseDelayMs = options.baseDelayMs ?? 1_000;
    const maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    const notification = this.getRequired(id);
    if (notification.state !== "leased" || notification.leaseToken !== leaseToken) {
      throw new Error("Notification lease is missing or stale");
    }

    const deadLetter = notification.attemptCount >= maxAttempts;
    const delay = Math.min(
      maxDelayMs,
      baseDelayMs * 2 ** Math.max(0, notification.attemptCount - 1),
    );
    const safeError = redactErrorMessage(errorMessage).slice(0, 1_000);
    const result = this.database.connection
      .prepare(`
        UPDATE outbound_notifications
        SET state = ?, next_attempt_at = ?, lease_expires_at = NULL, lease_token = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `)
      .run(deadLetter ? "dead_letter" : "queued", now + delay, safeError, now, id, leaseToken);
    if (result.changes !== 1) throw new Error("Notification lease is missing or stale");
    return this.getRequired(id);
  }

  recoverExpired(now = Date.now()): number {
    const result = this.database.connection
      .prepare(`
        UPDATE outbound_notifications
        SET state = 'queued', lease_expires_at = NULL, lease_token = NULL,
            next_attempt_at = ?, updated_at = ?
        WHERE state = 'leased' AND lease_expires_at <= ?
      `)
      .run(now, now, now);
    return Number(result.changes);
  }

  counts(): EventCounts {
    const rows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM outbound_notifications GROUP BY state")
      .all() as Array<{ state: EventState; count: number }>;
    const counts = { queued: 0, leased: 0, delivered: 0, deadLetter: 0 };
    for (const row of rows) {
      if (row.state === "dead_letter") counts.deadLetter = row.count;
      else counts[row.state] = row.count;
    }
    return counts;
  }

  private getRequired(id: string): OutboundNotification {
    const row = this.database.connection
      .prepare("SELECT * FROM outbound_notifications WHERE id = ?")
      .get(id) as NotificationRow | undefined;
    if (!row) throw new Error(`Unknown outbound notification: ${id}`);
    return mapNotification(row);
  }
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function mapNotification(row: NotificationRow): OutboundNotification {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    channel: row.channel,
    cwd: row.cwd,
    title: row.title,
    message: row.message,
    source:
      row.source_kind === "bound_task" && row.codex_thread_id && row.codex_turn_id
        ? {
            kind: "bound_task",
            codexThreadId: row.codex_thread_id,
            codexTurnId: row.codex_turn_id,
          }
        : row.source_kind === "bound_thread" && row.codex_thread_id
          ? { kind: "bound_thread", codexThreadId: row.codex_thread_id }
          : { kind: "notification_only" },
    ingress: {
      producer: row.ingress_producer,
      producerVersion: row.producer_version,
      protocolVersion: row.protocol_version,
    },
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    platformMessageId: row.platform_message_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
