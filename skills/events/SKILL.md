---
name: events
description: Show recent Norcaster enforcement decisions for this deployment (blocked and redacted requests), explain them, and act on them — Forward once for an eligible block after explicit confirmation, or flag a false positive. Use when a request was blocked or redacted at the gateway.
argument-hint: "[forward <event_id> | flag <event_id> <reason>]"
---

# Norcaster: Enforcement events

A block at the gateway is the policy boundary working, not a network error. Your job is to show the user what was decided, why, and what they can do, without ever weakening it.

1. Call the `norcaster` MCP tool `list_enforcement_events` with `{"limit": 10}`.
2. Show a compact table: when, action (blocked / redacted), developer notice or matched rules, detection origin, and whether Forward once is eligible. Add the Decision Audit link.
3. Explain the origin honestly:
   - `history`: an earlier message still in the conversation is resent every turn, so editing the latest message cannot clear it. The user must start a new conversation. Forwarding is never available for these.
   - anything else: replace or remove the value and resend, or use Forward once if eligible.
4. **Forward once** (only for events with `forwarding.can_approve`): show this confirmation and wait for an explicit yes: "Approve one exact retry? If the assistant retries before expiry, the blocked input will be sent to the configured model provider. Credentials, payment data, guardrails, and history-origin blocks remain excluded." Then call `forward_once` with `{"event_id": ..., "confirm": true}` and relay its `next` text: the user re-sends the exact same message before it expires; the exception is consumed once and logged.
5. **Flag false positive**: ask for the reason if not given, call `flag_false_positive`, and say that the block still stands.

If `$ARGUMENTS` is `forward <event_id>` or `flag <event_id> <reason>`, go straight to step 4 or 5 for that event, still with the confirmation in step 4.
