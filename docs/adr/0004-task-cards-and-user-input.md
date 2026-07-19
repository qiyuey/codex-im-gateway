# ADR 0004: Explicit notification identity and Telegram user input

- Status: accepted
- Date: 2026-07-15

## Context

Telegram messages need to communicate whether a reply can safely continue a
Codex task. Explicit `$telegram-delivery` calls may contain trusted request-level
Codex thread/turn metadata, while older or non-Codex MCP hosts may omit it.
Completion events and watched-thread notifications already carry exact identity.
Codex turns started through the gateway can also issue the experimental
`item/tool/requestUserInput` app-server request.

## Decision

Represent notification identity as a required discriminated source:

- `bound_task` requires an exact Codex thread and turn identifier;
- `bound_thread` requires an exact host-inherited Codex thread identifier and
  supports direct switching without turn-level duplicate coordination;
- `notification_only` carries no task identity and must say that replies do not
  continue a Codex task.

For `telegram_deliver`, accept identity only from host context outside the
model-visible arguments. Prefer matching top-level `threadId`, nested
`thread_id`, and nested `session_id` plus a valid nested `turn_id` for
`bound_task`. When request metadata is absent, accept the host-inherited
`CODEX_THREAD_ID` as `bound_thread`. Conflicting or invalid host identities
produce `notification_only`. Never infer identity from cwd, title, timing, or
recent activity.

Bound Telegram messages render a compact task card with the outcome in the
heading, the agent's final message immediately below it, and project, short
thread identifier, and optional duration on one secondary context line.
Switch/Mute actions remain attached to the card. Persistent card actions never
replace the result body: Switch acknowledges through the callback response, and
Mute updates only the inline keyboard. The
Telegram message is durably bound so direct replies route to the exact task.
Switch selects and watches the task for subsequent non-reply messages; it
does not start a new turn by itself.

Project/thread pickers and `request_user_input` questions are temporary
interaction messages. They may be replaced as the user advances, answers, or
reaches an expired/terminal state. Opening a picker from a persistent unbound
notification sends a separate picker and leaves the notification intact.

Enable app-server's experimental API and handle only
`item/tool/requestUserInput`. A request is eligible for Telegram only when it
belongs to a turn started by this gateway and therefore has an exact active
Telegram context. Each question uses an in-memory random callback token with a
TTL. Buttons are checked against the authorized user, chat, topic, message,
thread, turn, request, and current question. Free-form answers must reply to the
exact question message. Tokens are consumed once and disappear on daemon
restart, app-server resolution, or turn completion.

Secret questions are rejected rather than sent to Telegram. Command, file, and
permission approvals remain unsupported. Gateway turns already use the fixed
`danger-full-access` policy, and Telegram exposes no permission-mode control.

## Consequences

- Users can distinguish resumable task messages from one-way notifications.
- `request_user_input` can be completed from Telegram for gateway-originated
  turns without introducing approval or permission escalation.
- Pending input cannot survive a daemon/app-server restart because the original
  JSON-RPC request connection no longer exists.
- Desktop turns owned by another app-server connection still receive only
  watched terminal-state notifications; their interactive requests are not
  intercepted by this gateway.
- Trusted automatic binding degrades to `bound_thread` when only the inherited
  Codex thread is available, and to `notification_only` when host identity is
  absent or conflicting. It is never inferred from cwd, title, or recency.
