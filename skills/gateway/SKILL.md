---
name: gateway
description: Configure, inspect, and troubleshoot Codex IM Gateway completion delivery. Use when the user asks about gateway health, queued notifications, Telegram delivery, or replying to Codex tasks from IM.
---

# Codex IM Gateway

Use the bundled `gateway` MCP tools for state inspection and configuration-safe actions.

1. Call `gateway_health` before troubleshooting delivery.
2. Use `gateway_list_events` with the narrowest useful state filter. Do not expose event payloads
   unless the user explicitly requests them.
3. Use `gateway_enqueue` only when the user explicitly asks to test delivery or when a scheduled
   workflow contract requires the documented fallback producer.
   For normal explicit result delivery, use the separate `$telegram-delivery` skill and its
   `telegram_deliver` tool instead of fabricating Codex thread or turn identifiers.
4. Never ask for a Telegram bot token in chat. Direct the user to set it through the local
   configuration workflow once that workflow is available.
5. Gateway-originated turns use the fixed `danger-full-access` policy. Do not add IM controls that
   change permission mode or workspace access, and preserve sole-user private-chat authorization.
