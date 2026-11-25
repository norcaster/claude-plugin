---
name: remove
description: Undo Norcaster's Claude Code configuration. Removes exactly the gateway env keys from every Claude Code settings file in scope, restores the previous status line, and shows the plan before touching anything.
disable-model-invocation: true
---

# Norcaster: Remove Claude Code Configuration

Opting out must never depend on still being signed in, and a partial removal is worse than no removal: a leftover `ANTHROPIC_BASE_URL` with no credentials makes every request fail with 401. The tool scans every settings file Claude Code reads env from and reports the full list before touching anything.

1. Call the `norcaster` MCP tool `remove_claude_code_config` with `{"mode": "plan", "project_dirs": [<absolute path of the current working directory>]}`. Add any other repositories the user names whose `.claude/settings.json` may carry the keys.
2. Show the plan verbatim: the files scanned, which of them carry the keys, what the status line will be restored to, and any malformed file that will be skipped. Say plainly that Claude Code will talk to the provider directly afterwards, so its traffic will no longer be governed. Ask for an explicit "yes".
3. Only after an explicit yes, call `remove_claude_code_config` with `{"mode": "apply"}` and the same `project_dirs`.
4. Relay the tool's `message` word for word. If it reports a FAILED file, that half-state is the most important thing to say: the user must remove the keys from that file by hand before restarting.

Never edit settings files yourself. Only folders passed in `project_dirs` are scanned; other repositories with their own `.claude/settings.json` are untouched, and the message says so.
