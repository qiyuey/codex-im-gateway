# Codex IM Gateway

A local-first notification and conversation gateway between Codex Desktop or
scheduled tasks and instant-messaging platforms.

The project is intended to support this workflow:

1. A Codex Desktop or scheduled turn completes.
2. The gateway delivers a concise result to Telegram or another IM channel.
3. A reply to that notification resumes the exact Codex thread that produced it.
4. Multiple Codex threads can be browsed and used without leaking context between
   workspaces or conversations.

The first pre-alpha implementation is complete. The repository is a Codex
plugin with a bundled `Stop` hook, durable completion inbox, MCP server, Telegram
daemon, exact reply routing, thread navigation, and app-server streaming.

## Status

- Maturity: implementation / pre-alpha
- Execution sources: Codex Desktop tasks and Scheduled tasks
- Codex integration target: `codex app-server`
- First IM adapter: Telegram Bot API
- Future adapters: Slack, Discord, Feishu, and generic webhooks

## Runtime

- Node.js 26 or later
- TypeScript 7
- pnpm 11 or later
- Node's built-in `node:sqlite` with WAL mode
- Codex plugin packaging with a bundled hook, skill, and MCP server

## Development

```bash
pnpm install
pnpm check
pnpm build
```

## Run the first release

1. Copy `.env.example` to `.env` and provide a BotFather token, the allowed
   Telegram user/chat ID, and one or more absolute allowed workspace paths.
   Separate multiple workspace paths with the operating system path delimiter.
2. Build the plugin and review/trust its bundled `Stop` hook in Codex.
3. Start the foreground daemon:

```bash
pnpm start
```

The daemon uses Telegram long polling and a private stdio app-server process; it
does not open a public listener. Telegram accepts only the configured user and
chat in a private, non-forwarded context.

Supported Telegram commands:

- `/threads` — list recent threads in allowed workspaces.
- `/use <id-prefix>` — select one unambiguous thread.
- `/current` — show the selected thread.
- `/new` — create a workspace-write thread in the first allowed workspace.
- `/detach` — clear the current context binding.
- `/stop` — interrupt the active turn and cancel queued follow-ups.

The daemon registers these commands with Telegram at startup and enables the
commands menu button on the left side of the private-chat input field.

Plain messages use the active thread. Replies always use the durable binding of
the replied-to Telegram message; an unknown reply never falls back to the active
thread.

The checked-in app-server bindings were generated from
`codex-cli 0.145.0-alpha.4`. Regenerate them intentionally with
`pnpm protocol:generate` when upgrading the supported Codex protocol.

The build creates self-contained entry points in `dist/`. Build before testing
the plugin from a local marketplace because Codex loads the installed plugin
copy; it does not compile TypeScript source for the plugin.

Useful local commands:

```bash
node dist/cli.js health
node dist/cli.js app-server-health
node dist/cli.js disable
node dist/cli.js enable
node dist/cli.js events --state queued
node dist/cli.js recover
```

`disable` is the local emergency kill switch. It immediately blocks inbound IM
execution while preserving queued outbound notifications and persisted state.

By default, runtime state is stored in
`~/.local/share/codex-im-gateway/gateway.sqlite`. An installed plugin uses the
writable directory supplied by Codex through `PLUGIN_DATA`. For development and
tests, `CODEX_IM_GATEWAY_DATA_DIR` overrides both locations.

## Plugin components

- `.codex-plugin/plugin.json`: plugin identity and install-surface metadata.
- `hooks/hooks.json`: turn-scoped `Stop` producer. It only writes a local event
  and never performs network delivery.
- `.mcp.json`: local stdio MCP server exposing health, event listing, and an
  explicit fallback enqueue tool.
- `skills/gateway/SKILL.md`: safe operating workflow for Codex.

Credential-free tests use fake Telegram and app-server transports. Real
Telegram, Desktop, and Scheduled runs remain deployment smoke tests and are
intentionally not required by CI.

## Design principles

- Codex remains the source of truth for threads and turns.
- A Telegram reply is routed by its original message binding before any active
  thread selection is considered.
- Completion delivery is durable, retryable, and idempotent.
- Hooks enqueue local events; they do not perform network delivery inline.
- The gateway defaults to private chats and least-privilege Codex execution.
- Internal Codex SQLite files and transcript formats are not treated as APIs.

## Documentation

- [Implementation plan](PLAN.md)
- [Architecture](docs/architecture.md)
- [Plugin packaging ADR](docs/adr/0001-codex-plugin-packaging.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

[MIT](LICENSE)
