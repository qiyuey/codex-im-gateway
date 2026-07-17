export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial_state",
    sql: `
      CREATE TABLE completion_events (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('completed', 'failed', 'blocked')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'delivered', 'dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        lease_token TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((state = 'leased') = (lease_expires_at IS NOT NULL AND lease_token IS NOT NULL))
      ) STRICT;

      CREATE INDEX completion_events_ready_idx
        ON completion_events (state, next_attempt_at, created_at);
      CREATE INDEX completion_events_lease_idx
        ON completion_events (state, lease_expires_at);

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        completion_event_id TEXT NOT NULL REFERENCES completion_events(id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        message_id TEXT,
        delivery_state TEXT NOT NULL CHECK (delivery_state IN ('pending', 'sent', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (completion_event_id, channel, chat_id, topic_id)
      ) STRICT;

      CREATE TABLE message_bindings (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        schedule_key TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id, message_id)
      ) STRICT;

      CREATE TABLE context_state (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        active_codex_thread_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id, topic_id)
      ) STRICT;

      CREATE TABLE thread_metadata (
        codex_thread_id TEXT PRIMARY KEY,
        alias TEXT,
        workspace TEXT,
        workspace_allowed INTEGER NOT NULL DEFAULT 0 CHECK (workspace_allowed IN (0, 1)),
        schedule_key TEXT,
        last_seen_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 2,
    name: "explicit_outbound_notifications",
    sql: `
      CREATE TABLE outbound_notifications (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL CHECK (channel IN ('telegram')),
        cwd TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'leased', 'delivered', 'dead_letter')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        next_attempt_at INTEGER NOT NULL,
        lease_expires_at INTEGER,
        lease_token TEXT,
        platform_message_id TEXT,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK ((state = 'leased') = (lease_expires_at IS NOT NULL AND lease_token IS NOT NULL))
      ) STRICT;

      CREATE INDEX outbound_notifications_ready_idx
        ON outbound_notifications (state, next_attempt_at, created_at);
      CREATE INDEX outbound_notifications_lease_idx
        ON outbound_notifications (state, lease_expires_at);
    `,
  },
  {
    version: 3,
    name: "watched_threads",
    sql: `
      CREATE TABLE thread_watches (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        codex_thread_id TEXT NOT NULL,
        last_delivered_turn_id TEXT,
        last_delivered_goal_updated_at INTEGER,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id, topic_id)
      ) STRICT;

      CREATE INDEX thread_watches_thread_idx
        ON thread_watches (codex_thread_id);
    `,
  },
  {
    version: 4,
    name: "explicit_notification_source",
    sql: `
      ALTER TABLE outbound_notifications
        ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'notification_only'
        CHECK (source_kind IN ('notification_only', 'bound_task'));
      ALTER TABLE outbound_notifications ADD COLUMN codex_thread_id TEXT;
      ALTER TABLE outbound_notifications ADD COLUMN codex_turn_id TEXT;

      CREATE TRIGGER outbound_notification_source_insert_check
      BEFORE INSERT ON outbound_notifications
      WHEN (NEW.source_kind = 'bound_task') !=
           (NEW.codex_thread_id IS NOT NULL AND NEW.codex_turn_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid outbound notification source');
      END;

      CREATE TRIGGER outbound_notification_source_update_check
      BEFORE UPDATE OF source_kind, codex_thread_id, codex_turn_id ON outbound_notifications
      WHEN (NEW.source_kind = 'bound_task') !=
           (NEW.codex_thread_id IS NOT NULL AND NEW.codex_turn_id IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid outbound notification source');
      END;
    `,
  },
  {
    version: 5,
    name: "terminal_delivery_identity_and_thread_mutes",
    sql: `
      CREATE TABLE terminal_deliveries (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        codex_thread_id TEXT NOT NULL,
        codex_turn_id TEXT NOT NULL,
        source_kind TEXT NOT NULL
          CHECK (
            source_kind IN ('completion_event', 'explicit_notification', 'telegram_turn', 'watch')
          ),
        source_id TEXT,
        message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id, topic_id, codex_thread_id, codex_turn_id)
      ) STRICT;

      CREATE TABLE muted_threads (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        topic_id TEXT NOT NULL DEFAULT '',
        codex_thread_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (channel, chat_id, topic_id, codex_thread_id)
      ) STRICT;
    `,
  },
  {
    version: 6,
    name: "versioned_ingress_metadata",
    sql: `
      ALTER TABLE completion_events
        ADD COLUMN ingress_producer TEXT NOT NULL DEFAULT 'legacy'
        CHECK (ingress_producer IN ('stop_hook', 'mcp', 'internal', 'legacy'));
      ALTER TABLE completion_events
        ADD COLUMN producer_version TEXT NOT NULL DEFAULT '0.1.0';
      ALTER TABLE completion_events
        ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version > 0);

      ALTER TABLE outbound_notifications
        ADD COLUMN ingress_producer TEXT NOT NULL DEFAULT 'legacy'
        CHECK (ingress_producer IN ('stop_hook', 'mcp', 'internal', 'legacy'));
      ALTER TABLE outbound_notifications
        ADD COLUMN producer_version TEXT NOT NULL DEFAULT '0.1.0';
      ALTER TABLE outbound_notifications
        ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version > 0);
    `,
  },
  {
    version: 7,
    name: "one_shot_manual_route",
    sql: `
      ALTER TABLE context_state
        ADD COLUMN route_next_message INTEGER NOT NULL DEFAULT 0
        CHECK (route_next_message IN (0, 1));
    `,
  },
] as const;
