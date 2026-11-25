#!/usr/bin/env node
/**
 * StopFailure hook: fires when a turn ends on an API error. Claude Code ignores
 * everything we print except `terminalSequence`, so this script does two things:
 *  1. records the block in ~/.claude/norcaster/last-block.json for the status line
 *  2. raises a desktop notification through the terminal
 *
 * A Norcaster block is recognised by its error text, with a recent-event lookup
 * at the gateway as confirmation and as the source of the decision details.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveRouting, pluginConfig, resolveApiKey } from "../lib/config.mjs";
import { apiGet } from "../lib/api.mjs";
import { headlineFor, isNoteworthy, normalizeEvent } from "../lib/events.mjs";
import { writeJsonFile } from "../lib/json-file.mjs";
import { lastBlockPath } from "../lib/paths.mjs";

const RECENT_MS = 3 * 60 * 1000;
const CANDIDATE_ERRORS = new Set(["invalid_request", "authentication_failed", "unknown", "server_error"]);

/** Pick the notification protocol the user's terminal understands; all three are on Claude Code's allowlist. */
export function notificationSequence(title, body, env = process.env) {
  const clean = (s) => String(s).replace(/[\x00-\x1f\x7f;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  const t = clean(title);
  const b = clean(body);
  const program = String(env.TERM_PROGRAM ?? "").toLowerCase();
  const term = String(env.TERM ?? "").toLowerCase();
  if (term.includes("kitty")) return `\x1b]99;;${t}: ${b}\x1b\\`;
  if (program === "iterm.app" || program === "wezterm" || env.WT_SESSION || env.ConEmuANSI) return `\x1b]9;${t}: ${b}\x07`;
  return `\x1b]777;notify;${t};${b}\x07`;
}

export async function main(env = process.env, stdin = "") {
  let input = {};
  try {
    input = JSON.parse(stdin || "{}");
  } catch {
    input = {};
  }
  const errorText = `${input.last_assistant_message ?? ""}\n${input.error_details ?? ""}`;
  const mentionsNorcaster = /norcaster/i.test(errorText);
  if (!mentionsNorcaster && !CANDIDATE_ERRORS.has(input.error)) return null;

  const cfg = pluginConfig(env);
  const routing = effectiveRouting(env);
  const apiUrl = routing.stateConfig?.api_url || cfg.apiUrl;
  const apiKey = resolveApiKey(cfg);
  const deploymentId =
    cfg.deploymentId || routing.live.deploymentId || routing.stored.deploymentId || routing.stateConfig?.deployment_id || "";
  const now = Date.now();

  let recent = [];
  if (apiKey && deploymentId) {
    const res = await apiGet(apiUrl, `/enforcement-events?deployment_id=${encodeURIComponent(deploymentId)}&limit=5`, apiKey, {
      timeoutMs: 6000,
    });
    const events = Array.isArray(res.body?.events) ? res.body.events.map(normalizeEvent) : [];
    recent = events.filter(isNoteworthy).filter((e) => now - Date.parse(e.created_at) < RECENT_MS);
  }
  if (!mentionsNorcaster && recent.length === 0) return null;

  const block = recent[0] ?? { action: "blocked", created_at: new Date(now).toISOString(), source: "error-text" };
  const headline = headlineFor(recent.length ? recent : [block]);
  writeJsonFile(lastBlockPath(), { ...block, headline, recorded_at: new Date(now).toISOString(), error: input.error ?? null });
  return { terminalSequence: notificationSequence("Norcaster", headline) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let stdin = "";
  try {
    stdin = fs.readFileSync(0, "utf8");
  } catch {
    /* no stdin */
  }
  main(process.env, stdin)
    .then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    })
    .catch(() => {
      /* notification is best-effort; never fail the hook */
    });
}
