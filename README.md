# Codex IM Gateway

> Deliver selected Codex task results to Telegram, and continue allowed
> conversations from your phone.

[![CI](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/qiyuey/codex-im-gateway/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-26%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-11%2B-F69220?logo=pnpm&logoColor=white)](https://pnpm.io/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Codex IM Gateway is a local-first Codex plugin that connects Codex Desktop and
Scheduled tasks to instant-messaging platforms. The first adapter targets
Telegram; Slack, Discord, Feishu, and generic webhooks are planned.

The project is currently **pre-alpha**. The Telegram workflow is usable, but the
installation still runs from a source checkout.

## ✨ Why Codex IM Gateway

### Deliver selected task results

- Explicitly opt selected Codex Desktop or Scheduled tasks into Telegram delivery
  with the bundled `$telegram-delivery` skill.
- Ordinary tasks and scheduled tasks are not delivered unless their prompt asks
  for this capability or you explicitly watch their thread from Telegram.
- Browse recent Codex projects and their threads from allowed workspaces with `/threads`.
- Pick a project, then switch threads by tapping its button (or with `/use`) without opening the desktop app.

### Resume the right conversation

- Replies are routed through a durable Telegram-message-to-Codex-thread binding.
- A reply never silently falls back to an unrelated active thread.
- Multiple tasks and workspaces remain isolated from one another.
- Bound results render as task cards with status, project, duration, and
  **Switch**/**Mute** actions; unbound results are visibly marked
  **Notification only**.
- When a Telegram-originated turn asks a non-secret `request_user_input`
  question, answer its one-time option card or reply directly to that card.

### Local-first and durable

- The daemon opens no public listener; Telegram uses long polling.
- A local SQLite inbox provides retryable, idempotent notification delivery.
- The bundled MCP tool only writes a local notification and never performs
  Telegram network delivery inline.
- Private-chat allowlists, workspace allowlists, and a persistent kill switch
  limit remote execution.

## 📦 Install from source

### Requirements

- Node.js 26 or later
- pnpm 11 or later
- An installed and authenticated Codex Desktop/CLI compatible with the checked-in
  protocol snapshot
- A Telegram bot created with [BotFather](https://t.me/BotFather)

### Build and configure

```bash
git clone https://github.com/qiyuey/codex-im-gateway.git
cd codex-im-gateway
pnpm install --frozen-lockfile
pnpm check
cp .env.example .env
```

Edit `.env` locally and set:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ALLOWED_USER_ID`
- `TELEGRAM_ALLOWED_CHAT_ID`
- `CODEX_IM_GATEWAY_ALLOWED_WORKSPACES`

Never commit `.env`. Multiple workspace roots use the operating system path
delimiter (`:` on macOS/Linux and `;` on Windows).

Install the checkout as a local Codex plugin, then start a new Codex task so its
skills and MCP server are loaded. See the [operations guide](docs/operations.md)
for the full deployment workflow.

Start the foreground daemon:

```bash
pnpm start
```

## 💬 Telegram commands

| Command | Action |
| --- | --- |
| `/threads` | Choose a project, then choose one of its recent threads |
| `/use <id-prefix>` | Select one unambiguous thread |
| `/current` | Show the selected thread |
| `/new` | Create a thread in the first allowed workspace |
| `/mute` | Stop terminal-state notifications for the selected thread |
| `/detach` | Clear the current context binding |
| `/stop` | Interrupt the active turn and cancel queued follow-ups |

Plain messages use the active thread. Replies always use the binding of the
replied-to Telegram message. The daemon registers these commands in Telegram's
menu at startup. `/threads` first shows projects plus a **Tasks** group,
then shows up to ten recent threads for the selected group. Projects use the
nearest Git root inside the workspace allowlist, matching Codex's default
project-root detection; allowed threads without one appear under **Tasks**.
Tapping a thread selects it for the current chat or topic after its workspace is
checked again, and watches that thread for new terminal states. Switching threads
moves the watch; `/mute` stops notifications without changing the selected
thread, while `/detach` clears both selection and watch.

Watched Desktop turns are checked about every five seconds. The gateway sends
one final Telegram message when a new turn completes, fails, is interrupted
with a useful result, or when the thread goal becomes blocked. Empty interruption
states are ignored because Codex can expose them temporarily while steering or
resuming a task. It does not stream Desktop reasoning, commands, tool calls, or
partial output. Prompts started from Telegram continue
to update one placeholder message incrementally, finish as a bound task card,
and are marked handled so the watcher does not send a duplicate final
notification. If such a turn requests structured user input, the gateway sends
an expiring one-time question card. Secret input and permission approvals are
not accepted through Telegram.

## 🧰 Operations

```bash
node dist/cli.js health
node dist/cli.js app-server-health
node dist/cli.js events --state queued
node dist/cli.js events --state dead_letter
node dist/cli.js notifications --state queued
node dist/cli.js notifications --state dead_letter
node dist/cli.js recover
node dist/cli.js disable
node dist/cli.js enable
```

`disable` is the emergency kill switch for inbound IM execution. Runtime state
is stored by default in `~/.local/share/codex-im-gateway/gateway.sqlite`.

## 🏗️ How it works

1. An explicitly opted-in prompt invokes `$telegram-delivery`.
2. The skill makes `telegram_deliver` the final workflow action.
3. The MCP tool durably enqueues the completed result in local SQLite.
4. The daemon validates the workspace and delivers the result with Telegram
   Rich Markdown through `sendRichMessage`, preserving headings, lists, tables,
   quotes, and code blocks. Control prompts and errors use unparsed plain text.

The Rich Markdown preparation layer follows the Telegram Bot API 10.1 Rich
Message grammar. It preserves the complete official inline and block vocabulary,
including in-document anchors and references, date-time and custom emoji
entities, formulas, details, media figures, maps, collages, slideshows, and
advanced table/list attributes. Embedded Rich HTML is validated per tag and
attribute: inline links use an explicit protocol allowlist, media sources are
limited to HTTP(S), and structured numeric/enumerated attributes are range
checked before delivery. Unsupported tags, attributes, URL schemes, and named
entities are emitted as escaped text instead of executable Rich HTML.

Separately, selecting a thread from Telegram stores one persistent watch for
that chat/topic. The daemon reads only that thread through the public app-server
protocol and delivers new terminal states; selecting another thread replaces
the watch.

The explicit notification is a one-way result delivery and is not automatically
bound to a Codex thread, so its card is explicitly marked **Notification only**.
Bound completion and watched-thread cards say that replies continue the exact
task and provide Switch/Mute actions. Telegram commands can still select and
resume allowed threads independently through `codex app-server`.

Codex remains the source of truth for threads and turns. Internal Codex SQLite
files and transcript formats are not treated as APIs.

## 🧪 Development

```bash
pnpm install
pnpm check
pnpm build
```

`pnpm check` runs formatting, type checking, unit tests, the production build,
distribution smoke tests, and plugin validation. The checked-in app-server
bindings were generated from `codex-cli 0.145.0-alpha.4`; regenerate them
intentionally with `pnpm protocol:generate` when upgrading the protocol.

## ❓ FAQ

**Does it stream live token-by-token progress to Telegram?**  
Telegram-originated turns use debounced edits to one message, not one message per
token. Desktop turns are not streamed; watched threads send only terminal-state
notifications.

**Can I answer Codex questions from Telegram?**
For turns started from Telegram, non-secret `request_user_input` questions are
shown as one-time cards. Choose an option or reply to the exact card with text.
The request expires when its app-server request resolves, its turn ends, its TTL
passes, or the daemon restarts. Command, file, and permission approvals are not
enabled.

**Can another Telegram user control my Codex tasks?**  
Not with the intended configuration. The adapter accepts only the configured
private user and chat, rejects forwarded contexts, and checks workspace roots.

**Does removing the gateway delete Codex conversations?**  
No. Codex owns the threads; the gateway stores only queue, delivery, and binding
state.

## 📚 Documentation

- [Implementation plan](PLAN.md)
- [Architecture](docs/architecture.md)
- [Operations](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Plugin packaging ADR](docs/adr/0001-codex-plugin-packaging.md)
- [Explicit task delivery ADR](docs/adr/0002-explicit-task-delivery.md)
- [Watched-thread delivery ADR](docs/adr/0003-watched-thread-delivery.md)
- [Task cards and user-input ADR](docs/adr/0004-task-cards-and-user-input.md)
- [Security policy](SECURITY.md)

## 📞 Support & feedback

- [Report a bug](https://github.com/qiyuey/codex-im-gateway/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/qiyuey/codex-im-gateway/issues/new?template=feature_request.yml)

## 🤝 Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening
a pull request.

## 📄 License

MIT License — see [LICENSE](LICENSE).
