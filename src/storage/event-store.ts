import { randomUUID } from "node:crypto";
import type {
  CompletionEvent,
  CompletionEventType,
  EnqueueCompletionInput,
  EventCounts,
  EventState,
} from "../core/types.js";
import { validateEnqueueInput } from "../core/validation.js";
import type { GatewayDatabase } from "./database.js";

interface EventRow {
  id: string;
  idempotency_key: string;
  codex_thread_id: string;
  codex_turn_id: string;
  cwd: string;
  event_type: CompletionEventType;
  payload_json: string;
  state: EventState;
  attempt_count: number;
  next_attempt_at: number;
  lease_expires_at: number | null;
  lease_token: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface LeaseOptions {
  readonly now?: number;
  readonly leaseDurationMs?: number;
}

export interface RetryOptions {
  readonly now?: number;
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export class CompletionEventStore {
  constructor(private readonly database: GatewayDatabase) {}

  enqueue(input: EnqueueCompletionInput, now = Date.now()): CompletionEvent {
    validateEnqueueInput(input);
    const id = randomUUID();
    const payloadJson = JSON.stringify(input.payload ?? {});

    this.database.connection
      .prepare(`
        INSERT INTO completion_events (
          id, idempotency_key, codex_thread_id, codex_turn_id, cwd, event_type,
          payload_json, state, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        ON CONFLICT(idempotency_key) DO NOTHING
      `)
      .run(
        id,
        input.idempotencyKey,
        input.codexThreadId,
        input.codexTurnId,
        input.cwd,
        input.eventType,
        payloadJson,
        now,
        now,
        now,
      );

    const event = this.findByIdempotencyKey(input.idempotencyKey);
    if (!event) throw new Error("Failed to enqueue completion event");
    return event;
  }

  findByIdempotencyKey(idempotencyKey: string): CompletionEvent | null {
    const row = this.database.connection
      .prepare("SELECT * FROM completion_events WHERE idempotency_key = ?")
      .get(idempotencyKey) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  list(state?: EventState, limit = 20): readonly CompletionEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 100));
    const rows = state
      ? (this.database.connection
          .prepare(
            "SELECT * FROM completion_events WHERE state = ? ORDER BY created_at DESC LIMIT ?",
          )
          .all(state, boundedLimit) as unknown as EventRow[])
      : (this.database.connection
          .prepare("SELECT * FROM completion_events ORDER BY created_at DESC LIMIT ?")
          .all(boundedLimit) as unknown as EventRow[]);
    return rows.map(mapEvent);
  }

  leaseNext(options: LeaseOptions = {}): CompletionEvent | null {
    const now = options.now ?? Date.now();
    const leaseDurationMs = options.leaseDurationMs ?? 30_000;
    if (leaseDurationMs <= 0) throw new Error("leaseDurationMs must be positive");

    return this.database.transaction(() => {
      this.recoverExpired(now);
      const row = this.database.connection
        .prepare(`
          SELECT * FROM completion_events
          WHERE state = 'queued' AND next_attempt_at <= ?
          ORDER BY next_attempt_at, created_at
          LIMIT 1
        `)
        .get(now) as EventRow | undefined;
      if (!row) return null;

      const leaseToken = randomUUID();
      this.database.connection
        .prepare(`
          UPDATE completion_events
          SET state = 'leased', attempt_count = attempt_count + 1,
              lease_expires_at = ?, lease_token = ?, updated_at = ?
          WHERE id = ? AND state = 'queued'
        `)
        .run(now + leaseDurationMs, leaseToken, now, row.id);

      return this.getRequired(row.id);
    });
  }

  markDelivered(id: string, leaseToken: string, now = Date.now()): CompletionEvent {
    const result = this.database.connection
      .prepare(`
        UPDATE completion_events
        SET state = 'delivered', lease_expires_at = NULL, lease_token = NULL,
            last_error = NULL, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `)
      .run(now, id, leaseToken);
    if (result.changes !== 1) throw new Error("Event lease is missing or stale");
    return this.getRequired(id);
  }

  markFailed(
    id: string,
    leaseToken: string,
    errorMessage: string,
    options: RetryOptions = {},
  ): CompletionEvent {
    const now = options.now ?? Date.now();
    const maxAttempts = options.maxAttempts ?? 8;
    const baseDelayMs = options.baseDelayMs ?? 1_000;
    const maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    const event = this.getRequired(id);
    if (event.state !== "leased" || event.leaseToken !== leaseToken) {
      throw new Error("Event lease is missing or stale");
    }

    const deadLetter = event.attemptCount >= maxAttempts;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, event.attemptCount - 1));
    const safeError = redactErrorMessage(errorMessage).slice(0, 1_000);
    const result = this.database.connection
      .prepare(`
        UPDATE completion_events
        SET state = ?, next_attempt_at = ?, lease_expires_at = NULL, lease_token = NULL,
            last_error = ?, updated_at = ?
        WHERE id = ? AND state = 'leased' AND lease_token = ?
      `)
      .run(deadLetter ? "dead_letter" : "queued", now + delay, safeError, now, id, leaseToken);
    if (result.changes !== 1) throw new Error("Event lease is missing or stale");
    return this.getRequired(id);
  }

  recoverExpired(now = Date.now()): number {
    const result = this.database.connection
      .prepare(`
        UPDATE completion_events
        SET state = 'queued', lease_expires_at = NULL, lease_token = NULL,
            next_attempt_at = ?, updated_at = ?
        WHERE state = 'leased' AND lease_expires_at <= ?
      `)
      .run(now, now, now);
    return Number(result.changes);
  }

  counts(): EventCounts {
    const rows = this.database.connection
      .prepare("SELECT state, COUNT(*) AS count FROM completion_events GROUP BY state")
      .all() as Array<{ state: EventState; count: number }>;
    const counts = { queued: 0, leased: 0, delivered: 0, deadLetter: 0 };
    for (const row of rows) {
      if (row.state === "dead_letter") counts.deadLetter = row.count;
      else counts[row.state] = row.count;
    }
    return counts;
  }

  private getRequired(id: string): CompletionEvent {
    const row = this.database.connection
      .prepare("SELECT * FROM completion_events WHERE id = ?")
      .get(id) as EventRow | undefined;
    if (!row) throw new Error(`Unknown completion event: ${id}`);
    return mapEvent(row);
  }
}

function redactErrorMessage(message: string): string {
  return message
    .replace(/\b(bearer)\s+[a-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
    .replace(/\b(token|api[_-]?key|password|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

function mapEvent(row: EventRow): CompletionEvent {
  const payload = JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>;
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    cwd: row.cwd,
    eventType: row.event_type,
    payload,
    state: row.state,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    leaseToken: row.lease_token,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
