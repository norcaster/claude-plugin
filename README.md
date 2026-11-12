# Norcaster Companion for Claude Code

Route Claude Code through your organization's Norcaster gateway, part of the Norcaster AI Runtime Control Plane. Your rules are checked before a prompt reaches the model provider, and each decision is recorded.

This plugin configures gateway routing, checks submitted prompts, and shows policy decisions inside Claude Code.

**You need:** a Norcaster account ([norcaster.com](https://www.norcaster.com)) with an AI provider connected, Node.js 18 or later on your `PATH`, and Claude Code 2.1.295 or later (for blocking when a hook crashes or times out). Deploy the gateway with `POST /v1/policy/check` before installing Companion 0.3.0; an older gateway cannot complete the check, so submitted prompts are stopped.

## Install

```bash
claude plugin marketplace add norcaster/claude-plugin
```

```bash
claude plugin install norcaster@norcaster
```

No GitHub SSH key on this machine? Set `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` before running them.

Start Claude Code and enter your settings. Your API key goes to your OS keychain and never into the chat:

```text
/plugin configure norcaster@norcaster
```

Then run the setup:

```text
/norcaster:configure
```

It shows every file and setting it will change, and writes nothing until you say yes. Fully restart Claude Code afterwards, then check that `/status` shows the gateway address.

**Which key to use:** [get a key from the Norcaster portal](https://www.norcaster.com/dashboard/connect-tool?tool=claude_code). The page walks you through it, and you paste the key in yourself. Leave the plugin's deployment ID empty, because the key already names the deployment. Use one key per developer, so the records show who sent each request.

**Updates:** run `claude plugin update norcaster@norcaster`, or turn on auto-update for this marketplace under **Marketplaces** in `/plugin`. It's off by default.

## What this plugin changes, runs and sends

**After you confirm `/norcaster:configure`, Claude Code's model requests go through the gateway.** That includes your prompts, the code and files in context, and tool results. The gateway applies your organization's rules, records the decision, and forwards allowed requests to the AI provider your organization connected. Norcaster's [privacy policy](https://www.norcaster.com/legal/privacy) covers how that data is handled.

**On your machine, setup writes:**

| Where | What |
|---|---|
| `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`, `apiKeyHelper`, `statusLine`, and `env.ANTHROPIC_CUSTOM_HEADERS` when the key isn't bound to one deployment |
| `~/.claude/norcaster/` | The key helper, the status-line script, your previous settings so they can be restored, and a small status cache |
| macOS Keychain, or an owner-only file elsewhere | Your API key |

Writes merge into your settings and never overwrite the rest of the file. Passing `credential_mode: "env"` puts the key in `settings.json` in plain text instead; the plan says so before anything is written.

**The plugin contacts only your gateway** (`api_url`, by default `https://api.norcaster.com`), and only with your key:

- The status line checks the key, at most once every 60 seconds.
- The commands and console tools below call the gateway when you or Claude use them.
- Before each prompt in a gateway-routed session, the plugin sends the submitted text to `POST /v1/policy/check`. The check uses your existing `runs:write` scope, makes no model call, and consumes no model budget. A missing deployment header uses the key's single deployment binding, as on model requests.
- The plugin has no other analytics or telemetry. `portal_url` is only used to build links.

**In your Claude Code sessions:**

- A `SessionStart` hook warns if the session isn't routed through the gateway. When it is, the hook adds a short note to Claude's context saying that a Norcaster block is the rules working, not a network error.
- A `UserPromptSubmit` hook rejects blocked prompts before they enter model context. The next clean question can continue in the same conversation. The block stays in Decision Audit as `prompt.preflight`, with masked detection metadata and no stored prompt. A failed check, including timeout, missing credentials, an old gateway, or unavailable audit storage, stops submission with an explanation. Allowed prompts produce no hook output; redact/flag decisions continue to the gateway for full-request enforcement.
- A `StopFailure` hook recognises a Norcaster block, turns the status line red for ten minutes and raises a desktop notification through your terminal.

The pre-submit hook checks typed text only. Files, expanded skills, tool results, earlier history, and the full model request are still checked at the gateway. It does not repair an existing conversation containing blocked content: use Claude Code's `/rewind` → **Restore conversation**, replace the recalled prompt, and submit a clean question. It never edits transcript files. Claude Code may still save submitted text in local files; keeping a rejected prompt out of model context is not secure deletion from disk. See the [Claude Code hook contract](https://code.claude.com/docs/en/hooks#what-a-blocked-prompt-leaves-behind).

Pre-submit blocks have no **Forward once** grant: there is no complete model request to approve. Correct the prompt or use the existing false-positive review process. Gateway blocks retain their existing forwarding rules.

**To undo it:** `/norcaster:remove` lists what it will remove across your settings files, then removes the routing, key, helper and status line and restores any `apiKeyHelper` or status line you had before. It works without a valid key.

## Commands

| Command | What it does |
|---|---|
| `/norcaster:configure` | Shows the plan, then writes the routing and status line once you confirm |
| `/norcaster:status` | Key validity, routing, status-line state and a Decision Audit link |
| `/norcaster:events` | Recent blocked and redacted decisions, Forward once, and flagging a false positive |
| `/norcaster:remove` | Shows the plan, then undoes the setup once you confirm |

**Forward once** appears only when your workspace owner has allowed it. It approves one exact retry, and the gateway checks the rules again on that retry. Credentials and other terminal controls never offer it. The plugin can't change a rule.

**Console tools:** Claude can answer questions such as "show blocked runs this morning" with read-only tools: `list_deployments`, `get_deployment`, `get_deployment_metrics`, `get_deployment_costs`, `get_deployment_errors`, `get_compliance_report`, `list_runs`, `get_run`, `get_run_trace` and `simulate_policy`, which is a dry run with no model call. They only see what your key can see.

## Configuration

Set these with `/plugin configure norcaster@norcaster`.

| Option | Default | Purpose |
|---|---|---|
| `api_key` | none | Your personal API key, stored in the OS keychain. It needs the scopes `runs:write` and `deployments:read`, which the portal page above sets for you. A key from **Settings → API keys** also works; add `deployments:write` only if you use `simulate_policy` |
| `deployment_id` | none | Leave empty when the key is bound to one deployment. Otherwise it's required. If you later bind the key to more deployments, run `/norcaster:configure` again |
| `api_url` | `https://api.norcaster.com` | Gateway address. Self-hosted: point it at yours |
| `portal_url` | `https://www.norcaster.com` | Portal address, used for Decision Audit links |

## What it doesn't cover

- **Input only:** the gateway checks what's sent, not what the model writes back, because holding back output would break streamed code generation.
- **Detection isn't perfect:** detectors are high-signal patterns, so keep your repository's own secret scanning too.
- **Other tools:** this plugin configures Claude Code only, not Codex CLI or Continue.
- **Other Claude surfaces:** the Claude desktop app, Claude Code on the web and Claude in Slack don't take their routing from this setup.
- **`ANTHROPIC_API_KEY`:** if it's set in `settings.json`, it takes precedence over the gateway credential. The plan warns you.
- **Variables already in your shell:** if your terminal exports `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_BASE_URL`, for example from an earlier manual setup, run `unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL` before starting Claude Code. Otherwise Claude Code warns "Both ANTHROPIC_AUTH_TOKEN and apiKeyHelper set", and you can't tell which key a request used. The plugin doesn't check for this.
- **claude.ai connectors and billing:** while Claude Code uses the gateway credential, it doesn't load the connectors from your claude.ai account, such as Google Drive or Slack. MCP servers configured on your machine still work. Requests use the AI provider your organization connected to Norcaster, not your Claude subscription, so Claude Code shows API usage billing.
- **Watch-only rules:** while your app's Developer Tools rules are in watch-only, as new rules usually are at first, only credentials are blocked. Other matches, such as personal data, are recorded in Decision Audit and let through. The app's **Policies** tab shows the mode, where watch-only is called **Monitor**.
- **Managed machines:** if your organization already sets `ANTHROPIC_BASE_URL` through managed settings, skip `/norcaster:configure`. The status line and `/norcaster:events` still work.

## What's been tested

**Against Norcaster's production gateway** (November 2026), on macOS with Claude Code 2.1.322 and a real key bound to one deployment:

- `/norcaster:configure` stored the key in the macOS Keychain, and `/norcaster:status` reported a valid key, a routed session and the status line.
- Requests reached the deployment and were recorded.
- A prompt containing a fake credential was rejected before it entered model context, with a Decision Audit link. The block appeared in Decision Audit as a pre-submit block, and the next clean question continued in the same conversation.
- `/norcaster:events` listed the decision.
- `/norcaster:remove` showed its plan, then removed the routing, key helper, status line, Keychain item and `~/.claude/norcaster`, leaving the rest of `settings.json` as it was.

Not yet tried in production: **Forward once** on a gateway block.

**Earlier, against a stand-in gateway:** setup on Claude Code v2.1.220, including the real macOS Keychain, and the pre-submit hook on v2.1.319. The Node tests run on Linux too. Windows hasn't been tested.

## Support and security

- **Questions and problems:** [support@norcaster.com](mailto:support@norcaster.com)
- **Security reports:** [security@norcaster.com](mailto:security@norcaster.com)

## Develop

```bash
node --test test/*.test.mjs
```

```bash
claude plugin validate . --strict
```

The source is plain JavaScript with no dependencies and no build step.

Licensed under MIT.
