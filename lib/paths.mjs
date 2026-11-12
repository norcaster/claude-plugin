import os from "node:os";
import path from "node:path";

/** The env keys configure owns — and the only ones remove deletes. Same set as the VS Code extension. */
export const CLAUDE_ENV_KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS"];

export const DEFAULT_API_URL = "https://api.norcaster.com";
export const DEFAULT_PORTAL_URL = "https://www.norcaster.com";

/** How long a block stays visible in the status line. */
export const BLOCK_VISIBLE_MS = 10 * 60 * 1000;
/** How long a key-validation result is reused by the status line. */
export const STATUS_CACHE_MS = 60 * 1000;

export function homeDir() {
  return os.homedir();
}
export function claudeDir() {
  return path.join(homeDir(), ".claude");
}
export function userSettingsPath() {
  return path.join(claudeDir(), "settings.json");
}
/** Plugin-owned state, outside the plugin directory because that path changes on update. */
export function stateDir() {
  return path.join(claudeDir(), "norcaster");
}
export function stateConfigPath() {
  return path.join(stateDir(), "config.json");
}
export function lastBlockPath() {
  return path.join(stateDir(), "last-block.json");
}
export function statusCachePath() {
  return path.join(stateDir(), "status-cache.json");
}
export function installedStatuslinePath() {
  return path.join(stateDir(), "statusline.mjs");
}

export function normalizeUrl(u) {
  return String(u ?? "").trim().replace(/\/+$/, "");
}

export function displayHome(p) {
  const h = homeDir();
  return p.startsWith(h) ? `~${p.slice(h.length)}` : p;
}
