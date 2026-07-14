# Architecture

## Context

Codex Desktop and Scheduled tasks already provide local project access, thread
context, worktrees, sandbox behavior, and optional scheduling. This project
does not duplicate those capabilities. It adds a reliable IM delivery boundary
and a way to resume the originating Codex thread.

## Core invariant

Every inbound IM message must resolve to zero or one Codex thread before any
Codex operation starts. Ambiguity is an error.

An active-thread pointer is only a convenience. The durable binding on a replied
message is authoritative.

Outbound messages have a required identity kind. `bound_task` includes an exact
thread/turn pair and may promise reply-to-continue; `notification_only` contains
no source identity and must not imply that a reply resumes Codex. Identity is
never inferred from cwd, title, recency, or the active-thread pointer.

## Components

### Codex plugin package

The repository is the plugin root. The plugin bundles two Codex-facing
surfaces while keeping the long-running gateway daemon independent:

```text
Codex plugin
├── Skills ──────────> explicit workflow and safe operating instructions
└── MCP server ──────> health, inspection, durable explicit enqueue
                              |
                              v
                       gateway daemon
                       ├── notification dispatcher
                       ├── watched-thread monitor
                       ├── app-server client
                       └── Telegram adapter
```

The MCP server writes only to the gateway's private data directory, never to the
installed plugin cache. Long-lived Telegram polling does not run inside the MCP
stdio process.

### Explicit notification producer

The `$telegram-delivery` skill defines an opt-in workflow contract. After the
task and its verification finish, Codex calls `telegram_deliver` once with a
self-contained title, result message, and absolute workspace path. The MCP tool
only inserts a local notification; it does not call Telegram.

The result message contract is Rich Markdown. Final task results, watched Codex
turns, and streamed/final Codex content use Telegram Rich Messages, preserving
headings, lists, tables, links, quotes, and code. Control prompts, command
feedback, and errors use unparsed plain text. Normal business paths do not use
Telegram HTML or MarkdownV2.

This boundary is intentionally explicit. A lifecycle hook is not used to infer
delivery intent, so ordinary Desktop turns and Scheduled turns remain silent
unless the user separately watches their thread from Telegram.
When a scheduler provides a stable run identifier, the caller can supply it as
a dedupe key; otherwise the MCP server assigns a unique enqueue identifier.

### Event store

SQLite stores explicit outbound notifications, legacy completion events,
delivery attempts, message bindings, active context, one watched thread per
chat/topic, and user-facing thread metadata. Codex retains ownership of thread
content.

The implementation uses Node 26's built-in synchronous SQLite API. Migrations
run atomically, foreign keys and defensive mode are enabled, and WAL mode allows
the short-lived hook/MCP processes to coexist with the future daemon. An event
lease is guarded by an unguessable token so a stale worker cannot acknowledge a
newer lease.

### Codex protocol client

The client speaks the generated `codex app-server` protocol over a local
transport. It does not read Codex's internal databases or transcript files.

The implementation spawns the stdio transport, performs the required
`initialize`/`initialized` handshake, correlates concurrent JSON-RPC requests,
and uses the pinned generated types for `thread/read` and `thread/resume`. The
canonical completion result is selected by the event's exact turn identifier;
missing turns are errors rather than fallback candidates. Follow-ups resume the
thread, force a workspace-write sandbox rooted at its allowed workspace, start a
turn, and consume typed delta/completion notifications.

For turns started through this connection, the client also accepts the
experimental `item/tool/requestUserInput` server request. The Telegram bridge
keeps the original JSON-RPC request on the same connection, presents only
non-secret questions, and sends the typed answer response after a one-time
callback or exact message reply. Other server-initiated approvals remain
unsupported.

The watched-thread monitor polls only persisted watches through `thread/read`
and `thread/goal/get`, with a five-second minimum interval. Selection records the
latest terminal turn and blocked-goal revision as a baseline, so historical
results are not replayed. A new completed, failed, non-empty interrupted, or
goal-blocked state is delivered once and bound back to its thread. Empty
interruptions are neither delivered nor acknowledged, allowing a resumed turn
with the same ID to deliver its eventual result. Workspace authorization is
rechecked before each delivery.

### Router

The router applies reply, topic, explicit selection, and active-context routing
in that order. It returns a typed decision that is logged using non-sensitive
correlation identifiers.

### Adapter boundary

Adapters translate channel-neutral notifications and inbound events to and from
Telegram, Slack, or other platforms. Platform markup, rate limits, callback
tokens, and message identifiers do not leak into the Codex service.

The Telegram adapter uses grammY long polling. The service authenticates the
private user/chat before routing, rejects forwarded messages, and schedules
different threads concurrently while serializing each individual thread.
Input callbacks additionally bind an opaque in-memory token to the exact chat,
topic, Telegram message, Codex thread/turn, request, and current question. They
expire on TTL, request resolution, turn completion, or process restart.

### Local kill switch

The CLI persists an `inbound.disabled` marker in the private data directory.
The daemon checks it before every inbound Telegram action. Disabling inbound
execution does not discard completion events or prevent outbound delivery, and
the MCP server can inspect but cannot remotely change this state.

## Trust boundaries

```text
Untrusted IM network
        |
        v
Authentication and routing boundary
        |
        v
Gateway process and local database
        |
        v
Local app-server transport
        |
        v
Codex sandbox and allowed workspaces
```

The IM user is authorized to request work only in explicitly allowed workspaces.
Authorization of a user does not imply permission to widen the Codex sandbox.

## Important failure behavior

- Delivery failure leaves a notification or completion event retryable.
- Explicit notification delivery rejects workspaces outside the configured
  allowlist without sending content.
- Unknown reply bindings produce an error and do not use the active thread.
- Notification-only messages are not stored as reply bindings.
- Secret input requests and unsupported app-server approvals fail closed.
- Missing Codex threads remain visible as unavailable historical notifications.
- Busy threads queue follow-ups unless the user explicitly chooses steering.
- Adapter shutdown stops accepting new inbound work before Codex connections are
  terminated.
- Duplicate explicit notification dedupe keys reuse the existing queue record.

## Decision records

Implemented decisions:

1. plugin packaging and process separation;
2. explicit Skill plus MCP task-result delivery.
3. single watched-thread terminal delivery per Telegram chat/topic.

Future ADR candidates include app-server lifecycle, SQLite migration strategy,
thread concurrency, adapter API stability, and artifact containment.
