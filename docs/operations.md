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
repository as a local Codex plugin through a trusted local marketplace, then
review and trust the bundled `Stop` hook in Codex. Start a new Codex task after
installing or refreshing the plugin so its hook, skill, and MCP server load.
The bundled `Stop` hook applies to ordinary Codex Desktop turns as well as
Scheduled turns. Review and trust the plugin hook once in a new Codex task;
Codex skips untrusted command hooks.

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
