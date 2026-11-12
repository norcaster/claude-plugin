#!/usr/bin/env node
/**
 * Claude Code apiKeyHelper for the Norcaster gateway.
 *
 * SELF-CONTAINED ON PURPOSE: /norcaster:configure copies this file to
 * ~/.claude/norcaster/api-key-helper.mjs (the plugin's own path changes on
 * update). Claude Code runs it, caches the output for five minutes, and sends
 * the value in both the Authorization and x-api-key headers.
 *
 * Prints nothing but the key: a banner or log line here makes the helper fail.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const dir = path.join(os.homedir(), ".claude", "norcaster");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
} catch {
  fail("Norcaster: ~/.claude/norcaster/config.json is missing; run /norcaster:configure");
}
const cred = cfg.credential ?? {};
let key = "";
if (cred.store === "keychain") {
  try {
    key = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", cred.service || "norcaster-claude-code", "-a", String(cred.account ?? ""), "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    fail("Norcaster: the gateway key is not in the Keychain; run /norcaster:configure");
  }
} else {
  try {
    key = fs.readFileSync(path.join(dir, "api-key"), "utf8").trim();
  } catch {
    fail("Norcaster: the gateway key file is missing; run /norcaster:configure");
  }
}
if (!key) fail("Norcaster: the stored gateway key is empty; run /norcaster:configure");
process.stdout.write(`${key}\n`);
