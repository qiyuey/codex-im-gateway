# ADR 0005: Deliver every top-level turn without changing active routing

- Status: accepted
- Date: 2026-07-17
- Supersedes: ADR 0002's opt-in-only default and ADR 0003's selected-thread-only completion scope

## Context

The active Telegram task answers one routing question: where should a new
unreplied message go? It must not also decide which unrelated Codex tasks are
observable. Users need every allowed top-level Codex turn to produce a result
card, then explicitly choose **Switch to this task** when they want subsequent
Telegram messages routed there.

Codex offers two completion discovery paths. A plugin `Stop` hook observes every
top-level turn, while the watched-thread monitor can observe the selected task
through app-server polling. Explicit `telegram_deliver` calls and
Telegram-originated streamed turns can also represent the same terminal turn.
Without a shared identity these producers can send duplicate cards.

## Decision

Bundle a `Stop` command hook that validates the documented hook envelope and
writes only a small, idempotent event to the gateway SQLite database. Stop
events with no transcript path are internal or ephemeral sessions rather than
persisted, user-visible tasks and are ignored. The hook does not read transcripts,
call Telegram, or fail the Codex turn. `SubagentStop` is not registered, so
subagent completions do not create standalone cards.

Keep the daemon as the only network sender. It resolves the exact thread and
turn through app-server, checks the workspace allowlist, and retains the
existing lease, retry, and dead-letter behavior.

Scheduled automation threads are identified from Codex's trusted
`threadSource: "automation"` metadata. Their automatic completion events are
acknowledged without delivery by default. A user explicitly selecting the task
from Telegram creates a watch and opts that task into automatic delivery;
explicit `$telegram-delivery` notifications remain independent and continue to
be delivered.

Record every delivered terminal result under one channel-scoped identity:

```text
(channel, chat, topic, codex_thread_id, codex_turn_id)
```

Completion events, bound explicit notifications, Telegram-originated streamed
results, and watched-thread polling all consult this ledger. The first producer
delivers; later producers acknowledge their queue or watch state without
sending again. Bound explicit notifications are drained before automatic
completion events so intentional custom result content wins when both exist.

Persist active routing, reply bindings, terminal delivery identity, and
per-thread mute preferences independently:

- receiving a completion card creates a durable reply binding but never changes
  the active task;
- **Switch to this task**, `/use`, `/threads`, and `/new` change active routing;
- **Mute this task** and `/mute` suppress future automatic completion cards for
  only that task; `/unmute` restores them;
- the selected-thread monitor remains as a current-task fallback and supplies
  blocked-goal notifications, but shares the terminal ledger with the hook.

## Consequences

- Every allowed top-level interactive Desktop and CLI turn is eligible for one
  Telegram result card without prompt opt-in. Scheduled turns are silent unless
  explicitly selected from Telegram or delivered through `$telegram-delivery`.
- Selecting a task affects message routing only; background task completions do
  not steal the active Telegram context.
- Hook execution remains local, fast, durable, and independent of Telegram
  availability.
- Hook trust is still enforced by Codex. A newly changed hook is skipped until
  reviewed, while the current selected-task monitor remains a limited fallback.
- Explicit notification-only messages remain independent business messages and
  are not deduplicated against a Codex turn because they intentionally have no
  trusted turn identity.
