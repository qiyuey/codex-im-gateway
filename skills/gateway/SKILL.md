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
4. Never ask for a Telegram bot token in chat. Direct the user to set it through the local
   configuration workflow once that workflow is available.
5. Do not widen Codex sandbox permissions or workspace access through IM controls.
