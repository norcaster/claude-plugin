import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startFakeGateway } from "./fake-gateway.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/user-prompt-submit.mjs", import.meta.url));
const SECRET = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

async function setup(t, options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ncr-prompt-"));
  const gw = await startFakeGateway(options);
  t.after(async () => { await gw.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const env = {
    ...process.env, HOME: home,
    NORCASTER_API_KEY: "", NORCASTER_DEPLOYMENT_ID: "", NORCASTER_API_URL: "", NORCASTER_PORTAL_URL: "",
    CLAUDE_PLUGIN_OPTION_API_KEY: "ncr_test", CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID: "",
    CLAUDE_PLUGIN_OPTION_API_URL: gw.url, CLAUDE_PLUGIN_OPTION_PORTAL_URL: "https://portal.example.test",
    ANTHROPIC_BASE_URL: gw.url, ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_CUSTOM_HEADERS: "",
  };
  // The empty NORCASTER_* variables above must not shadow plugin option values.
  for (const key of Object.keys(env)) if (key.startsWith("NORCASTER_")) delete env[key];
  return { home, gw, env };
}

function run(env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof input === "string" ? input : JSON.stringify({ hook_event_name: "UserPromptSubmit", ...input }));
  });
}

function assertBlocked(result) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes(SECRET), false);
  assert.equal(result.stdout.includes(SECRET.split("=")[1]), false);
  const out = JSON.parse(result.stdout);
  assert.equal(out.decision, "block");
  assert.deepEqual(out.hookSpecificOutput, { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true });
  return out;
}

test("blocked prompt stays out of context and a subsequent clean prompt is silent", async (t) => {
  const { env, gw, home } = await setup(t);
  const transcript = path.join(home, "transcript.jsonl");
  fs.writeFileSync(transcript, "existing history\n");
  const out = assertBlocked(await run(env, { prompt: SECRET, transcript_path: transcript }));
  assert.match(out.reason, /before it entered model context/);
  assert.match(out.reason, /Decision Audit: https:\/\/portal.example.test/);
  const next = await run(env, { prompt: "which branch are we working on?", transcript_path: transcript });
  assert.deepEqual(next, { code: 0, stdout: "", stderr: "" });
  assert.equal(fs.readFileSync(transcript, "utf8"), "existing history\n");
  assert.deepEqual(gw.calls.map((c) => c.body), [{ prompt: SECRET }, { prompt: "which branch are we working on?" }]);
  assert.equal(gw.calls[0].headers["x-norcaster-deployment-id"], undefined);
});

test("uses live deployment routing ahead of plugin defaults", async (t) => {
  const { env, gw } = await setup(t);
  await run({ ...env, ANTHROPIC_CUSTOM_HEADERS: "X-Norcaster-Deployment-Id: live-dep", CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID: "stale-dep" }, { prompt: "hello" });
  assert.equal(gw.calls[0].headers["x-norcaster-deployment-id"], "live-dep");
});

test("does not send prompts when the live session uses another provider", async (t) => {
  const { env, gw, home } = await setup(t);
  fs.mkdirSync(path.join(home, ".claude"));
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: gw.url } }));
  assert.equal((await run({ ...env, ANTHROPIC_BASE_URL: "https://different.example.test" }, { prompt: SECRET })).stdout, "");
  assert.equal(gw.calls.length, 0);
});

for (const status of [401, 403, 404, 429, 500, 503]) {
  test(`HTTP ${status} blocks safely without echoing an error body`, async (t) => {
    const { env } = await setup(t, { promptCheck: () => ({ status, body: { detail: SECRET } }) });
    assert.match(assertBlocked(await run(env, { prompt: SECRET })).reason, /could not check/);
  });
}

for (const body of [null, {}, { scope: "prompt", allowed: "true" }, { allowed: true }, { scope: "full_request", allowed: true }]) {
  test(`malformed success cannot allow a prompt: ${JSON.stringify(body)}`, async (t) => {
    const { env } = await setup(t, { promptCheck: () => ({ status: 200, body }) });
    assertBlocked(await run(env, { prompt: SECRET }));
  });
}

test("missing credentials and malformed hook input block without a network request", async (t) => {
  const { env, gw } = await setup(t);
  assertBlocked(await run({ ...env, CLAUDE_PLUGIN_OPTION_API_KEY: "" }, { prompt: SECRET }));
  assertBlocked(await run(env, "{invalid"));
  assertBlocked(await run(env, {}));
  assertBlocked(await run(env, { prompt: "x".repeat(1_000_001) }));
  assert.equal((await run(env, { prompt: " " })).stdout, "");
  assert.equal(gw.calls.length, 0);
});

test("network failure blocks instead of admitting an unchecked prompt", async (t) => {
  const { env } = await setup(t);
  const url = "http://127.0.0.1:1";
  assertBlocked(await run({ ...env, ANTHROPIC_BASE_URL: url, CLAUDE_PLUGIN_OPTION_API_URL: url }, { prompt: SECRET }));
});

test("manifest blocks on hook crashes and timeouts", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../hooks/hooks.json", import.meta.url)));
  const hook = manifest.hooks.UserPromptSubmit[0].hooks[0];
  assert.equal(hook.onFailure, "block");
  assert.equal(hook.timeout, 15);
  assert.deepEqual(hook.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/user-prompt-submit.mjs"]);
});
