#!/usr/bin/env node
/**
 * Norcaster Companion MCP server (stdio).
 *
 * Hand-rolled JSON-RPC 2.0 over newline-delimited stdio, deliberately free of
 * dependencies: the plugin installs from a git checkout with no build step.
 * The API key arrives from the plugin's user configuration through .mcp.json
 * (NORCASTER_API_KEY), so it never enters the transcript.
 *
 * Scope (deliberate, same as the VS Code extension): setup and visibility.
 * Nothing here can weaken policy; forward_once approves one audited retry the
 * workspace owner has already permitted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionAuditUrl, effectiveRouting, isRoutedTo, pluginConfig } from "../lib/config.mjs";
import { apiGet, apiPost, keyContext, keyState } from "../lib/api.mjs";
import { boundDeploymentId, resolveDeploymentRouting } from "../lib/deployment-binding.mjs";
import { applyConfigure, applyRemove, isOurStatusline, planConfigure, planRemove } from "../lib/claude-settings.mjs";
import { isNoteworthy, normalizeEvent } from "../lib/events.mjs";
import { readJsonFile } from "../lib/json-file.mjs";
import { installedStatuslinePath, userSettingsPath } from "../lib/paths.mjs";
import { CREDENTIAL_MODES } from "../lib/claude-settings.mjs";
import { defaultStore, installedHelperPath, isOurHelper } from "../lib/credentials.mjs";
import { consoleTools } from "./console-tools.mjs";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf8"));
const STATUSLINE_SOURCE = path.join(PLUGIN_ROOT, "scripts", "statusline.mjs");
const HELPER_SOURCE = path.join(PLUGIN_ROOT, "scripts", "api-key-helper.mjs");
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS =
  "Norcaster Companion: setup and visibility for routing this Claude Code through the Norcaster AI Runtime Control Plane gateway. " +
  "It is not a chat and never changes policy. Rules: (1) call configure_claude_code and remove_claude_code_config with mode \"plan\" first, " +
  "show the plan to the user verbatim, and call mode \"apply\" only after the user explicitly confirms; (2) a gateway block is the policy " +
  "boundary working, not a network error; (3) forward_once approves exactly one audited retry of an eligible decision the workspace owner " +
  "has permitted — never present it as bypassing policy; (4) never edit ~/.claude/settings.json yourself: the tools merge, never overwrite, " +
  "and record what they changed so removal is exact; (5) the console tools (deployments, runs, metrics, costs, errors, compliance report, " +
  "simulate_policy) are read-only and tenancy-scoped by the key — summarise domain-meaningfully (enforcement outcomes, policy names), " +
  "ask for specific fields rather than dumping payloads, and treat simulate_policy as a dry run with no model call.";

const CONFIRM_TEXT =
  "Approve one exact retry? If the assistant retries before expiry, the blocked input will be sent to the configured model provider. " +
  "Credentials, payment data, guardrails, and history-origin blocks remain excluded.";

const SUMMARIES = {
  "no-key": "No API key is configured for the plugin. Set it under /plugin → norcaster; it is stored in your OS keychain.",
  "invalid-key": "The gateway rejected the configured key. Check the key and the gateway URL in the plugin configuration.",
  unreachable: "The gateway is not reachable. Assistants configured for the gateway will error, not bypass it.",
  "key-valid-not-routed":
    "The key is valid, but Claude Code is not routed through the gateway. Run /norcaster:configure, or restart Claude Code if you just did.",
  governed: "Governed: the gateway is reachable, the key is valid, and Claude Code routes through it.",
};

const cfg = pluginConfig();
// The deployment_id setting as the user gave it. With a key bound to exactly one deployment it can
// stay empty: configure then leaves the deployment header out, and the tools default to that deployment.
const configuredDeploymentId = cfg.deploymentId;
let bindingLookup = null;

/** Fill an empty cfg.deploymentId from the key's binding (one /auth/me per server; retried only after a failed lookup). */
function ensureDeployment() {
  if (cfg.deploymentId || !cfg.apiKey) return Promise.resolve();
  bindingLookup ??= keyContext(cfg.apiKey, cfg.apiUrl).then((me) => {
    const bound = boundDeploymentId(me);
    if (bound && !cfg.deploymentId) cfg.deploymentId = bound;
    if (me === null) bindingLookup = null;
  });
  return bindingLookup;
}

function text(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}
function fail(message, extra = {}) {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }] };
}
function missingCredentials() {
  const missing = [];
  if (!cfg.apiKey) missing.push("api_key");
  if (!cfg.deploymentId) missing.push("deployment_id");
  return missing;
}
function explain(res) {
  return res.status ? `HTTP ${res.status}` : `network error: ${res.error ?? "unreachable"}`;
}
const MODE_SCHEMA = {
  type: "string",
  enum: ["plan", "apply"],
  description: "\"plan\" (default) only reports what would change; \"apply\" performs it. Show the plan and get explicit confirmation before apply.",
};

const TOOLS = [
  {
    name: "check_status",
    description:
      "Report whether this machine's Claude Code is governed by Norcaster: is the plugin's key valid at the gateway, does this session " +
      "(or ~/.claude/settings.json) route through the gateway, is the status line installed. Read-only. Includes the Decision Audit link.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Check governed status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run() {
      const routing = effectiveRouting();
      const settings = readJsonFile(userSettingsPath());
      const key = cfg.apiKey ? await keyState(cfg.apiKey, cfg.apiUrl) : "no-key";
      const routed = isRoutedTo(routing, cfg.apiUrl);
      const state = key !== "governed" ? key : routed ? "governed" : "key-valid-not-routed";
      return text({
        state,
        summary: SUMMARIES[state] ?? state,
        gateway: cfg.apiUrl,
        deployment_id: cfg.deploymentId || null,
        deployment_id_from_key_binding: !configuredDeploymentId && Boolean(cfg.deploymentId),
        plugin_config_missing: missingCredentials(),
        session_env_routes_through_gateway: routing.live.baseUrl === cfg.apiUrl,
        settings_json_routes_through_gateway: routing.stored.baseUrl === cfg.apiUrl,
        settings_json_deployment_id: routing.stored.deploymentId || null,
        settings_json_malformed: routing.settingsMalformed,
        statusline_installed:
          settings.ok && isOurStatusline(settings.value?.statusLine) && fs.existsSync(installedStatuslinePath()),
        credential_mode: routing.stateConfig?.credential?.mode ?? null,
        credential_store: routing.stateConfig?.credential?.store ?? null,
        api_key_helper_installed: settings.ok && isOurHelper(settings.value?.apiKeyHelper) && fs.existsSync(installedHelperPath()),
        settings_json_has_plaintext_token: Boolean(routing.stored.authToken),
        decision_audit_url: decisionAuditUrl(cfg.portalUrl, cfg.deploymentId),
        plugin_version: MANIFEST.version,
      });
    },
  },
  {
    name: "configure_claude_code",
    description:
      "Route this machine's Claude Code through the Norcaster gateway: merge ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and " +
      "ANTHROPIC_CUSTOM_HEADERS into ~/.claude/settings.json (never overwriting other settings) and install the Norcaster status line. " +
      "The deployment header is left out when the key is bound to exactly one deployment (the gateway resolves it). " +
      "mode \"plan\" reports exactly what would be written; mode \"apply\" writes it. Always show the plan and get the user's explicit " +
      "confirmation before apply.",
    inputSchema: {
      type: "object",
      properties: {
        mode: MODE_SCHEMA,
        credential_mode: {
          type: "string",
          enum: CREDENTIAL_MODES,
          description:
            "\"helper\" (default): the key goes to the OS keychain (macOS) or an owner-only file and Claude Code fetches it through apiKeyHelper — nothing secret in settings.json. " +
            "\"env\": the key is written into settings.json env as ANTHROPIC_AUTH_TOKEN, like the VS Code extension does.",
        },
      },
      additionalProperties: false,
    },
    annotations: { title: "Configure Claude Code for the gateway", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ mode = "plan", credential_mode = "helper" } = {}) {
      // A key bound to exactly one deployment needs no deployment header (the gateway resolves it).
      // A failed lookup or an older gateway without the api_key block keeps the header.
      const me = cfg.apiKey ? await keyContext(cfg.apiKey, cfg.apiUrl) : undefined;
      const routing = resolveDeploymentRouting(configuredDeploymentId, me);
      const params = {
        apiUrl: cfg.apiUrl,
        portalUrl: cfg.portalUrl,
        deploymentId: routing.ok ? routing.deploymentId : "",
        deploymentHeader: routing.ok ? routing.sendHeader : true,
        deploymentProblem: routing.ok ? undefined : routing.problem,
        apiKey: cfg.apiKey,
        credentialMode: credential_mode,
        storeName: defaultStore(),
      };
      if (mode !== "apply") return text({ mode: "plan", ...planConfigure(params) });
      // Validate before writing: a rejected key would leave Claude Code pointed at the gateway with bad credentials (every request 401).
      const state = cfg.apiKey ? await keyState(cfg.apiKey, cfg.apiUrl) : "no-key";
      if (state === "invalid-key") {
        return fail(`The gateway at ${cfg.apiUrl} rejected the configured key; nothing was written. Fix the key under /plugin → norcaster and retry.`);
      }
      const result = applyConfigure({ ...params, statuslineSource: STATUSLINE_SOURCE, helperSource: HELPER_SOURCE, pluginVersion: MANIFEST.version });
      if (!result.ok) return fail("Configuration not written.", { problems: result.problems });
      if (!cfg.deploymentId) cfg.deploymentId = params.deploymentId;
      return text({
        mode: "apply",
        ...result,
        gateway_reachable: state === "governed",
        ...(state === "unreachable"
          ? { warning: `The gateway at ${cfg.apiUrl} was not reachable just now. Configuration was written; requests will error until it is reachable — they do not bypass it.` }
          : {}),
      });
    },
  },
  {
    name: "remove_claude_code_config",
    description:
      "Undo configure_claude_code: delete exactly the three gateway env keys from every Claude Code settings file in scope " +
      "(~/.claude/settings.json plus .claude/settings.json and .claude/settings.local.json in the working directory and any project_dirs), " +
      "restore the previous status line, and delete the plugin's state directory. Works without a valid key: opting out never depends on " +
      "still being signed in. mode \"plan\" reports; mode \"apply\" writes.",
    inputSchema: {
      type: "object",
      properties: {
        mode: MODE_SCHEMA,
        project_dirs: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths of additional project directories whose .claude settings files should be scanned.",
        },
      },
      additionalProperties: false,
    },
    annotations: { title: "Remove gateway configuration", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    async run({ mode = "plan", project_dirs = [] } = {}) {
      const extra = Array.isArray(project_dirs) ? project_dirs.filter((d) => typeof d === "string" && path.isAbsolute(d)) : [];
      const dirs = [process.cwd(), ...extra];
      return text(mode === "apply" ? { mode: "apply", ...applyRemove(dirs) } : { mode: "plan", ...planRemove(dirs) });
    },
  },
  {
    name: "list_enforcement_events",
    description:
      "Recent enforcement decisions for the configured deployment — blocked and redacted requests by default — with detection origin, " +
      "developer notice, matched rules and whether a one-time forward is eligible. Read-only. Use it to show the user why a request was " +
      "stopped and what they can do.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 50, description: "How many recent events to fetch (default 10)." },
        only_actionable: { type: "boolean", description: "Only blocked/redacted decisions (default true)." },
      },
      additionalProperties: false,
    },
    annotations: { title: "List enforcement events", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async run({ limit = 10, only_actionable = true } = {}) {
      const missing = missingCredentials();
      if (missing.length) return fail(`Plugin configuration incomplete: ${missing.join(", ")}. Set it under /plugin → norcaster.`);
      const n = Math.min(50, Math.max(1, Number(limit) | 0 || 10));
      const res = await apiGet(cfg.apiUrl, `/enforcement-events?deployment_id=${encodeURIComponent(cfg.deploymentId)}&limit=${n}`, cfg.apiKey);
      if (!res.ok) return fail(`Could not list enforcement events (${explain(res)}).`);
      const events = (Array.isArray(res.body?.events) ? res.body.events : []).map(normalizeEvent);
      const shown = only_actionable ? events.filter(isNoteworthy) : events;
      return text({
        deployment_id: cfg.deploymentId,
        decision_audit_url: decisionAuditUrl(cfg.portalUrl, cfg.deploymentId),
        count: shown.length,
        events: shown,
        guidance: {
          history_origin:
            "A block with detection_origin \"history\" comes from an earlier message the client resends every turn. Editing the latest message cannot clear it; start a new conversation. Never eligible for forwarding.",
          forward_once:
            "Only events with forwarding.can_approve can be forwarded, and only once: the user re-sends the exact same message before expires_at. Confirm with the user before calling forward_once.",
          false_positive: "flag_false_positive raises a claim about the detector; the block still stands.",
        },
      });
    },
  },
  {
    name: "forward_once",
    description:
      "Approve ONE exact retry of a blocked request that the workspace owner has permitted for forwarding (forwarding.can_approve on the event). " +
      "After approval the user must re-send the exact same message before it expires; the gateway re-evaluates policy, consumes the approval once " +
      "and records the exception. Credentials, payment data, guardrails and history-origin blocks are never eligible. Requires confirm: true, " +
      "set only after the user has explicitly agreed.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string", description: "The enforcement event to approve (from list_enforcement_events)." },
        confirm: { type: "boolean", description: "Must be true; set only after the user explicitly confirmed the retry." },
      },
      required: ["event_id"],
      additionalProperties: false,
    },
    annotations: { title: "Forward once", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async run({ event_id, confirm = false } = {}) {
      if (confirm !== true) {
        return fail("Not approved: ask the user to confirm one exact retry first, then call again with confirm: true.", { confirmation_text: CONFIRM_TEXT });
      }
      const missing = missingCredentials();
      if (missing.length) return fail(`Plugin configuration incomplete: ${missing.join(", ")}.`);
      if (typeof event_id !== "string" || !event_id.trim()) return fail("event_id is required.");
      const res = await apiPost(cfg.apiUrl, `/enforcement-events/${encodeURIComponent(event_id.trim())}/forward-once`, cfg.apiKey, {});
      if (!res.ok) {
        return fail(typeof res.body?.detail === "string" ? res.body.detail : `Could not approve exception (${explain(res)}).`);
      }
      return text({
        approved: true,
        event_id: event_id.trim(),
        response: res.body,
        next:
          "One-time exception approved. Re-send the exact original message before it expires; the exception is consumed once and logged in Decision Audit. " +
          "Any change to the input or to the policy result fails to match and stays blocked.",
      });
    },
  },
  {
    name: "flag_false_positive",
    description:
      "Raise a false-positive claim about a detection. This is a claim about the detector and does NOT unblock the request. " +
      "Give event_id, or request_id from the block response's X-Norcaster-Request-Id header, plus the user's reason.",
    inputSchema: {
      type: "object",
      properties: {
        event_id: { type: "string" },
        request_id: { type: "string" },
        reason: { type: "string", minLength: 3, description: "Why the detection was wrong, e.g. documentation fixture / placeholder token." },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    annotations: { title: "Flag false positive", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run({ event_id, request_id, reason } = {}) {
      const missing = missingCredentials();
      if (missing.length) return fail(`Plugin configuration incomplete: ${missing.join(", ")}.`);
      if (typeof reason !== "string" || reason.trim().length < 3) return fail("A reason is required.");
      let id = typeof event_id === "string" && event_id.trim() ? event_id.trim() : "";
      if (!id && typeof request_id === "string" && request_id.trim()) {
        const trace = await apiGet(cfg.apiUrl, `/enforcement-events/trace?request_id=${encodeURIComponent(request_id.trim())}`, cfg.apiKey);
        if (trace.ok && typeof trace.body?.event_id === "string") id = trace.body.event_id;
      }
      if (!id) return fail("Could not resolve the decision record to flag. Open Decision Audit and try from there.");
      const res = await apiPost(cfg.apiUrl, `/enforcement-events/${encodeURIComponent(id)}/claims`, cfg.apiKey, { reason: reason.trim() });
      if (!res.ok) return fail(`Could not raise claim (${explain(res)}).`);
      return text({
        recorded: true,
        event_id: id,
        already_open: Boolean(res.body?.already_open),
        response: res.body,
        note: "The block still stands. Replace the value with a placeholder and resend, or start a new conversation if it lives in earlier history.",
      });
    },
  },
];

TOOLS.push(...consoleTools({ cfg, text, fail, missingCredentials, explain }));

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg ?? {};
  const hasId = id !== undefined && id !== null;
  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0];
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "norcaster", title: "Norcaster Companion", version: MANIFEST.version },
            instructions: INSTRUCTIONS,
          },
        });
      }
      case "ping":
        return send({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ run, ...tool }) => tool) } });
      case "tools/call": {
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) return send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } });
        let result;
        try {
          await ensureDeployment();
          result = await tool.run(params?.arguments ?? {});
        } catch (err) {
          result = fail(`Tool failed: ${err?.message ?? err}`);
        }
        return send({ jsonrpc: "2.0", id, result });
      }
      default:
        if (typeof method === "string" && method.startsWith("notifications/")) return;
        if (hasId) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (hasId) send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    void handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
