# ADR 0004: Explicit notification identity and Telegram user input

- Status: accepted
- Date: 2026-07-15

## Context

Telegram messages need to communicate whether a reply can safely continue a
Codex task. Explicit `$telegram-delivery` calls currently have no trusted
thread/turn identity, while completion events and watched-thread notifications
do. Codex turns started through the gateway can also issue the experimental
`item/tool/requestUserInput` app-server request.

## Decision

Represent notification identity as a required discriminated source:

- `bound_task` requires an exact Codex thread and turn identifier;
- `notification_only` carries no task identity and must say that replies do not
  continue a Codex task.

Bound Telegram messages render a compact task card with the outcome in the
heading, the agent's final message immediately below it, and project, short
thread identifier, and optional duration on one secondary context line.
Switch/Mute actions remain attached to the card. The
Telegram message is durably bound so direct replies route to the exact task.
Switch selects and watches the task for subsequent non-reply messages; it
does not start a new turn by itself.

Enable app-server's experimental API and handle only
`item/tool/requestUserInput`. A request is eligible for Telegram only when it
belongs to a turn started by this gateway and therefore has an exact active
Telegram context. Each question uses an in-memory random callback token with a
TTL. Buttons are checked against the authorized user, chat, topic, message,
thread, turn, request, and current question. Free-form answers must reply to the
exact question message. Tokens are consumed once and disappear on daemon
restart, app-server resolution, or turn completion.

Secret questions are rejected rather than sent to Telegram. Command, file, and
permission approvals remain unsupported; Telegram cannot widen the Codex
sandbox or grant `danger-full-access`.

## Consequences

- Users can distinguish resumable task messages from one-way notifications.
- `request_user_input` can be completed from Telegram for gateway-originated
  turns without introducing approval or permission escalation.
- Pending input cannot survive a daemon/app-server restart because the original
  JSON-RPC request connection no longer exists.
- Desktop turns owned by another app-server connection still receive only
  watched terminal-state notifications; their interactive requests are not
  intercepted by this gateway.
- Trusted automatic binding for generic `$telegram-delivery` remains a separate
  host-capability problem and is never inferred from cwd, title, or recency.
