import { randomUUID } from "node:crypto";
import type { GatewayDatabase } from "./database.js";

export interface MessageBindingRecord {
  readonly channel: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly codexThreadId: string;
  readonly codexTurnId: string;
  readonly scheduleKey: string | null;
  readonly createdAt: number;
}

export interface DeliveryTarget {
  readonly channel: string;
  readonly chatId: string;
  readonly topicId?: string | null;
}

interface BindingRow {
  channel: string;
  chat_id: string;
  message_id: string;
  codex_thread_id: string;
  codex_turn_id: string;
  schedule_key: string | null;
  created_at: number;
}

export class GatewayStateStore {
  constructor(private readonly database: GatewayDatabase) {}

  hasSentDelivery(completionEventId: string, target: DeliveryTarget): boolean {
    const row = this.database.connection
      .prepare(`
        SELECT 1 FROM deliveries
        WHERE completion_event_id = ? AND channel = ? AND chat_id = ? AND topic_id = ?
          AND delivery_state = 'sent'
      `)
      .get(completionEventId, target.channel, target.chatId, normalizeTopic(target.topicId));
    return row !== undefined;
  }

  recordSentDelivery(
    completionEventId: string,
    target: DeliveryTarget,
    messageId: string,
    binding: {
      readonly threadId: string;
      readonly turnId: string;
      readonly scheduleKey?: string | null;
    },
    now = Date.now(),
  ): void {
    this.database.transaction(() => {
      this.database.connection
        .prepare(`
          INSERT INTO deliveries (
            id, completion_event_id, channel, chat_id, topic_id, message_id,
            delivery_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'sent', ?, ?)
          ON CONFLICT(completion_event_id, channel, chat_id, topic_id) DO UPDATE SET
            message_id = excluded.message_id, delivery_state = 'sent', updated_at = excluded.updated_at
        `)
        .run(
          randomUUID(),
          completionEventId,
          target.channel,
          target.chatId,
          normalizeTopic(target.topicId),
          messageId,
          now,
          now,
        );
      this.bindMessage(
        target.channel,
        target.chatId,
        messageId,
        binding.threadId,
        binding.turnId,
        binding.scheduleKey ?? null,
        now,
      );
      this.setActiveThread(target.channel, target.chatId, target.topicId, binding.threadId, now);
    });
  }

  bindMessage(
    channel: string,
    chatId: string,
    messageId: string,
    threadId: string,
    turnId: string,
    scheduleKey: string | null = null,
    now = Date.now(),
  ): void {
    this.database.connection
      .prepare(`
        INSERT INTO message_bindings (
          channel, chat_id, message_id, codex_thread_id, codex_turn_id, schedule_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id, message_id) DO UPDATE SET
          codex_thread_id = excluded.codex_thread_id,
          codex_turn_id = excluded.codex_turn_id,
          schedule_key = excluded.schedule_key
      `)
      .run(channel, chatId, messageId, threadId, turnId, scheduleKey, now);
  }

  findMessageBinding(
    channel: string,
    chatId: string,
    messageId: string,
  ): MessageBindingRecord | null {
    const row = this.database.connection
      .prepare(`
        SELECT * FROM message_bindings
        WHERE channel = ? AND chat_id = ? AND message_id = ?
      `)
      .get(channel, chatId, messageId) as BindingRow | undefined;
    return row ? mapBinding(row) : null;
  }

  setActiveThread(
    channel: string,
    chatId: string,
    topicId: string | null | undefined,
    threadId: string,
    now = Date.now(),
  ): void {
    this.database.connection
      .prepare(`
        INSERT INTO context_state (channel, chat_id, topic_id, active_codex_thread_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id, topic_id) DO UPDATE SET
          active_codex_thread_id = excluded.active_codex_thread_id,
          updated_at = excluded.updated_at
      `)
      .run(channel, chatId, normalizeTopic(topicId), threadId, now);
  }

  getActiveThread(channel: string, chatId: string, topicId?: string | null): string | null {
    const row = this.database.connection
      .prepare(`
        SELECT active_codex_thread_id FROM context_state
        WHERE channel = ? AND chat_id = ? AND topic_id = ?
      `)
      .get(channel, chatId, normalizeTopic(topicId)) as
      | { active_codex_thread_id: string }
      | undefined;
    return row?.active_codex_thread_id ?? null;
  }

  detach(channel: string, chatId: string, topicId?: string | null): boolean {
    const result = this.database.connection
      .prepare("DELETE FROM context_state WHERE channel = ? AND chat_id = ? AND topic_id = ?")
      .run(channel, chatId, normalizeTopic(topicId));
    return result.changes === 1;
  }

  listRecentBindings(channel: string, chatId: string, limit = 10): readonly MessageBindingRecord[] {
    const rows = this.database.connection
      .prepare(`
        SELECT * FROM message_bindings
        WHERE channel = ? AND chat_id = ?
        GROUP BY codex_thread_id
        ORDER BY MAX(created_at) DESC
        LIMIT ?
      `)
      .all(channel, chatId, Math.max(1, Math.min(limit, 50))) as unknown as BindingRow[];
    return rows.map(mapBinding);
  }
}

function normalizeTopic(topicId: string | null | undefined): string {
  return topicId ?? "";
}

function mapBinding(row: BindingRow): MessageBindingRecord {
  return {
    channel: row.channel,
    chatId: row.chat_id,
    messageId: row.message_id,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    scheduleKey: row.schedule_key,
    createdAt: row.created_at,
  };
}
