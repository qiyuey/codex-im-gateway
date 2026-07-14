# ADR 0002: Use Skill plus MCP for explicit task-result delivery

- Status: accepted
- Date: 2026-07-15

## Context

Only selected Codex tasks and Scheduled tasks should deliver results to
Telegram. A lifecycle `Stop` hook applies across turns and cannot express this
business intent on its own. Adding prompt-inspection and per-turn opt-in state
to hooks would mix workflow selection, lifecycle observation, and delivery
routing.

## Decision

Use two Codex-facing layers with separate responsibilities:

- `$telegram-delivery` defines the explicit workflow contract and requires one
  final delivery action after task work and QC finish.
- `telegram_deliver` is an MCP tool that validates its bounded input and writes
  one durable outbound notification to SQLite.

The daemon owns workspace authorization, leasing, retries, dead letters,
Telegram transport, and platform message-ID persistence. No default lifecycle
hook captures ordinary task completions.

The task prompt must opt in by invoking `$telegram-delivery`. The prompt also
defines the notification title and required result fields. If the scheduler has
a stable run identifier, it is passed as the dedupe key for the logical run.

## Consequences

- Existing tasks and cron schedules remain silent unless their prompt opts in or
  the user separately watches their thread from Telegram.
- The model must complete one explicit MCP call, so the skill and prompt contract
  are part of delivery reliability.
- Enqueue success is distinct from eventual Telegram success; the daemon reports
  final state through its notification queue health and inspection commands.
- Workspace allowlisting remains mandatory and is checked by the daemon before
  any content leaves the machine.
- Explicit one-way notifications do not automatically create a reply binding to
  the originating Codex thread. Thread selection and continuation remain a
  separate Telegram capability.
