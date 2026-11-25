import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { planConfigure, applyConfigure, planRemove, applyRemove, isOurStatusline } = await import("../plugin/lib/claude-settings.mjs");

const STATUSLINE_SRC = fileURLToPath(new URL("../plugin/scripts/statusline.mjs", import.meta.url));
const HELPER_SRC = fileURLToPath(new URL("../plugin/scripts/api-key-helper.mjs", import.meta.url));
// env mode: the VS Code extension's behaviour (key in settings.json). Kept explicit; the default is helper mode.
const params = {
  apiUrl: "https://api.example.test",
  portalUrl: "https://portal.example.test",
  deploymentId: "dep-123",
  apiKey: "ncr_secret",
  credentialMode: "env",
  statuslineSource: STATUSLINE_SRC,
  helperSource: HELPER_SRC,
  pluginVersion: "0.1.0",
};
const keyFile = (home) => path.join(home, ".claude", "norcaster", "api-key");
// helper mode with the file store: HOME-scoped, so each test gets its own key file.
const helperParams = () => ({ ...params, credentialMode: "helper", storeName: "file" });

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ncr-home-"));
  process.env.HOME = home;
  return home;
}
const settingsPath = (home) => path.join(home, ".claude", "settings.json");
const readSettings = (home) => JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
const readState = (home) => JSON.parse(fs.readFileSync(path.join(home, ".claude", "norcaster", "config.json"), "utf8"));
function writeSettings(home, obj) {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPath(home), typeof obj === "string" ? obj : JSON.stringify(obj));
}

test("configure merges env and status line, preserving other settings", () => {
  const home = freshHome();
  writeSettings(home, {
    permissions: { allow: ["Bash(ls)"] },
    env: { FOO: "bar" },
    statusLine: { type: "command", command: "echo mine" },
  });
  const plan = planConfigure(params);
  assert.equal(plan.ok, true);
  assert.ok(!JSON.stringify(plan).includes("ncr_secret"), "the plan must never reveal the key");

  const result = applyConfigure(params);
  assert.equal(result.ok, true);
  const s = readSettings(home);
  assert.deepEqual(s.permissions, { allow: ["Bash(ls)"] });
  assert.equal(s.env.FOO, "bar");
  assert.equal(s.env.ANTHROPIC_BASE_URL, "https://api.example.test");
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, "ncr_secret");
  assert.equal(s.env.ANTHROPIC_CUSTOM_HEADERS, "X-Norcaster-Deployment-Id: dep-123\nX-API-Key: ncr_secret");
  assert.ok(isOurStatusline(s.statusLine));
  assert.deepEqual(readState(home).previous_status_line, { type: "command", command: "echo mine" });
  assert.ok(fs.existsSync(path.join(home, ".claude", "norcaster", "statusline.mjs")));
  assert.equal(fs.statSync(settingsPath(home)).mode & 0o777, 0o600);
});

test("re-running configure keeps the user's original status line and updates the deployment", () => {
  const home = freshHome();
  writeSettings(home, { statusLine: { type: "command", command: "echo original" } });
  applyConfigure(params);
  applyConfigure({ ...params, deploymentId: "dep-456" });
  const state = readState(home);
  assert.equal(state.previous_status_line.command, "echo original");
  assert.equal(state.deployment_id, "dep-456");
  assert.ok(readSettings(home).env.ANTHROPIC_CUSTOM_HEADERS.includes("dep-456"));
});

test("remove deletes only the three keys across user and project files and restores the status line", () => {
  const home = freshHome();
  writeSettings(home, { env: { FOO: "bar" }, statusLine: { type: "command", command: "echo mine" } });
  applyConfigure(params);
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "ncr-proj-"));
  fs.mkdirSync(path.join(project, ".claude"));
  fs.writeFileSync(
    path.join(project, ".claude", "settings.local.json"),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://api.example.test", KEEP: "1" }, model: "opus" }),
  );

  const plan = planRemove([project]);
  assert.equal(plan.hits.length, 2);
  assert.deepEqual(plan.statusline, { restore_to: { type: "command", command: "echo mine" } });
  assert.equal(plan.nothing_to_do, false);

  const result = applyRemove([project]);
  assert.equal(result.ok, true);
  assert.equal(result.removed.length, 2);
  assert.equal(result.statusline_restored, true);
  assert.match(result.message, /no longer governed/);
  assert.deepEqual(readSettings(home), { env: { FOO: "bar" }, statusLine: { type: "command", command: "echo mine" } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.local.json"), "utf8")), {
    env: { KEEP: "1" },
    model: "opus",
  });
  assert.equal(fs.existsSync(path.join(home, ".claude", "norcaster")), false);
});

test("remove with no previous status line drops ours and empties env cleanly", () => {
  const home = freshHome();
  applyConfigure(params);
  const result = applyRemove([]);
  assert.equal(result.ok, true);
  const s = readSettings(home);
  assert.equal("env" in s, false);
  assert.equal("statusLine" in s, false);
  assert.equal(planRemove([]).nothing_to_do, true);
});

test("malformed settings files are reported and never rewritten", () => {
  const home = freshHome();
  writeSettings(home, "{ not json");
  const plan = planConfigure(params);
  assert.equal(plan.ok, false);
  assert.match(plan.problems.join(" "), /not valid JSON/);
  assert.equal(applyConfigure(params).ok, false);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), "{ not json");
  const rm = applyRemove([]);
  assert.deepEqual(rm.malformed, ["~/.claude/settings.json"]);
  assert.match(rm.message, /Skipped/);
});

test("plan refuses without a key or deployment", () => {
  freshHome();
  const plan = planConfigure({ apiUrl: "https://api.example.test", deploymentId: "", apiKey: "" });
  assert.equal(plan.ok, false);
  assert.equal(plan.problems.length, 2);
});

test("helper mode keeps the key out of settings.json and in the store", () => {
  const home = freshHome();
  writeSettings(home, { env: { FOO: "bar" } });
  const plan = planConfigure(helperParams());
  assert.equal(plan.ok, true);
  assert.equal(plan.credential_mode, "helper");
  assert.ok(!JSON.stringify(plan).includes("ncr_secret"));
  assert.ok(plan.writes.some((w) => w.key === "apiKeyHelper"));
  assert.ok(!plan.writes.some((w) => w.key === "env.ANTHROPIC_AUTH_TOKEN"));

  const result = applyConfigure(helperParams());
  assert.equal(result.ok, true);
  const s = readSettings(home);
  assert.deepEqual(s.env, { FOO: "bar", ANTHROPIC_BASE_URL: "https://api.example.test", ANTHROPIC_CUSTOM_HEADERS: "X-Norcaster-Deployment-Id: dep-123" });
  assert.ok(s.apiKeyHelper.includes(path.join("norcaster", "api-key-helper.mjs")));
  assert.equal(fs.readFileSync(keyFile(home), "utf8").trim(), "ncr_secret");
  assert.equal(fs.statSync(keyFile(home)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, ".claude", "norcaster", "api-key-helper.mjs")).mode & 0o777, 0o700);
  assert.deepEqual(readState(home).credential, { mode: "helper", store: "file", account: "https://api.example.test", service: "norcaster-claude-code" });
  assert.ok(!fs.readFileSync(settingsPath(home), "utf8").includes("ncr_secret"), "settings.json never contains the key");
});

test("switching env → helper removes the plaintext token; the user's own apiKeyHelper is preserved and restored", () => {
  const home = freshHome();
  writeSettings(home, { apiKeyHelper: "my-vault-helper" });
  applyConfigure(params);
  assert.equal(readSettings(home).env.ANTHROPIC_AUTH_TOKEN, "ncr_secret");
  const plan = planConfigure(helperParams());
  assert.ok(plan.writes.some((w) => w.key === "env.ANTHROPIC_AUTH_TOKEN" && /removed/.test(w.value)));
  applyConfigure(helperParams());
  const s = readSettings(home);
  assert.equal("ANTHROPIC_AUTH_TOKEN" in s.env, false);
  assert.equal(readState(home).previous_api_key_helper, "my-vault-helper");
  // re-run keeps the original
  applyConfigure(helperParams());
  assert.equal(readState(home).previous_api_key_helper, "my-vault-helper");

  const rmPlan = planRemove([]);
  assert.deepEqual(rmPlan.api_key_helper, { restore_to: "my-vault-helper" });
  const rm = applyRemove([]);
  assert.equal(rm.ok, true);
  assert.equal(rm.api_key_helper_restored, true);
  assert.equal(rm.credential_removed, true);
  assert.equal(fs.existsSync(keyFile(home)), false, "stored key deleted");
  assert.deepEqual(readSettings(home), { apiKeyHelper: "my-vault-helper" });
});

test("switching helper → env removes the helper and the stored key", () => {
  const home = freshHome();
  applyConfigure(helperParams());
  assert.ok(fs.existsSync(keyFile(home)));
  applyConfigure(params);
  assert.equal(fs.existsSync(keyFile(home)), false, "stored key removed when leaving helper mode");
  const s = readSettings(home);
  assert.equal(s.env.ANTHROPIC_AUTH_TOKEN, "ncr_secret");
  assert.equal("apiKeyHelper" in s, false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "norcaster", "api-key-helper.mjs")), false);
  assert.deepEqual(readState(home).credential, { mode: "env" });
});

test("plan warns about a competing ANTHROPIC_API_KEY", () => {
  const home = freshHome();
  writeSettings(home, { env: { ANTHROPIC_API_KEY: "sk-ant-other" } });
  const plan = planConfigure(helperParams());
  assert.equal(plan.ok, true);
  assert.match(plan.warnings.join(" "), /ANTHROPIC_API_KEY/);
});

test("a key bound to one deployment: no deployment header in either mode; re-running drops an earlier one", () => {
  const home = freshHome();
  applyConfigure(helperParams());
  assert.equal(readSettings(home).env.ANTHROPIC_CUSTOM_HEADERS, "X-Norcaster-Deployment-Id: dep-123");

  const plan = planConfigure({ ...helperParams(), deploymentHeader: false });
  assert.equal(plan.ok, true);
  assert.deepEqual(
    plan.writes.find((w) => w.key === "env.ANTHROPIC_CUSTOM_HEADERS"),
    { file: "~/.claude/settings.json", key: "env.ANTHROPIC_CUSTOM_HEADERS", value: "(removed — the key's binding names the deployment)" },
  );
  applyConfigure({ ...helperParams(), deploymentHeader: false });
  assert.equal("ANTHROPIC_CUSTOM_HEADERS" in readSettings(home).env, false);
  assert.equal(readState(home).deployment_id, "dep-123");

  applyConfigure({ ...params, deploymentHeader: false });
  assert.equal(readSettings(home).env.ANTHROPIC_CUSTOM_HEADERS, "X-API-Key: ncr_secret");
});

test("plan reports why there is no deployment when the binding lookup says so", () => {
  freshHome();
  const plan = planConfigure({ ...params, deploymentId: "", deploymentProblem: "bound to deployment dep-1, not dep-2" });
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.problems, ["bound to deployment dep-1, not dep-2"]);
});
