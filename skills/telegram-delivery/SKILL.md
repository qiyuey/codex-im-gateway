---
name: telegram-delivery
description: Deliver one completed Codex task result to Telegram. Use only when the user or a scheduled-task prompt explicitly requests Telegram delivery, especially as the final step of a Codex scheduled task.
---

# Telegram Delivery

Use the bundled `telegram_deliver` MCP tool as the final action of an explicitly opted-in task.

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

This generic explicit delivery has no trusted Codex thread/turn identity. Its
Telegram card is therefore labeled **Notification only**, and replying to it
does not automatically continue the originating task. Never add, infer, or
fabricate thread identifiers from cwd, title, timing, or recent activity.

If the task fails before producing its intended artifact, still deliver one failure summary when
the prompt requires delivery. Never claim delivery succeeded when the MCP call failed.
