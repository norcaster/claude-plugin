import { DEFAULT_API_URL, DEFAULT_PORTAL_URL, normalizeUrl, stateConfigPath, userSettingsPath } from "./paths.mjs";
import { readJsonFile } from "./json-file.mjs";
import { runHelper } from "./credentials.mjs";

/**
 * Plugin configuration: the user's /plugin configure options, as Claude Code exports them to
 * hooks and as .mcp.json hands them to the MCP server (CLAUDE_PLUGIN_OPTION_*, the names the
 * Claude plugin directory accepts). Nothing else in the environment is read for them.
 */
export function pluginConfig(env = process.env) {
  const pick = (name) => String(env[name] ?? "").trim();
  return {
    apiKey: pick("CLAUDE_PLUGIN_OPTION_API_KEY"),
    deploymentId: pick("CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID"),
    apiUrl: normalizeUrl(pick("CLAUDE_PLUGIN_OPTION_API_URL") || DEFAULT_API_URL),
    portalUrl: normalizeUrl(pick("CLAUDE_PLUGIN_OPTION_PORTAL_URL") || DEFAULT_PORTAL_URL),
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

/** What an env block (a process env or a settings.json `env` object) says about routing. Never reads a credential. */
export function routingFromEnv(env) {
  const headers = parseCustomHeaders(env?.ANTHROPIC_CUSTOM_HEADERS);
  return {
    baseUrl: normalizeUrl(env?.ANTHROPIC_BASE_URL),
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
    // Only the token /norcaster:configure itself wrote in env credential mode. A token
    // exported in the user's shell is never read: the plugin uses its own key.
    stored: { ...routingFromEnv(settingsEnv), authToken: String(settingsEnv.ANTHROPIC_AUTH_TOKEN ?? "").trim() },
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
 * The key a hook should use: the plugin's own configuration first, then the key
 * /norcaster:configure stored, as a token in settings.json (env mode) or behind the
 * apiKeyHelper it installed (helper mode). A credential in the user's shell environment
 * is never read (Claude plugin directory policy).
 */
export function resolveApiKey(cfg, routing) {
  return cfg.apiKey || routing.stored.authToken || runHelper(routing.apiKeyHelper);
}
