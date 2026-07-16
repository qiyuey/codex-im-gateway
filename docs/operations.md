# Operations

## Install and configure

The first release runs from a source checkout and requires Node.js 26 and an
installed, authenticated Codex CLI compatible with the checked-in protocol
snapshot.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
cp .env.example .env
```

Edit `.env` locally. Never commit it. Set a Telegram BotFather token, the one
allowed private user/chat ID, and absolute workspace roots. Install the built
repository as a local Codex plugin through a trusted local marketplace. Run
`/hooks` in Codex, review the plugin-bundled Stop hook, and trust that exact
definition. Codex skips new or changed plugin hooks until they are trusted, so
an untrusted hook produces no completion event even when the daemon and
Telegram connection are healthy. Start a new Codex task after installing or
refreshing the plugin so its skills and MCP server load. Re-open `/hooks` after
renaming the plugin or changing its hook definition.

Set `CODEX_IM_LANGUAGE=zh` for Chinese gateway UI or
`CODEX_IM_LANGUAGE=en` for English. Chinese is the default. The setting
applies to Telegram command descriptions, buttons, task cards, pickers, input
requests, and gateway status/error messages after the daemon restarts. Codex
answers and caller-provided notification titles/messages are not translated.

Every top-level Codex turn is captured automatically by the plugin `Stop` hook.
The task workspace must be within `CODEX_IM_ALLOWED_WORKSPACES` or the
dedicated `CODEX_IM_TASKS_WORKSPACE` used for Tasks without a project;
otherwise the daemon moves its completion event to dead letter without sending
it. Use `$telegram-delivery` only when a workflow needs a custom explicit result
message; a bound explicit result is deduplicated against the automatic card for
the same turn.

Selecting a thread with `/threads`, `/use`, or `/new` changes where new Telegram
messages are routed. It does not limit notifications from other tasks. The
daemon also checks the selected thread about every five seconds as a fallback
and for blocked-goal state; the unified delivery ledger prevents duplicate
cards. `/mute` suppresses automatic completion notifications for the current
task, `/unmute` restores them, and `/detach` only clears the active selection.

Bound completion messages show **切换到此任务** / **停止此任务通知** actions. These
actions preserve the result text; stopping notifications updates only the
buttons. Explicit
`$telegram-delivery` messages automatically bind to the originating task when
Codex supplies consistent request-level thread and turn metadata. If that
metadata is unavailable or invalid, the message is labeled
**这是一条独立通知，未关联可继续对话的 Codex 任务** and its **选择任务** action
opens the workspace-filtered project picker without implying an exact task
binding. Automatically bound notifications use **切换到此任务**. For
turns started from Telegram, non-secret
`request_user_input` questions appear as expiring one-time cards. Reply to the
exact card for a free-form answer. Restarting the daemon invalidates pending
cards because their app-server JSON-RPC connection has ended.

For a normal macOS installation, install and start the supervised launchd service from the runtime
checkout:

```bash
node dist/cli.js service install --runtime-root "$PWD" --env-file "$PWD/.env"
node dist/cli.js service status
node dist/cli.js doctor
```

Use the foreground daemon only during development:

```bash
pnpm start
```

## Health and emergency stop

```bash
node dist/cli.js health
node dist/cli.js doctor
node dist/cli.js app-server-health
node dist/cli.js service status
node dist/cli.js service restart
node dist/cli.js disable
node dist/cli.js enable
```

`disable` is persistent and takes effect before the next inbound Telegram
action. It does not stop outbound completion delivery. Use `SIGINT` or `SIGTERM`
to stop the entire foreground daemon gracefully.

`health` always prints structured state. It returns `status: "ok"` only when a fresh heartbeat
belongs to a live, protocol-compatible daemon; otherwise it returns `status: "degraded"`. `doctor`
prints the same evidence and exits non-zero when degraded, making it suitable for service checks.

## Queue recovery

Inspect retry and dead-letter state without printing event payloads:

```bash
node dist/cli.js events --state queued
node dist/cli.js events --state dead_letter
node dist/cli.js notifications --state queued
node dist/cli.js notifications --state dead_letter
node dist/cli.js recover
```

Expired leases recover automatically before the next lease. `recover` performs
the same operation immediately for operational inspection.

## Backup and restore

Stop the daemon before backup. Copy the complete private data directory,
including `gateway.sqlite` and any `-wal`/`-shm` sidecars. Restore the complete
directory while the daemon is stopped and retain owner-only permissions. Codex
remains authoritative for thread content; this backup contains gateway queue,
delivery, and binding state only.

## Rotate or remove

To rotate a compromised bot token, disable inbound execution, stop the daemon,
revoke the token through BotFather, replace the local environment value, and
restart before re-enabling inbound actions.

To remove the gateway, disable and stop it, uninstall the plugin from Codex,
then delete the private data directory only after any desired backup. Removing
the gateway does not delete Codex threads or Telegram messages.
