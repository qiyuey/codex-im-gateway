# Implementation Plan

## 1. Objective

Build an open-source, local-first gateway that delivers selected Codex task
results to instant-messaging platforms. Messages with a trusted Codex source let
the user continue the exact thread by replying; messages without that identity
are explicitly notification-only.

The initial release targets Telegram. The core must remain independent of any
single IM platform so additional adapters can be added without changing Codex
thread routing or delivery state.

## 2. User experience

### 2.1 Completion delivery

When a selected or watched turn finishes, the gateway sends a message containing:

- schedule or task title;
- completion, failure, or blocked status;
- concise final agent message;
- workspace and thread label;
- stable short thread identifier;
- actions to continue, inspect, mute, or open the task.

Only a `bound_task` message may offer continue/reply semantics. A generic
`$telegram-delivery` result is `notification_only` until the host provides a
trusted thread/turn identity; cwd, title, and recency are never used to infer it.

### 2.2 Continue by replying

When the user replies to a bound completion message, the gateway resolves the
original IM message to its Codex thread and starts a new turn in that thread.
This mapping has higher priority than the currently selected thread. Replying to
a notification-only message produces an explicit routing error.

### 2.3 Switch between threads

The Telegram adapter will expose:

- `/threads` to browse recent and bound Codex threads;
- `/use <thread>` to select the active thread for the current chat or topic;
- `/current` to inspect the current binding;
- `/new` to create a new Codex thread;
- `/detach` to remove a topic-level default binding;
- `/stop` to interrupt or cancel queued work when supported.

Routing priority is fixed:

1. replied-to message binding;
2. Telegram topic binding;
3. explicit thread supplied by a command or button;
4. active thread for the current chat context;
5. request an explicit selection instead of guessing.

### 2.4 Scheduled-run grouping

A Telegram topic represents a long-lived schedule or project, not necessarily a
single Codex thread. Each notification retains its own thread binding. A plain
message in the topic targets the most recent bound thread, while replying to an
older notification targets that historical run.

## 3. Scope

### 3.1 MVP

- Receive Codex completion events through a local durable inbox.
- Read a completed thread and final turn through `codex app-server`.
- Deliver completion and failure notifications to one allowlisted Telegram
  private chat.
- Persist `Telegram message -> Codex thread/turn` mappings.
- Resume the mapped thread when the notification is replied to.
- Stream the follow-up agent response into an editable Telegram message.
- Render bound status cards with Continue/Mute actions and visibly label
  notification-only delivery.
- Answer non-secret `request_user_input` requests for gateway-originated turns
  with one-time Telegram cards.
- Browse and switch between threads.
- Retry failed deliveries without sending duplicates.
- Provide structured logs, health checks, and a local kill switch.

### 3.2 Post-MVP

- Telegram private-chat topics and supergroup topics.
- Approval buttons for supported app-server approval requests.
- Image and document input.
- Safe artifact delivery.
- Slack, Discord, and Feishu adapters.
- Generic outbound webhook and Apprise-compatible notification adapter.
- Multiple users and role-based workspace access.
- Optional web dashboard.

### 3.3 Non-goals for the MVP

- Reimplementing the Codex scheduler.
- Replacing the Codex desktop, CLI, or mobile clients.
- Reading `~/.codex/state_*.sqlite`, model caches, or transcript JSON as a stable
  integration API.
- Exposing app-server directly to the public internet.
- Enabling Telegram users to select or change the fixed permission mode.
- Acting as a public or multi-tenant chatbot.

## 4. Architecture

```text
Codex Scheduled task
        |
        v
$telegram-delivery skill
        |
        v
telegram_deliver MCP tool
        |
        v
Durable local event inbox (SQLite)
        |
        v
Dispatcher -------> IM adapter -------> Telegram
        ^                                  |
        |                                  | reply
        |                                  v
Thread service <---- router <--------- inbound update
        |
        v
codex app-server (stdio or Unix socket)
```

### 4.1 Explicit notification producer

Selected tasks explicitly invoke `$telegram-delivery`. After their work and QC
finish, the skill requires one `telegram_deliver` MCP call with the final title,
message, and absolute workspace path. The MCP server inserts a small notification
into the local inbox and returns once the durable enqueue succeeds.

The producer must:

- avoid network access;
- finish quickly;
- accept a stable per-run dedupe key when one is available;
- never block Codex because an IM platform is unavailable;
- remain inactive unless the task prompt explicitly requests delivery.

Lifecycle hooks are intentionally not used to infer delivery intent. They are a
better fit for universal cross-cutting behavior than for a subset of scheduled
tasks.

The current generic MCP call does not carry a trusted Codex source and therefore
enqueues `notification_only`. A future trusted producer may enqueue `bound_task`
only with an exact thread/turn pair supplied by the host, never by inference.

### 4.2 Dispatcher

The completion dispatcher leases exact thread/turn events, asks the thread
service for the canonical result, and durably binds the delivered message. The
explicit-notification dispatcher sends its self-contained result without
inventing a thread binding. Both record the platform message identifier before
marking delivery successful.

Delivery uses at-least-once processing with platform-aware idempotency and a
bounded exponential retry policy.

### 4.3 Thread service

The thread service owns all Codex protocol interaction:

- `thread/list` for discovery;
- `thread/read` with turns for completion rendering;
- `thread/resume` when attaching to an existing conversation;
- `turn/start` for a new follow-up;
- `turn/steer` only after explicit user intent;
- turn and item notifications for streaming;
- interruption and approval requests where supported.

Generated protocol schemas are pinned to the supported Codex version in CI.

### 4.4 Router

The router is deterministic and side-effect free. It resolves an inbound IM
message into exactly one Codex thread or returns an explicit selection error. It
must never silently fall back from a missing historical thread to a new thread.

### 4.5 IM adapters

Core services use a narrow interface:

```ts
interface ImAdapter {
  start(handler: InboundHandler): Promise<void>;
  sendCompletion(message: CompletionMessage): Promise<MessageRef>;
  sendStreamingPlaceholder(target: ReplyTarget): Promise<MessageRef>;
  updateMessage(ref: MessageRef, content: RenderedMessage): Promise<void>;
  answerAction(action: ActionResponse): Promise<void>;
}
```

Platform-specific identifiers stay inside adapter DTOs and persistence records.

## 5. Persistence model

SQLite is the MVP state store. Migrations are versioned and applied explicitly.

### 5.1 `outbound_notifications`

```text
id
idempotency_key (unique)
channel
cwd
title
message
source_kind: notification_only | bound_task
codex_thread_id (bound_task only)
codex_turn_id (bound_task only)
state: queued | leased | delivered | dead_letter
attempt_count
next_attempt_at
lease_expires_at
lease_token
platform_message_id
last_error
created_at
updated_at
```

### 5.2 `completion_events`

```text
id
idempotency_key (unique)
codex_thread_id
codex_turn_id
cwd
event_type
payload_json
state: queued | leased | delivered | failed | dead_letter
attempt_count
next_attempt_at
lease_expires_at
created_at
updated_at
```

### 5.3 `deliveries`

```text
id
completion_event_id
channel
chat_id
topic_id
message_id
delivery_state
created_at
updated_at
```

### 5.4 `message_bindings`

```text
channel
chat_id
message_id
codex_thread_id
codex_turn_id
schedule_key
created_at
```

The tuple `(channel, chat_id, message_id)` is unique.

### 5.5 `context_state`

```text
channel
chat_id
topic_id
active_codex_thread_id
updated_at
```

The tuple `(channel, chat_id, topic_id)` is unique. A null topic identifier is
normalized consistently so uniqueness works across SQLite versions.

### 5.6 `thread_metadata`

Stores user-facing aliases, workspace allowlist decisions, last-seen status, and
schedule associations. Codex remains authoritative for actual thread content.

## 6. Concurrency model

- Different Codex threads may run concurrently.
- Each thread has one serialized command queue by default.
- A reply received during an active turn is queued for the next turn.
- `turn/steer` requires an explicit action such as “add to current run.”
- A lease prevents two workers from delivering the same completion concurrently.
- Restart recovery returns expired leases to the queue.
- Streaming edits are debounced and respect platform rate limits.

## 7. Security model

Telegram access is equivalent to remote keyboard access to the allowed Codex
workspaces.

MVP requirements:

- accept only configured Telegram user and chat IDs;
- require a private chat by default;
- reject messages forwarded from or sent through unapproved contexts;
- keep the bot token out of repository files and logs;
- bind app-server only to stdio or a local Unix socket;
- force Codex execution to `danger-full-access` for every new and resumed gateway turn;
- never expose a Telegram control that changes the fixed permission mode;
- maintain an explicit workspace allowlist;
- redact secrets and cap notification/tool-output sizes;
- route Codex/results through Rich Markdown and control messages through unparsed plain text;
- use `lstat`, `realpath` containment, and no-follow file opening before sending
  any artifact;
- run the gateway as a dedicated, unprivileged OS user where practical;
- provide an immediate local stop command that disables inbound execution.

The threat model must cover compromised bot tokens, malicious group members,
prompt injection in scheduled inputs, symlink-based artifact exfiltration,
cross-thread routing errors, replayed callbacks, and accidental secret delivery.

## 8. Technology choices

- Runtime: Node.js 26 or later.
- Language: TypeScript 7 with strict type checking.
- Telegram library: grammY.
- Codex integration: generated app-server protocol types over stdio initially.
- Distribution: Codex plugin with explicit delivery and operating skills plus an
  MCP server; a foreground daemon owns long-lived delivery connections.
- Storage: Node's built-in `node:sqlite` with WAL mode and versioned migrations.
- Tests: Vitest for unit/integration tests.
- Formatting/linting: Biome.
- Packaging: registry package plus container image after MVP stability.
- Service management: launchd and systemd examples after the foreground daemon is
  proven.

### 8.1 Implementation status (2026-07-15)

Completed first-release implementation:

- Codex plugin manifest and bundled gateway skill;
- stable app-server TypeScript protocol snapshot generated by and pinned to
  `codex-cli 0.145.0-alpha.4`;
- stdio app-server client with initialization handshake, typed thread reads,
  canonical final-message extraction, thread resume, and JSON-RPC error/timeout
  handling;
- explicit `$telegram-delivery` skill with a single final-action contract;
- bundled stdio MCP server with health, event listing, explicit Telegram
  enqueue, and fallback completion enqueue tools;
- SQLite migrations covering explicit notifications, legacy events, deliveries,
  message bindings, context, and thread metadata;
- idempotent enqueue, atomic leases, expired-lease recovery, exponential retry,
  and dead-letter transitions;
- CLI health/event/recovery commands;
- grammY long-polling Telegram adapter with private user/chat authorization,
  strict HTML escaping, bounded messages, and forwarded-message rejection;
- durable outbound dispatcher, delivery/message bindings, retry recovery, and
  duplicate-delivery recognition;
- deterministic reply/topic/explicit/active routing with unknown-reply
  rejection;
- app-server turn start, streamed message editing, interruption, non-secret
  `request_user_input`, and per-thread serialized follow-up queues;
- project-first `/threads`, `/use`, `/current`, `/new`, `/mute`, `/detach`, and
  `/stop`;
- explicit `bound_task` versus `notification_only` identity, status cards, and
  Continue/Mute actions;
- realpath workspace allowlisting, forced full-access follow-ups, and a
  persistent local inbound kill switch;
- foreground daemon with structured metadata-only logs and graceful shutdown;
- TypeScript, formatting, unit-test, build, distribution smoke-test, and plugin
  validation workflows.

Deployment validation still requiring user credentials/environment:

- research a trusted host-provided source identity for generic explicit delivery;
- run one real Telegram scheduled-notification, watched-completion, reply, and
  `request_user_input` smoke test;
- add service-manager examples after the foreground daemon has been observed in
  normal use.

## 9. Delivery phases

### Phase 0: protocol and source-identity spikes

Deliverables:

- Generate app-server schemas from the installed Codex version.
- Verify `thread/read` returns the final scheduled turn by thread and turn ID.
- Verify a follow-up can resume that thread through app-server.
- Determine whether the host can provide trusted thread/turn identity to an
  explicit delivery producer; retain notification-only behavior otherwise.
- Record an architecture decision for stdio versus Unix socket lifecycle.

Exit criteria:

- One trusted bound event can be read through app-server and continued
  programmatically, while an unbound explicit result stays notification-only.

### Phase 1: reliable outbound notification

Deliverables:

- Project scaffolding and CI.
- SQLite schema and migrations.
- Explicit Skill/MCP notification producer and watched-thread monitor.
- Dispatcher with retry, lease, and dead-letter behavior.
- Telegram outbound adapter.
- Structured logs and health command.

Exit criteria:

- Completion, failure, and duplicate events are delivered correctly across
  process restarts and simulated Telegram failures.

### Phase 2: reply-to-thread loop

Deliverables:

- Telegram inbound long polling.
- User/chat/private-context authorization.
- Message bindings and deterministic router.
- app-server resume/start/stream integration.
- Same-thread serialization and cancellation.

Exit criteria:

- Replying to bound notifications from two different threads always continues
  the correct original thread, including after a gateway restart; unbound
  messages never acquire an inferred binding.

### Phase 3: thread navigation

Deliverables:

- Project-first `/threads`, `/use`, `/current`, `/new`, `/mute`, and `/detach`.
- Topic bindings and latest-run defaults.
- Thread aliases, workspace labels, pagination, and archived-thread handling.

Exit criteria:

- A user can move among at least ten threads without relying on raw IDs and
  without cross-thread context leakage.

### Phase 4: hardening and artifacts

Deliverables:

- Threat model and security test suite.
- One-time `request_user_input` UX, followed separately by approval UX where
  supported.
- Safe image/document input.
- Symlink-safe artifact delivery with type and size policy.
- Rate limits, callback replay protection, token rotation documentation, and
  operational runbooks.

Exit criteria:

- Security checklist passes and an external reviewer can reproduce the tests.

### Phase 5: adapter ecosystem and release

Deliverables:

- Stable adapter SDK.
- One additional two-way IM adapter.
- Generic outbound webhook adapter.
- Registry package, signed release artifacts, SBOM, and container image.
- SemVer compatibility policy for Codex protocol versions.

Exit criteria:

- A second adapter requires no changes to routing, Codex, or persistence core.

## 10. Test strategy

### Unit tests

- Routing precedence and ambiguity rejection.
- Telegram Rich Markdown rendering, limits, and plain-text control routing.
- Authorization and callback validation.
- Queue leases, retries, idempotency, and dead-letter transitions.
- Thread state machine and same-thread serialization.

### Integration tests

- Fake app-server JSON-RPC process with recorded fixtures.
- Telegram Bot API mock including rate limits and retries.
- SQLite restart and migration scenarios.
- Multiple notifications and replies across multiple threads/topics.
- Archived, deleted, busy, and unavailable threads.

### End-to-end tests

- Real local Codex smoke test gated by an explicit environment variable.
- Real Telegram test bot in a dedicated private test chat.
- Scheduled completion through notification and follow-up response.

CI must not require OpenAI or Telegram credentials for the default test suite.

## 11. Observability and operations

- JSON logs with event, delivery, channel, and short thread correlation IDs.
- No prompt, response body, token, or credential logging by default.
- `/health` or CLI health command covering database, app-server, and adapter
  status.
- Metrics for queued events, delivery latency, retry count, active turns, and
  dead letters.
- Graceful shutdown that stops inbound updates and finishes or releases leases.
- Backup and restore instructions for bindings and delivery state.

## 12. Open questions

- Can a generic explicit MCP delivery receive trusted host-supplied thread/turn
  identity without asking the model to provide it?
- Can interactive requests for Desktop-owned turns be routed safely across an
  app-server connection boundary?
- Which app-server approval methods are stable enough for the first release?
- Should app-server be persistent or started on demand for each operation?
- How should standalone recurring runs be associated with one schedule key?
- Which notification fields remain useful without exposing sensitive output?
- Should Slack use its official Codex integration where available rather than a
  custom adapter?

Open questions are resolved through small executable spikes and recorded as
architecture decision records before implementation proceeds.

## 13. MVP definition of done

The MVP is complete when:

- a Codex scheduled completion is captured without polling private Codex files;
- the notification is delivered exactly once from the user's perspective;
- replying to every bound message resumes the exact originating Codex thread,
  while notification-only messages never claim that guarantee;
- switching between multiple threads is deterministic and persistent;
- restart and transient network failure do not lose mappings or events;
- unauthorized Telegram users and chats cannot trigger Codex;
- no public listener or full-access execution is required;
- installation, configuration, recovery, and removal are documented;
- automated tests cover routing, persistence, retry, and authorization behavior.
