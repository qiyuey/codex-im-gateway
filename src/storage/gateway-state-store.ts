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

export type TerminalDeliverySource =
  | "completion_event"
  | "explicit_notification"
  | "telegram_turn"
  | "watch";

export interface ThreadWatchRecord {
  readonly channel: string;
  readonly chatId: string;
  readonly topicId: string | null;
  readonly codexThreadId: string;
  readonly lastDeliveredTurnId: string | null;
  readonly lastDeliveredGoalUpdatedAt: number | null;
  readonly updatedAt: number;
}

export interface ActiveThreadRecord {
  readonly channel: string;
  readonly chatId: string;
  readonly topicId: string | null;
  readonly codexThreadId: string;
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

interface WatchRow {
  channel: string;
  chat_id: string;
  topic_id: string;
  codex_thread_id: string;
  last_delivered_turn_id: string | null;
  last_delivered_goal_updated_at: number | null;
  updated_at: number;
}

interface ActiveThreadRow {
  channel: string;
  chat_id: string;
  topic_id: string;
  active_codex_thread_id: string;
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
      if (
        this.insertTerminalDelivery(
          target,
          binding.threadId,
          binding.turnId,
          "completion_event",
          completionEventId,
          messageId,
          now,
        )
      ) {
        this.bindMessage(
          target.channel,
          target.chatId,
          messageId,
          binding.threadId,
          binding.turnId,
          binding.scheduleKey ?? null,
          now,
        );
      }
    });
  }

  getTerminalDeliveryMessageId(
    target: DeliveryTarget,
    threadId: string,
    turnId: string,
  ): string | null {
    const row = this.database.connection
      .prepare(`
        SELECT message_id FROM terminal_deliveries
        WHERE channel = ? AND chat_id = ? AND topic_id = ?
          AND codex_thread_id = ? AND codex_turn_id = ?
      `)
      .get(target.channel, target.chatId, normalizeTopic(target.topicId), threadId, turnId) as
      | { message_id: string }
      | undefined;
    return row?.message_id ?? null;
  }

  recordTerminalDelivery(
    target: DeliveryTarget,
    threadId: string,
    turnId: string,
    sourceKind: TerminalDeliverySource,
    sourceId: string | null,
    messageId: string,
    now = Date.now(),
  ): boolean {
    return this.database.transaction(() => {
      const inserted = this.insertTerminalDelivery(
        target,
        threadId,
        turnId,
        sourceKind,
        sourceId,
        messageId,
        now,
      );
      if (inserted) {
        this.bindMessage(target.channel, target.chatId, messageId, threadId, turnId, null, now);
      }
      return inserted;
    });
  }

  isThreadMuted(target: DeliveryTarget, threadId: string): boolean {
    return (
      this.database.connection
        .prepare(`
          SELECT 1 FROM muted_threads
          WHERE channel = ? AND chat_id = ? AND topic_id = ? AND codex_thread_id = ?
        `)
        .get(target.channel, target.chatId, normalizeTopic(target.topicId), threadId) !== undefined
    );
  }

  muteThread(target: DeliveryTarget, threadId: string, now = Date.now()): void {
    this.database.connection
      .prepare(`
        INSERT INTO muted_threads (
          channel, chat_id, topic_id, codex_thread_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id, topic_id, codex_thread_id) DO UPDATE SET
          updated_at = excluded.updated_at
      `)
      .run(target.channel, target.chatId, normalizeTopic(target.topicId), threadId, now, now);
  }

  unmuteThread(target: DeliveryTarget, threadId: string): boolean {
    const result = this.database.connection
      .prepare(`
        DELETE FROM muted_threads
        WHERE channel = ? AND chat_id = ? AND topic_id = ? AND codex_thread_id = ?
      `)
      .run(target.channel, target.chatId, normalizeTopic(target.topicId), threadId);
    return result.changes === 1;
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

  selectAndWatchThread(
    channel: string,
    chatId: string,
    topicId: string | null | undefined,
    threadId: string,
    baseline: {
      readonly turnId?: string | null;
      readonly blockedGoalUpdatedAt?: number | null;
    } = {},
    now = Date.now(),
  ): void {
    this.database.transaction(() => {
      this.setActiveThread(channel, chatId, topicId, threadId, now);
      this.database.connection
        .prepare(`
          INSERT INTO thread_watches (
            channel, chat_id, topic_id, codex_thread_id,
            last_delivered_turn_id, last_delivered_goal_updated_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel, chat_id, topic_id) DO UPDATE SET
            codex_thread_id = excluded.codex_thread_id,
            last_delivered_turn_id = excluded.last_delivered_turn_id,
            last_delivered_goal_updated_at = excluded.last_delivered_goal_updated_at,
            updated_at = excluded.updated_at
        `)
        .run(
          channel,
          chatId,
          normalizeTopic(topicId),
          threadId,
          baseline.turnId ?? null,
          baseline.blockedGoalUpdatedAt ?? null,
          now,
        );
    });
  }

  getThreadWatch(
    channel: string,
    chatId: string,
    topicId?: string | null,
  ): ThreadWatchRecord | null {
    const row = this.database.connection
      .prepare(`
        SELECT * FROM thread_watches
        WHERE channel = ? AND chat_id = ? AND topic_id = ?
      `)
      .get(channel, chatId, normalizeTopic(topicId)) as WatchRow | undefined;
    return row ? mapWatch(row) : null;
  }

  listThreadWatches(channel = "telegram"): readonly ThreadWatchRecord[] {
    const rows = this.database.connection
      .prepare("SELECT * FROM thread_watches WHERE channel = ? ORDER BY updated_at")
      .all(channel) as unknown as WatchRow[];
    return rows.map(mapWatch);
  }

  acknowledgeWatchedState(
    target: DeliveryTarget,
    threadId: string,
    delivered: {
      readonly turnId?: string | null;
      readonly blockedGoalUpdatedAt?: number | null;
    },
    now = Date.now(),
  ): boolean {
    const result = this.database.connection
      .prepare(`
        UPDATE thread_watches
        SET last_delivered_turn_id = COALESCE(?, last_delivered_turn_id),
            last_delivered_goal_updated_at = COALESCE(?, last_delivered_goal_updated_at),
            updated_at = ?
        WHERE channel = ? AND chat_id = ? AND topic_id = ? AND codex_thread_id = ?
      `)
      .run(
        delivered.turnId ?? null,
        delivered.blockedGoalUpdatedAt ?? null,
        now,
        target.channel,
        target.chatId,
        normalizeTopic(target.topicId),
        threadId,
      );
    return result.changes === 1;
  }

  clearThreadWatch(channel: string, chatId: string, topicId?: string | null): boolean {
    const result = this.database.connection
      .prepare("DELETE FROM thread_watches WHERE channel = ? AND chat_id = ? AND topic_id = ?")
      .run(channel, chatId, normalizeTopic(topicId));
    return result.changes === 1;
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

  listActiveThreads(channel = "telegram"): readonly ActiveThreadRecord[] {
    const rows = this.database.connection
      .prepare("SELECT * FROM context_state WHERE channel = ? ORDER BY updated_at")
      .all(channel) as unknown as ActiveThreadRow[];
    return rows.map((row) => ({
      channel: row.channel,
      chatId: row.chat_id,
      topicId: row.topic_id || null,
      codexThreadId: row.active_codex_thread_id,
    }));
  }

  detach(channel: string, chatId: string, topicId?: string | null): boolean {
    return this.database.transaction(() => {
      const result = this.database.connection
        .prepare("DELETE FROM context_state WHERE channel = ? AND chat_id = ? AND topic_id = ?")
        .run(channel, chatId, normalizeTopic(topicId));
      this.clearThreadWatch(channel, chatId, topicId);
      return result.changes === 1;
    });
  }

  detachIfActiveThread(
    channel: string,
    chatId: string,
    topicId: string | null | undefined,
    threadId: string,
  ): boolean {
    return this.database.transaction(() => {
      const normalizedTopic = normalizeTopic(topicId);
      const result = this.database.connection
        .prepare(`
          DELETE FROM context_state
          WHERE channel = ? AND chat_id = ? AND topic_id = ?
            AND active_codex_thread_id = ?
        `)
        .run(channel, chatId, normalizedTopic, threadId);
      if (result.changes === 1) {
        this.database.connection
          .prepare("DELETE FROM thread_watches WHERE channel = ? AND chat_id = ? AND topic_id = ?")
          .run(channel, chatId, normalizedTopic);
      }
      return result.changes === 1;
    });
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

  private insertTerminalDelivery(
    target: DeliveryTarget,
    threadId: string,
    turnId: string,
    sourceKind: TerminalDeliverySource,
    sourceId: string | null,
    messageId: string,
    now: number,
  ): boolean {
    const result = this.database.connection
      .prepare(`
        INSERT INTO terminal_deliveries (
          channel, chat_id, topic_id, codex_thread_id, codex_turn_id,
          source_kind, source_id, message_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id, topic_id, codex_thread_id, codex_turn_id) DO NOTHING
      `)
      .run(
        target.channel,
        target.chatId,
        normalizeTopic(target.topicId),
        threadId,
        turnId,
        sourceKind,
        sourceId,
        messageId,
        now,
      );
    return result.changes === 1;
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

function mapWatch(row: WatchRow): ThreadWatchRecord {
  return {
    channel: row.channel,
    chatId: row.chat_id,
    topicId: row.topic_id || null,
    codexThreadId: row.codex_thread_id,
    lastDeliveredTurnId: row.last_delivered_turn_id,
    lastDeliveredGoalUpdatedAt: row.last_delivered_goal_updated_at,
    updatedAt: row.updated_at,
  };
}
