import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { blockedEvent, startFakeGateway } from "./fake-gateway.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/stop-failure.mjs", import.meta.url));
const SESSION_START = fileURLToPath(new URL("../scripts/session-start.mjs", import.meta.url));
const { notificationSequence } = await import("../scripts/stop-failure.mjs");

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ncr-hook-"));
const lastBlock = (home) => path.join(home, ".claude", "norcaster", "last-block.json");
/** Async on purpose: a synchronous spawn would block the event loop the fake gateway answers on. */
function run(script, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ANTHROPIC_BASE_URL: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`))));
    child.stdin.end(JSON.stringify(input));
  });
}
const hookEnv = (home, gwUrl) => ({
  HOME: home,
  CLAUDE_PLUGIN_OPTION_API_KEY: "ncr_test",
  CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID: "dep-1",
  CLAUDE_PLUGIN_OPTION_API_URL: gwUrl,
  TERM_PROGRAM: "iTerm.app",
});

test("StopFailure on a gateway block records it and raises a desktop notification", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ events: [blockedEvent()] });
  t.after(() => gw.close());
  const out = await run(SCRIPT, hookEnv(home, gw.url), {
    hook_event_name: "StopFailure",
    error: "invalid_request",
    error_details: "400 Bad Request",
    last_assistant_message: 'API Error: 400 {"type":"error","error":{"message":"Blocked by policy. Try this: ...","norcaster":{"request_id":"req-1"}}}',
  });
  const json = JSON.parse(out);
  assert.match(json.terminalSequence, /^\x1b\]9;Norcaster: AWS key detected\x07$/);
  const last = JSON.parse(fs.readFileSync(lastBlock(home), "utf8"));
  assert.equal(last.event_id, "evt-1");
  assert.equal(last.headline, "AWS key detected");
  assert.equal(last.error, "invalid_request");
});

test("a recent block is recognised even when the error text does not name Norcaster", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ events: [blockedEvent({ contextual: { detection_origin: "history" } })] });
  t.after(() => gw.close());
  const out = await run(SCRIPT, { ...hookEnv(home, gw.url), TERM_PROGRAM: "", TERM: "xterm-256color" }, { error: "invalid_request", last_assistant_message: "API Error: 400" });
  const json = JSON.parse(out);
  assert.match(json.terminalSequence, /^\x1b\]777;notify;Norcaster;This block is from an earlier message/);
  assert.match(JSON.parse(fs.readFileSync(lastBlock(home), "utf8")).headline, /Start a new conversation/);
});

test("non-Norcaster failures and stale events are ignored", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ events: [blockedEvent({ created_at: "2026-09-13T00:00:00Z" })] });
  t.after(() => gw.close());
  assert.equal(await run(SCRIPT, hookEnv(home, gw.url), { error: "rate_limit", last_assistant_message: "API Error: Rate limit reached" }), "");
  assert.equal(await run(SCRIPT, hookEnv(home, gw.url), { error: "invalid_request", last_assistant_message: "API Error: 400 something else" }), "");
  assert.equal(fs.existsSync(lastBlock(home)), false);
});

test("Norcaster error text still notifies when the gateway cannot be reached", async () => {
  const home = freshHome();
  const out = await run(SCRIPT, { ...hookEnv(home, "http://127.0.0.1:1"), TERM: "xterm-kitty" }, {
    error: "invalid_request",
    last_assistant_message: "API Error: 400 Norcaster blocked this request",
  });
  const json = JSON.parse(out);
  assert.match(json.terminalSequence, /^\x1b\]99;;Norcaster: 1 blocked request at the gateway/);
  assert.equal(JSON.parse(fs.readFileSync(lastBlock(home), "utf8")).source, "error-text");
});

test("notification text is sanitised for the OSC payload", () => {
  const seq = notificationSequence("Norcaster", "a;b\x1b]0;evil\x07 c\n d", { TERM: "xterm" });
  assert.equal(seq, "\x1b]777;notify;Norcaster;a b ]0 evil c d\x07");
});

test("SessionStart warns when not routed and briefs Claude when routed", async () => {
  const home = freshHome();
  const warn = JSON.parse(await run(SESSION_START, { HOME: home, CLAUDE_PLUGIN_OPTION_API_URL: "https://api.example.test" }, { hook_event_name: "SessionStart", source: "startup" }));
  assert.match(warn.systemMessage, /not routed through the Norcaster gateway/);

  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.example.test", ANTHROPIC_AUTH_TOKEN: "k", ANTHROPIC_CUSTOM_HEADERS: "X-Norcaster-Deployment-Id: dep-1\nX-API-Key: k" } }),
  );
  const brief = JSON.parse(await run(SESSION_START, { HOME: home, CLAUDE_PLUGIN_OPTION_API_URL: "https://api.example.test" }, { hook_event_name: "SessionStart", source: "startup" }));
  assert.equal(brief.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(brief.hookSpecificOutput.additionalContext, /deployment dep-1/);
  assert.equal("systemMessage" in brief, false);
});
