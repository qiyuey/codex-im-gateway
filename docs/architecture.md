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

## Components

### Codex plugin package

The repository is the plugin root. The plugin bundles three Codex-facing
surfaces while keeping the long-running gateway daemon independent:

```text
Codex plugin
├── Stop hook ────────> plugin data / SQLite inbox
├── Gateway skill ───> safe operating instructions
└── MCP server ──────> health, inspection, explicit fallback enqueue
                              |
                              v
                       gateway daemon
                       ├── app-server client
                       └── Telegram adapter
```

Codex supplies `PLUGIN_ROOT` for immutable installed files and `PLUGIN_DATA` for
writable state. The hook and MCP server never write to the installed plugin
cache. Long-lived Telegram polling does not run inside the hook or MCP stdio
process.

### Event producer

A trusted Codex hook or plugin emits a small local completion event. It is
isolated from network delivery so Codex completion is not coupled to an IM
platform's availability.

The bundled `Stop` hook is the primary producer for ordinary Desktop turns and
Scheduled turns. It reads the documented JSON hook envelope from stdin, uses
`session_id:turn_id` as its idempotency key, and emits no stdout on success. The
hook explicitly uses the gateway's shared user data directory so the external
daemon observes the same durable inbox as the installed plugin. Any producer
failure is reduced to a generic stderr message and a successful hook exit so it
cannot fail the Codex turn.

### Event store

SQLite stores completion events, delivery attempts, message bindings, active
context, and user-facing thread metadata. Codex retains ownership of thread
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

- Delivery failure leaves an event retryable.
- Unknown reply bindings produce an error and do not use the active thread.
- Missing Codex threads remain visible as unavailable historical notifications.
- Busy threads queue follow-ups unless the user explicitly chooses steering.
- Adapter shutdown stops accepting new inbound work before Codex connections are
  terminated.
- Duplicate completion events reuse the existing delivery record.

## Planned decision records

Implementation should add ADRs for:

1. completion producer and Scheduled hook compatibility;
2. app-server transport and lifecycle;
3. SQLite library and migration strategy;
4. thread concurrency and steering behavior;
5. adapter API stability;
6. artifact containment and file-opening policy.
