# Threat model

The gateway turns one Telegram identity into full remote Codex execution access
on the host, while limiting selectable thread working directories to configured
workspaces.

## Protected assets

- local workspace files and commands;
- Codex thread content and final responses;
- Telegram bot credentials;
- durable message-to-thread bindings;
- queue and delivery state.

## Primary threats and controls

- **Compromised bot token:** adapter-level and service-level checks require the
  sole configured user ID in its matching private chat; there is no public
  listener, and a local persistent kill switch plus documented token rotation
  limit exposure.
- **Malicious group or forwarded content:** private-chat-only authorization and
  rejection of forwarded messages before routing.
- **Cross-thread confusion:** replied-message bindings take precedence;
  unknown replies are errors and never fall back.
- **Workspace escape:** realpath containment is checked both before outbound
  delivery and before every resumed IM turn; symlink escapes are tested.
- **Permission mode drift:** new and resumed IM turns explicitly force
  `danger-full-access`; no IM command can alter the configured mode.
- **Duplicate/replayed events:** unique producer idempotency keys, atomic lease
  tokens, durable delivery records, and stale-lease rejection.
- **Replayed input actions:** random one-time callback tokens are scoped to the
  authorized user/chat, topic, message, thread, turn, request, and question;
  they expire on resolution, completion, timeout, or daemon restart.
- **Unintended task disclosure:** outbound task-result delivery requires an
  explicit `$telegram-delivery` workflow step and remains constrained by the
  workspace allowlist; no lifecycle hook captures every completed turn.
- **Secret disclosure:** bot tokens and message bodies are absent from logs,
  error strings receive basic credential redaction, and Rich Markdown output is
  size/block-capped, with unsupported raw HTML escaped and unsafe link schemes
  rendered as text. `request_user_input` questions marked secret are rejected
  instead of being sent to Telegram.
- **Process crash:** SQLite WAL, versioned migrations, expired lease recovery,
  bounded retry, dead letters, and graceful shutdown.

## Residual risks

- Telegram send methods have no gateway-controlled idempotency key. A process
  crash after Telegram accepts a message but before SQLite records it can cause
  one duplicate notification on retry.
- Anyone controlling the allowlisted Telegram account can execute Codex with
  full host filesystem, command, and network access. The workspace allowlist
  restricts thread selection and delivery, not process permissions.
- An agent can call the explicit delivery tool more than once when a workflow
  omits a stable dedupe key. The bundled skill requires exactly one final call
  and supports a per-run dedupe key when the scheduler exposes one.
- Real credential-dependent Telegram and Desktop Scheduled smoke tests are not
  run in public CI.
- Input requests are supported only for turns owned by the gateway's current
  app-server connection. Pending requests intentionally do not survive restart.
