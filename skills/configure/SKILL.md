---
name: configure
description: Route this machine's Claude Code through the Norcaster gateway (AI Runtime Control Plane). Shows exactly what will be written to ~/.claude/settings.json, waits for confirmation, then applies it.
disable-model-invocation: true
---

# Norcaster: Configure Claude Code

You are running the Norcaster Companion setup. It is setup and visibility, not a chat: the user keeps Claude Code exactly as it is; only routing changes, so that input policy is enforced before the model provider and every decision is recorded in Decision Audit.

1. Call the `norcaster` MCP tool `configure_claude_code` with `{"mode": "plan"}`.
2. If the plan reports `problems`, show them and stop. Do not work around a missing key or deployment ID: those come from the plugin's user configuration (`/plugin` → Norcaster → configure), and the key must never be typed into the chat. A key bound to exactly one deployment needs no deployment ID; the plan then writes no deployment header and says so in `warnings`. When the plan carries a `recommendation`, show it too: it is the setup Norcaster recommends, not a problem, and configuring can go ahead without it.
3. Otherwise show the plan to the user verbatim: every file and key that will be written, what is preserved, and the plaintext-key note. Then ask for an explicit "yes".
4. Only after an explicit yes, call `configure_claude_code` with `{"mode": "apply"}`.
5. Relay the tool's `next` instructions word for word: fully restart Claude Code, then check that `/status` shows the gateway base URL. Mention `/norcaster:remove` as the way to undo it.

Never edit `~/.claude/settings.json` yourself with Bash, Edit or Write. The tool merges, never overwrites, and records what it changed so `/norcaster:remove` can undo exactly that.
