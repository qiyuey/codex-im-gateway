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
repository as a local Codex plugin through a trusted local marketplace. Start a
new Codex task after installing or refreshing the plugin so its skills and MCP
server load.

Telegram delivery is explicit. A task prompt must invoke `$telegram-delivery`
and require it as the final workflow step. The task workspace must be within
`CODEX_IM_GATEWAY_ALLOWED_WORKSPACES`; otherwise the daemon moves the notification
to dead letter without sending it. Ordinary tasks and Scheduled tasks do not
produce notifications automatically unless their thread is selected and watched
from Telegram.

Selecting a thread with `/threads`, `/use`, or `/new` also watches it. The daemon
checks the watched thread about every five seconds and sends only new terminal
states. `/mute` removes the watch while keeping the selected thread; selecting a
thread again re-enables it. `/detach` clears both selection and watch.

Bound completion messages show Continue/Mute task actions. Explicit
`$telegram-delivery` messages have no trusted thread identity and are labeled
**Notification only**. For turns started from Telegram, non-secret
`request_user_input` questions appear as expiring one-time cards. Reply to the
exact card for a free-form answer. Restarting the daemon invalidates pending
cards because their app-server JSON-RPC connection has ended.

Run the foreground daemon with:

```bash
pnpm start
```

## Health and emergency stop

```bash
node dist/cli.js health
node dist/cli.js app-server-health
node dist/cli.js disable
node dist/cli.js enable
```

`disable` is persistent and takes effect before the next inbound Telegram
action. It does not stop outbound completion delivery. Use `SIGINT` or `SIGTERM`
to stop the entire foreground daemon gracefully.

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
