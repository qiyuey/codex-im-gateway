# Codex IM Gateway

> Get selected Codex results in Telegram and continue the same task from your phone.

[简体中文](README.zh-CN.md) | English

[![CI](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex IM Gateway is a local-first Codex plugin for people who want to leave a
task running on their computer, receive the result in Telegram, and safely
continue that exact conversation without returning to the desktop.

The project is **pre-alpha**. Telegram is usable today, but installation still
requires a source checkout and a local Codex marketplace. Slack, Discord,
Feishu, and generic webhooks are planned but not implemented.

## What you can do

- Send the final result of an explicitly selected Codex or Scheduled task to Telegram.
- Browse allowed Codex projects and tasks with `/threads`.
- Continue the selected task by sending a normal Telegram message.
- Reply to a result card and always return to the task that produced it.
- Answer non-secret multiple-choice or free-form Codex questions from Telegram.
- Watch a Desktop task and receive one notification when it finishes, fails, is
  interrupted with a useful result, or becomes blocked.

The gateway does not stream Desktop reasoning, commands, tool calls, or partial
output. Telegram-originated turns update one placeholder message while running.

## Before you install

You need:

- Node.js 26 or later
- pnpm 11 or later
- an installed and authenticated Codex Desktop/CLI compatible with the
  checked-in protocol snapshot
- a Telegram bot created with [BotFather](https://t.me/BotFather)
- your numeric Telegram user ID

This gateway is designed for one trusted user in a private bot chat. Telegram
requests can start Codex turns from the workspace roots you allow, and those
turns run with full host access rather than being confined to those roots.
Protect the Telegram account and bot token as carefully as the local machine
itself.

## Install from source

### 1. Build the gateway

```bash
git clone https://github.com/qiyuey/codex-im-gateway.git
cd codex-im-gateway
pnpm install --frozen-lockfile
pnpm check
cp .env.example .env
```

`pnpm check` runs formatting checks, type checking, tests, the production build,
distribution smoke tests, and plugin validation.

### 2. Configure `.env`

Set these values in the local `.env` file:

```dotenv
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOWED_USER_ID=123456789
TELEGRAM_ALLOWED_CHAT_ID=123456789
CODEX_IM_GATEWAY_ALLOWED_WORKSPACES=/absolute/path/to/workspace
CODEX_IM_GATEWAY_LANGUAGE=en
```

- `TELEGRAM_ALLOWED_CHAT_ID` must be the same as `TELEGRAM_ALLOWED_USER_ID`.
  Group chats and other users are rejected.
- `CODEX_IM_GATEWAY_ALLOWED_WORKSPACES` accepts multiple absolute roots separated
  by `:` on macOS/Linux or `;` on Windows.
- `CODEX_IM_GATEWAY_LANGUAGE` can be `en` or `zh` and defaults to `zh`. It changes
  gateway buttons, commands, task cards, prompts, and status messages, but does
  not translate Codex output.
- Never commit `.env` or paste the bot token into a Codex conversation.

### 3. Install the local plugin

Add this checkout to a trusted local Codex marketplace, install
`codex-im-gateway` from that marketplace, and then start a **new Codex task** so
the bundled skills and MCP server are loaded. See the official
[local plugin instructions](https://developers.openai.com/codex/plugins/build#install-a-local-plugin-manually)
and the project's [operations guide](docs/operations.md).

This step is intentionally not automated: a local marketplace is part of your
Codex configuration, and this repository should not overwrite an existing
personal or project marketplace.

### 4. Start and verify

Keep the daemon running on the computer where Codex is installed:

```bash
pnpm start
```

In another terminal, verify both the gateway and Codex connection:

```bash
node dist/cli.js health
node dist/cli.js app-server-health
```

Then open the private chat with your bot, send `/threads`, select an allowed
project and task, and send a short message. The reply should continue that task.

## Everyday use

### Send a task result to Telegram

Delivery is opt-in. Ask Codex to use `$telegram-delivery` as the final step:

```text
Run the test suite, summarize any failures, and use $telegram-delivery as the
final step to send me the result on Telegram.
```

The same instruction can be added to a Scheduled task prompt. Tasks that do not
request Telegram delivery are not sent automatically unless you watch their
thread from Telegram.

### Continue a task from Telegram

Use `/threads` to choose a project and one of its recent tasks. After selection:

- a normal message continues the active task;
- replying to a result or question card continues the task bound to that card;
- selecting another task moves the active watch to it;
- `/mute` stops completion notifications without changing the active task;
- `/detach` clears both the active task and its watch.

Reply routing is durable: a reply never silently falls back to an unrelated
active task. A notification without trusted Codex task metadata is clearly shown
as an independent notification and offers a task picker instead.

### Telegram commands

| Command | What it does |
| --- | --- |
| `/threads` | Choose a project, then a recent task |
| `/use <id-prefix>` | Select one task by an unambiguous ID prefix |
| `/current` | Show the active task |
| `/new` | Create a task in the first allowed workspace |
| `/mute` | Stop completion notifications for the active task |
| `/detach` | Clear the active task and watch |
| `/stop` | Interrupt the active turn and cancel queued follow-ups |

The daemon adds these commands to the Telegram bot menu at startup.

## Safety model

- The daemon uses Telegram long polling and opens no public listener.
- Only the configured private Telegram user/chat is accepted.
- Every selected task is checked against the workspace allowlist.
- A local SQLite inbox makes notification delivery retryable and idempotent.
- Secret input and command, file, or permission approvals are never accepted
  through Telegram.
- `disable` is a persistent emergency switch for inbound Telegram execution.

The gateway is an access path to your local Codex, not a sandbox. Read the
[threat model](docs/threat-model.md) before relying on it outside a personal,
trusted setup.

## Troubleshooting and operations

```bash
# Basic health
node dist/cli.js health
node dist/cli.js app-server-health

# Inspect queues without printing event payloads
node dist/cli.js events --state queued
node dist/cli.js events --state dead_letter
node dist/cli.js notifications --state queued
node dist/cli.js notifications --state dead_letter

# Recover expired leases
node dist/cli.js recover

# Emergency stop / resume for inbound Telegram execution
node dist/cli.js disable
node dist/cli.js enable
```

Runtime state is stored in
`~/.local/share/codex-im-gateway/gateway.sqlite` by default. Start a new Codex
task after installing or refreshing the plugin. Restart the daemon after
changing `.env`.

For backup, token rotation, queue recovery, and removal instructions, see
[docs/operations.md](docs/operations.md).

## FAQ

**Does it send every Codex task to Telegram?**

No. A task must explicitly request `$telegram-delivery`, or you must select and
watch that task from Telegram.

**Can I answer Codex questions from Telegram?**

For turns started from Telegram, non-secret `request_user_input` questions are
shown as expiring, one-time cards. Choose an option or reply directly to the
card. Permission approvals and secret input stay on the computer.

**Can another Telegram user control my Codex tasks?**

The intended configuration accepts only one numeric user ID in that user's
private bot chat. Forwarded contexts, other chats, and disallowed workspaces are
rejected.

**Does uninstalling the gateway delete Codex tasks?**

No. Codex remains the source of truth. The gateway stores only its queue,
delivery, watch, and message-binding state.

**Why did I receive an “independent notification”?**

Codex did not provide consistent trusted thread/turn metadata for that delivery.
The gateway sends the result but does not guess which task replies should enter.

## Project documentation

- [Operations](docs/operations.md)
- [Architecture](docs/architecture.md)
- [Threat model](docs/threat-model.md)
- [Implementation plan](PLAN.md)
- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)

## Support

- [Report a bug](https://github.com/qiyuey/codex-im-gateway/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/qiyuey/codex-im-gateway/issues/new?template=feature_request.yml)

## License

MIT License — see [LICENSE](LICENSE).
