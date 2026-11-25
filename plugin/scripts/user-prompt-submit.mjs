#!/usr/bin/env node
/** Reject submitted prompts before Claude Code adds them to model context.
 * No transcript edits and no prompt persistence. The gateway remains the full-input gate.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decisionAuditUrl, effectiveRouting, pluginConfig, resolveApiKey } from "../lib/config.mjs";
import { apiPost } from "../lib/api.mjs";

function block(reason) {
  return {
    decision: "block",
    reason,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
  };
}

const UNAVAILABLE = "Norcaster could not check this prompt, so it was not submitted. Check the gateway connection and your Companion configuration, then try again.";

export async function main(env = process.env, stdin = "") {
  const cfg = pluginConfig(env);
  const routing = effectiveRouting(env);
  const apiUrl = routing.stateConfig?.api_url || cfg.apiUrl;
  // A stale settings file must not make a session using another provider send
  // its prompts to Norcaster. Live routing takes precedence, as in Claude Code.
  const active = routing.live.baseUrl ? routing.live : routing.stored;
  if (active.baseUrl !== apiUrl) return null;

  let input;
  try {
    input = JSON.parse(stdin);
  } catch {
    return block(UNAVAILABLE);
  }
  if (typeof input?.prompt !== "string") return block(UNAVAILABLE);
  if (!input.prompt.trim()) return null;
  if (input.prompt.length > 1_000_000) {
    return block("Norcaster: this prompt is too large to check. Shorten it to at most 1,000,000 characters and submit it again.");
  }
  const apiKey = resolveApiKey(cfg);
  if (!apiKey) return block(UNAVAILABLE);
  // An absent header lets the server resolve the key's single deployment binding.
  const deploymentId = active.deploymentId || cfg.deploymentId || routing.stateConfig?.deployment_id || "";
  const res = await apiPost(apiUrl, "/v1/policy/check", apiKey, { prompt: input.prompt }, {
    timeoutMs: 8000,
    redirect: "error",
    headers: deploymentId ? { "X-Norcaster-Deployment-Id": deploymentId } : {},
  });
  if (!res.ok || res.body?.scope !== "prompt" || typeof res.body?.allowed !== "boolean") {
    // Do not print arbitrary error bodies: upstream errors may echo submitted text.
    return block(UNAVAILABLE);
  }
  if (res.body.allowed) return null; // No stdout: it would be injected into context.
  const auditUrl = decisionAuditUrl(cfg.portalUrl, res.body.deployment_id || deploymentId);
  return block(
    "Norcaster blocked this prompt before it entered model context. " +
    `${res.body.block_reason || "The prompt matched a blocking policy."} ` +
    `${res.body.prompt_suggestion || "Remove the restricted content and try again."} ` +
    `You can send a corrected prompt or a different question. Decision Audit: ${auditUrl}`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => main(process.env, fs.readFileSync(0, "utf8")))
    .catch(() => block(UNAVAILABLE))
    .then((out) => {
      if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    });
}
