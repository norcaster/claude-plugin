import { DEFAULT_API_URL, DEFAULT_PORTAL_URL, normalizeUrl, stateConfigPath, userSettingsPath } from "./paths.mjs";
import { readJsonFile } from "./json-file.mjs";
import { runHelper } from "./credentials.mjs";

/**
 * Plugin configuration as the MCP server sees it (NORCASTER_* from .mcp.json)
 * or as hooks see it (CLAUDE_PLUGIN_OPTION_* exported by Claude Code).
 */
export function pluginConfig(env = process.env) {
  const pick = (a, b) => String(env[a] ?? env[b] ?? "").trim();
  return {
    apiKey: pick("NORCASTER_API_KEY", "CLAUDE_PLUGIN_OPTION_API_KEY"),
    deploymentId: pick("NORCASTER_DEPLOYMENT_ID", "CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID"),
    apiUrl: normalizeUrl(pick("NORCASTER_API_URL", "CLAUDE_PLUGIN_OPTION_API_URL") || DEFAULT_API_URL),
    portalUrl: normalizeUrl(pick("NORCASTER_PORTAL_URL", "CLAUDE_PLUGIN_OPTION_PORTAL_URL") || DEFAULT_PORTAL_URL),
  };
}

export function decisionAuditUrl(portalUrl, deploymentId) {
  return deploymentId
    ? `${portalUrl}/dashboard/deployments/${encodeURIComponent(deploymentId)}?tab=Decision%20Audit`
    : `${portalUrl}/dashboard/deployments`;
}

/** Parse the newline-separated `Header: value` format Claude Code uses for ANTHROPIC_CUSTOM_HEADERS. */
export function parseCustomHeaders(raw) {
  const out = {};
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/** What an env block (a process env or a settings.json `env` object) says about routing. */
export function routingFromEnv(env) {
  const headers = parseCustomHeaders(env?.ANTHROPIC_CUSTOM_HEADERS);
  return {
    baseUrl: normalizeUrl(env?.ANTHROPIC_BASE_URL),
    authToken: String(env?.ANTHROPIC_AUTH_TOKEN ?? "").trim(),
    deploymentId: headers["x-norcaster-deployment-id"] ?? "",
  };
}

/**
 * Effective routing: the live process env first (what this session actually
 * uses), then ~/.claude/settings.json (what the next session will load).
 */
export function effectiveRouting(processEnv = process.env) {
  const settings = readJsonFile(userSettingsPath());
  const settingsEnv =
    settings.ok && settings.value && typeof settings.value.env === "object" && !Array.isArray(settings.value.env)
      ? settings.value.env
      : {};
  const state = readJsonFile(stateConfigPath());
  return {
    live: routingFromEnv(processEnv),
    stored: routingFromEnv(settingsEnv),
    apiKeyHelper: settings.ok && typeof settings.value?.apiKeyHelper === "string" ? settings.value.apiKeyHelper : "",
    settingsMalformed: settings.exists && !settings.ok,
    installed: state.ok && !!state.value,
    stateConfig: state.ok ? state.value : undefined,
  };
}

/** True when either the live env or the stored settings point Claude Code at the gateway. */
export function isRoutedTo(routing, apiUrl) {
  const target = normalizeUrl(apiUrl);
  if (!target) return false;
  return routing.live.baseUrl === target || routing.stored.baseUrl === target;
}

/**
 * The key a hook or the status line should use, in the order Claude Code itself would:
 * the plugin's own configuration, a token in the live env, a token in settings.json,
 * then whatever apiKeyHelper settings.json names (that is how helper mode stores it).
 */
export function resolveApiKey(cfg, routing) {
  return cfg.apiKey || routing.live.authToken || routing.stored.authToken || runHelper(routing.apiKeyHelper);
}
