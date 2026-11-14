#!/usr/bin/env node
/**
 * Norcaster status line for Claude Code.
 *
 * SELF-CONTAINED ON PURPOSE: /norcaster:configure copies this file to
 * ~/.claude/norcaster/statusline.mjs, because the plugin's own directory
 * changes on every plugin update. Do not import from ../lib here.
 *
 * Claude Code runs it with session JSON on stdin (debounced, 300 ms) and on
 * the refreshInterval set in settings. Key validation is cached for 60 s so
 * the script stays cheap. If the user already had a status line, we run it
 * first and print its output above ours, so nothing is lost.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Resolved per call, not at import: the home directory is the only input that varies. */
function paths() {
  const stateDir = path.join(os.homedir(), ".claude", "norcaster");
  return {
    stateDir,
    config: path.join(stateDir, "config.json"),
    lastBlock: path.join(stateDir, "last-block.json"),
    cache: path.join(stateDir, "status-cache.json"),
    settings: path.join(os.homedir(), ".claude", "settings.json"),
  };
}
const BLOCK_VISIBLE_MS = 10 * 60 * 1000;
const CACHE_MS = 60 * 1000;

const ANSI = { green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m" };

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
function normalizeUrl(u) {
  return String(u ?? "").trim().replace(/\/+$/, "");
}
function link(url, text) {
  // OSC 8 hyperlink; terminals without support show plain text.
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
function ago(iso, now) {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
}

export function decisionAuditUrl(portalUrl, deploymentId) {
  return deploymentId
    ? `${portalUrl}/dashboard/deployments/${encodeURIComponent(deploymentId)}?tab=Decision%20Audit`
    : `${portalUrl}/dashboard/deployments`;
}

async function defaultKeyState(apiUrl, apiKey) {
  try {
    const res = await fetch(`${apiUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey },
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) return "governed";
    if (res.status === 401 || res.status === 403) return "invalid-key";
    return "unreachable";
  } catch {
    return "unreachable";
  }
}

/** Run the settings' apiKeyHelper the way Claude Code does (helper mode keeps the key out of settings.json). */
function runHelper(command) {
  if (typeof command !== "string" || !command.trim()) return "";
  try {
    const r = spawnSync(command, { shell: true, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? String(r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}

/** Cached per gateway for 60 s so neither the helper nor the network runs on every keystroke. */
async function cachedKeyState(apiUrl, resolveToken, now, keyState) {
  const p = paths();
  const cache = readJson(p.cache);
  if (cache && cache.api_url === apiUrl && now - Date.parse(cache.checked_at) < CACHE_MS) return cache.state;
  const token = resolveToken();
  const state = token ? await keyState(apiUrl, token) : "no-credential";
  try {
    fs.mkdirSync(p.stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(p.cache, JSON.stringify({ api_url: apiUrl, state, checked_at: new Date(now).toISOString() }), { mode: 0o600 });
  } catch {
    /* cache is best-effort */
  }
  return state;
}

/**
 * Build the display model. `env` is the process env (what this session uses);
 * ~/.claude/settings.json is what the next session loads. Either counts as routed.
 */
export async function computeModel({ env = process.env, now = Date.now(), keyState = defaultKeyState } = {}) {
  const p = paths();
  const cfg = readJson(p.config);
  if (!cfg || !cfg.api_url) return { state: "not-installed" };
  const apiUrl = normalizeUrl(cfg.api_url);
  const settings = readJson(p.settings) ?? {};
  const settingsEnv = settings.env ?? {};
  const liveBase = normalizeUrl(env.ANTHROPIC_BASE_URL);
  const storedBase = normalizeUrl(settingsEnv.ANTHROPIC_BASE_URL);
  const resolveToken = () =>
    // The key /norcaster:configure stored; a token exported in the user's shell is never read.
    String(settingsEnv.ANTHROPIC_AUTH_TOKEN ?? "").trim() || runHelper(settings.apiKeyHelper);
  const base = { deploymentId: cfg.deployment_id ?? "", auditUrl: decisionAuditUrl(normalizeUrl(cfg.portal_url), cfg.deployment_id ?? "") };

  if (liveBase && liveBase !== apiUrl) return { ...base, state: "routed-elsewhere", elsewhere: liveBase };
  if (liveBase !== apiUrl && storedBase !== apiUrl) return { ...base, state: "not-routed" };

  const state = await cachedKeyState(apiUrl, resolveToken, now, keyState);
  const last = readJson(p.lastBlock);
  const block =
    last && last.created_at && now - Date.parse(last.created_at) < BLOCK_VISIBLE_MS
      ? { ...last, ago: ago(last.created_at, now) }
      : null;
  return { ...base, state, block };
}

export function render(model) {
  const shield = "\u{1F6E1}";
  const dep = model.deploymentId ? ` ${ANSI.dim}dep ${String(model.deploymentId).slice(0, 8)}${ANSI.reset}` : "";
  const audit = model.auditUrl ? ` ${ANSI.dim}·${ANSI.reset} ${link(model.auditUrl, "Decision Audit")}` : "";
  switch (model.state) {
    case "not-installed":
      return `${ANSI.yellow}${shield} Norcaster: not configured${ANSI.reset} ${ANSI.dim}· /norcaster:configure${ANSI.reset}`;
    case "not-routed":
      return `${ANSI.yellow}${shield} Norcaster: session not routed through the gateway${ANSI.reset} ${ANSI.dim}· restart Claude Code or run /norcaster:status${ANSI.reset}`;
    case "routed-elsewhere":
      return `${ANSI.yellow}${shield} Norcaster: session routed to ${model.elsewhere}, not the gateway${ANSI.reset} ${ANSI.dim}· /norcaster:status${ANSI.reset}`;
    case "no-credential":
      return `${ANSI.yellow}${shield} Norcaster: routed, but no credential found${ANSI.reset}${dep} ${ANSI.dim}· apiKeyHelper failed? run /norcaster:status${ANSI.reset}`;
    case "invalid-key":
      return `${ANSI.yellow}${shield} Norcaster: key rejected by the gateway${ANSI.reset}${dep} ${ANSI.dim}· /norcaster:status${ANSI.reset}`;
    case "unreachable":
      return `${ANSI.yellow}${shield} Norcaster: gateway unreachable${ANSI.reset}${dep} ${ANSI.dim}· requests will error, not bypass the boundary${ANSI.reset}`;
    case "governed": {
      let line = `${ANSI.green}${shield} Norcaster: Governed${ANSI.reset}${dep}${audit}`;
      if (model.block) {
        const what = model.block.action === "blocked" ? "blocked" : "redacted";
        const notice = model.block.notice ? ` — ${String(model.block.notice).slice(0, 90)}` : "";
        const forward = model.block.forwarding?.can_approve ? " · Forward once available" : "";
        line += `\n${ANSI.red}⛔ Norcaster ${what} a request ${model.block.ago}${ANSI.reset}${notice}${forward} ${ANSI.dim}· /norcaster:events${ANSI.reset}`;
      }
      return line;
    }
    default:
      return `${ANSI.yellow}${shield} Norcaster: ${model.state}${ANSI.reset}`;
  }
}

function runPrevious(input) {
  const prev = readJson(paths().config)?.previous_status_line;
  if (!prev || typeof prev !== "object" || typeof prev.command !== "string" || !prev.command.trim()) return "";
  try {
    const r = spawnSync(prev.command, { shell: true, input, encoding: "utf8", timeout: 3000 });
    return (r.stdout ?? "").replace(/\s+$/, "");
  } catch {
    return "";
  }
}

async function main() {
  let input = "";
  try {
    input = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  const previous = runPrevious(input);
  const model = await computeModel();
  const ours = render(model);
  process.stdout.write(previous ? `${previous}\n${ours}\n` : `${ours}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(`${ANSI.yellow}\u{1F6E1} Norcaster: status unavailable${ANSI.reset}\n`);
  });
}
