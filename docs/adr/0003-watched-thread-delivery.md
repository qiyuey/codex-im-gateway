# ADR 0003: Watch one selected thread per Telegram context

- Status: accepted
- Date: 2026-07-15

## Context

Selecting a Codex thread from Telegram originally changed only the routing
target for future inbound messages. Users reasonably expect the selected thread
to notify them when Desktop work reaches a terminal state, but globally
capturing every lifecycle event would be noisy and would bypass explicit
workspace and user intent.

## Decision

Persist at most one watched Codex thread for each Telegram chat/topic. Selecting
a thread also replaces the watch and records the latest terminal turn and
blocked-goal revision as a baseline. The daemon polls only persisted watches
through the public app-server `thread/read` and `thread/goal/get` methods, with a
five-second minimum interval.

Deliver one message for a new completed or failed turn, or a newly blocked
thread goal. Watched interrupted turns are silent. Codex can expose an active
Desktop turn as interrupted through a second app-server, even after commentary
has been emitted; these transient views have no duration and can later become a
completed turn with the same ID, so they are not acknowledged. Stable
interruptions are acknowledged without delivery to avoid repeated polling work.
Recheck the workspace allowlist before delivery and bind the Telegram message
to the watched thread so replies continue it. Telegram-originated turns retain
debounced incremental edits and acknowledge their final turn in the watch state
to prevent duplicate delivery.

`/mute` removes only the watch. `/detach` removes both active routing and the
watch. Selecting another thread replaces the prior watch.

## Consequences

- Selection has the intuitive meaning “use and watch this thread.”
- Desktop activity is not streamed; only terminal states leave the machine.
- No internal Codex database or transcript format is read.
- Polling introduces up to roughly five seconds of delivery latency.
- Explicit `$telegram-delivery` remains independent for scheduled or one-way
  results and does not become thread-bound automatically.
