# Changelog

## 0.3.2 — 2026-11-25

- The pre-submit check and the block notification use only the key you entered with `/plugin configure`. They no longer fall back to a key that `/norcaster:configure` stored in `settings.json` or behind the key helper. Without your key the check stops the prompt and asks you to configure, as it did before when no key was found. Model requests are unchanged: Claude Code still gets the key from the helper or `settings.json`, as configured.
- The repository has a new layout. The plugin is in `plugin/`, and the marketplace, tests and CI are beside it at the root. Install with the same commands; an installed 0.3.1 updates as usual.

## 0.3.1 — 2026-11-13

- The plugin uses only its own key: the one you enter with `/plugin configure`, or the one `/norcaster:configure` stored. It no longer reads an `ANTHROPIC_AUTH_TOKEN` or `NORCASTER_API_KEY` exported in your shell, so it never sends a credential it wasn't given. This follows the Claude plugin directory's policy.
- The MCP server gets its settings as `CLAUDE_PLUGIN_OPTION_*`, the names the directory accepts. `NORCASTER_API_KEY`, `NORCASTER_DEPLOYMENT_ID`, `NORCASTER_API_URL` and `NORCASTER_PORTAL_URL` are no longer read.
- `package.json` no longer has `scripts`; CI runs the syntax check and tests directly.

## 0.3.0 — 2026-11-07

- Check gateway-routed prompts through `POST /v1/policy/check` before Claude Code adds them to model context. A rejected prompt no longer causes the next clean question to be blocked because it was resent in history.
- Record pre-submit blocks in Decision Audit. No prompt storage, model call, model-budget debit, policy override, or additional key scope; full-request gateway enforcement remains active.
- Stop submission when the check cannot complete. Requires the updated gateway and Claude Code 2.1.295+ for hook crash/timeout handling. Existing transcript files and already-contaminated conversations are not rewritten.

## 0.2.1 — 2026-11-04

- Published as its own public marketplace: `claude plugin marketplace add norcaster/claude-plugin`.
- The README now lists everything the plugin changes, runs and sends, along with support and security contacts.
- The key prompt and README now link to the portal page that walks you through getting a key.
- No change to what the plugin does.

## 0.2.0 — 2026-10-25

- **No deployment header for a key bound to one deployment.** `/norcaster:configure` reads the key's binding from the gateway (`GET /auth/me`). When the key is bound to exactly one deployment, the gateway resolves the deployment from the key, so configure writes no `X-Norcaster-Deployment-Id` header: helper mode leaves `ANTHROPIC_CUSTOM_HEADERS` out of `settings.json`, and env mode keeps only the `X-API-Key` line. Re-running configure removes the header an earlier version wrote. The plan says so in `warnings`.
- `deployment_id` in the plugin's user configuration is now optional. Leave it empty with a key bound to one deployment: the status line, `/norcaster:status`, `/norcaster:events` and the console tools then use the key's deployment. A deployment ID that differs from the key's single binding is refused with both IDs named, and nothing is written; the gateway would refuse every request.
- Everything else keeps the header as before: a key with no binding, a key bound to several deployments, a gateway without the `api_key` block in `/auth/me`, and a lookup that fails. If you later bind the key to more deployments, run `/norcaster:configure` again.
- **A key bound to your deployment is the recommended setup.** The `api_key` prompt and the README say so, and point at Gateway setup → **Create a key for this deployment** (scopes `runs:write` and `deployments:read`). When the configure plan still writes the header, it carries a `recommendation` saying how to switch.
- The `api_key` prompt and README say where to create the key (Settings → API keys, not Access) and which scopes it needs: `runs:write` and `deployments:read`, plus `deployments:write` for `simulate_policy`.

## 0.1.0 — 2026-09-14

Initial port of the VS Code Norcaster Companion to a Claude Code plugin.

- `/norcaster:configure` and `/norcaster:remove`: merge (never overwrite) the three gateway env keys into `~/.claude/settings.json`, install a status line, and undo exactly that across every settings file Claude Code reads. Every write is shown as a plan and confirmed first.
- `/norcaster:status`: key validity, whether this session routes through the gateway, Decision Audit link.
- `/norcaster:events`: recent blocked and redacted decisions with **Forward once** (when the owner has permitted it) and **Flag false positive**.
- Status line: Governed / not configured / key invalid / gateway unreachable, plus a red "blocked" segment for ten minutes after a block. Wraps any status line you already had.
- Hooks: `SessionStart` warns when the session is not governed and briefs Claude when it is; `StopFailure` recognises a Norcaster block, records it for the status line and raises a desktop notification.
- MCP server is dependency-free (hand-rolled stdio JSON-RPC) so the plugin installs from a git checkout with no build step.
- Credential modes: `helper` (default) keeps the key in the macOS Keychain or an owner-only file behind Claude Code's `apiKeyHelper`, so `settings.json` never carries it; `env` reproduces the extension's plaintext behaviour. Switching modes migrates cleanly and `/norcaster:remove` restores any previous `apiKeyHelper`.
- Read-only operator console tools: deployments, runs, traces, metrics, costs, errors, compliance report, and `simulate_policy` as a dry run; `fields` projection and automatic trimming keep responses small.
- Live-verified against the real Claude Code binary and a stand-in gateway; see the README's scope section.
