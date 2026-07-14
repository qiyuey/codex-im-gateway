# ADR 0001: Package the gateway as a Codex plugin

- Status: superseded by ADR 0002 for outbound task-result production
- Date: 2026-07-14

## Context

The gateway needs a trusted Codex turn-completion producer, local operational
tools, and a distributable workflow. It also needs a long-running process for
Telegram polling and app-server streaming. A hook alone cannot safely own
network delivery, while a standalone daemon alone cannot reliably observe
Codex turn completion through a stable public boundary.

## Decision

Package the project as a Codex plugin with:

- a default-discovered `Stop` hook that only inserts a durable local event;
- a bundled stdio MCP server for health, inspection, and explicit fallback
  enqueue operations;
- a skill that tells Codex how to operate the gateway safely;
- a separately launched foreground daemon for app-server and IM connections.

Use `PLUGIN_ROOT` only for installed, read-only assets and `PLUGIN_DATA` for the
SQLite database and future configuration state. Build TypeScript entry points
into bundled JavaScript so plugin installation does not require dependency
installation or lifecycle scripts.

The initial runtime baseline is Node.js 26 and TypeScript 7. SQLite uses the
built-in `node:sqlite` module to avoid distributing a native addon.

## Consequences

- Plugin installation can provide the hook, tools, and workflow as one unit.
- Completion capture stays fast and independent of Telegram availability.
- The daemon lifecycle remains explicit and can later be managed by launchd or
  systemd without coupling it to an MCP connection.
- Local marketplace testing requires `pnpm build` before installing or
  refreshing the plugin copy.
- The `Stop` hook reports that a turn stopped; app-server remains authoritative
  for the canonical final status and response content.
