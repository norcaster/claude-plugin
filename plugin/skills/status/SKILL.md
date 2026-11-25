---
name: status
description: Check whether this machine's Claude Code is governed by Norcaster — key valid, session routed through the gateway, status line installed — with the Decision Audit link. Use when the user asks whether they are governed, whether the gateway is reachable, or why the status line shows a warning.
---

# Norcaster: Governed status

1. Call the `norcaster` MCP tool `check_status`.
2. Report the `state` and its `summary` in one or two sentences, then the Decision Audit link.
3. If the state is not `governed`, say what fixes it:
   - `no-key` or `invalid-key`: the key lives in the plugin's user configuration (`/plugin` → Norcaster). It is never typed into chat.
   - `key-valid-not-routed`: run `/norcaster:configure`, or restart Claude Code if the user just did (the settings env is read at startup).
   - `unreachable`: the gateway is down or the URL is wrong. Requests error rather than bypass the boundary.
4. If `settings_json_malformed` is true, say that `~/.claude/settings.json` is not valid JSON and must be fixed by hand.

Do not run `/norcaster:configure` on the user's behalf; suggest it.
