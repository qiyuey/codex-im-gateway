# Threat model

The gateway turns one Telegram identity into remote keyboard access for a
restricted set of local Codex workspaces.

## Protected assets

- local workspace files and commands;
- Codex thread content and final responses;
- Telegram bot credentials;
- durable message-to-thread bindings;
- queue and delivery state.

## Primary threats and controls

- **Compromised bot token:** private user/chat allowlists, no public listener,
  local persistent kill switch, documented token rotation.
- **Malicious group or forwarded content:** private-chat-only authorization and
  rejection of forwarded messages before routing.
- **Cross-thread confusion:** replied-message bindings take precedence;
  unknown replies are errors and never fall back.
- **Workspace escape:** realpath containment is checked both before outbound
  delivery and before every resumed IM turn; symlink escapes are tested.
- **Permission widening:** new and resumed IM turns force workspace-write with
  network access disabled; no IM command exposes danger-full-access.
- **Duplicate/replayed events:** unique producer idempotency keys, atomic lease
  tokens, durable delivery records, and stale-lease rejection.
- **Secret disclosure:** bot tokens and message bodies are absent from logs,
  error strings receive basic credential redaction, and Telegram HTML is
  escaped and size-capped.
- **Process crash:** SQLite WAL, versioned migrations, expired lease recovery,
  bounded retry, dead letters, and graceful shutdown.

## Residual risks

- Telegram `sendMessage` has no gateway-controlled idempotency key. A process
  crash after Telegram accepts a message but before SQLite records it can cause
  one duplicate notification on retry.
- Anyone controlling the allowlisted Telegram account can request changes in
  allowed workspaces within workspace-write permissions.
- The initial Stop hook cannot distinguish every scheduled-task surface from
  every interactive turn solely from the documented common hook envelope.
  Workspace authorization still applies to all captured events.
- Real credential-dependent Telegram and Desktop Scheduled smoke tests are not
  run in public CI.
