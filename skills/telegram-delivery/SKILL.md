---
name: telegram-delivery
description: Deliver one completed Codex task result to Telegram. Use only when the user or a scheduled-task prompt explicitly requests Telegram delivery, especially as the final step of a Codex scheduled task.
---

# Telegram Delivery

Use the bundled `telegram_deliver` MCP tool as the final action of an explicitly opted-in task.
Ordinary top-level turns already receive an automatic completion card; use this workflow only when
the user or schedule explicitly wants a custom self-contained notification. When trusted metadata
binds both paths to the same turn, the gateway sends the explicit result and suppresses the
automatic duplicate.

1. Finish the requested work and its required verification before preparing the notification.
2. Compose a concise, self-contained result:
   - `title`: identify the scheduled task or report.
   - `message`: state success, failure, or partial completion; include the important result, relevant
     artifact paths or links, and any action the user must take. Write GFM-compatible Rich
     Markdown; do not generate Telegram HTML or MarkdownV2 and do not escape Markdown punctuation.
   - `cwd`: pass the absolute workspace path for the task.
3. Call `telegram_deliver` exactly once. Do not call it for tasks that merely inspect gateway
   health or mention Telegram without requesting delivery.
4. If the scheduled workflow provides a stable run identifier, pass it as `dedupeKey`. Reuse the
   same key only when retrying the same logical run. Otherwise omit it and do not retry after a
   successful enqueue response.
5. After the tool returns, give the same outcome in the normal Codex final response and state
   whether Telegram delivery was queued. A queued response is success; network delivery is handled
   asynchronously by the gateway daemon.

The MCP host may attach trusted Codex request metadata outside the model-visible
tool arguments. When its thread and session identifiers agree, the gateway binds
the Telegram card to that exact task and turn automatically. If turn metadata is
unavailable but the host process provides its inherited `CODEX_THREAD_ID`, the
card still receives a direct switch action for that exact task without claiming
turn-level deduplication. If neither trusted source is available or they
conflict, the gateway safely sends an independent notification instead. Never
add, infer, or fabricate thread identifiers in tool arguments from cwd, title,
timing, or recent activity.

If the task fails before producing its intended artifact, still deliver one failure summary when
the prompt requires delivery. Never claim delivery succeeded when the MCP call failed.
