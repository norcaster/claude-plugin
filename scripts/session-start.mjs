#!/usr/bin/env node
/**
 * SessionStart hook. Two jobs:
 *  - not governed: warn the user (systemMessage) and point at /norcaster:configure
 *  - governed: brief Claude in two sentences so a gateway block is explained as the
 *    policy boundary working, not as a network error (additionalContext)
 */
import fs from "node:fs";
import { effectiveRouting, isRoutedTo, pluginConfig } from "../lib/config.mjs";

try {
  fs.readFileSync(0, "utf8");
} catch {
  /* stdin not needed */
}

const cfg = pluginConfig();
const routing = effectiveRouting();
const apiUrl = routing.stateConfig?.api_url || cfg.apiUrl;

if (isRoutedTo(routing, apiUrl)) {
  const dep = routing.live.deploymentId || routing.stored.deploymentId || cfg.deploymentId;
  const additionalContext =
    `This Claude Code session is routed through the Norcaster AI Runtime Control Plane gateway${dep ? ` (deployment ${dep})` : ""}: ` +
    "input policy is enforced before the model provider and every decision is recorded in Decision Audit. " +
    "If an API request fails with a Norcaster policy block, tell the user it is the governance boundary working, not a network error; " +
    "a detection that lives in an earlier message cannot be cleared by editing the latest one (start a new conversation); " +
    "/norcaster:events shows the decision and offers Forward once when the workspace owner has permitted it.";
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } })}\n`);
} else {
  process.stdout.write(
    `${JSON.stringify({
      systemMessage:
        "Norcaster: this session is not routed through the Norcaster gateway, so its traffic is not governed. Run /norcaster:configure to set it up, or /norcaster:status for details.",
    })}\n`,
  );
}
