import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { computeModel, render } = await import("../scripts/statusline.mjs");

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "");

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ncr-sl-"));
  process.env.HOME = home;
  return home;
}
function install(home, { block, settings } = {}) {
  const dir = path.join(home, ".claude", "norcaster");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ api_url: "https://api.example.test", portal_url: "https://portal.example.test", deployment_id: "dep-12345678" }),
  );
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify(settings ?? { env: { ANTHROPIC_BASE_URL: "https://api.example.test/", ANTHROPIC_AUTH_TOKEN: "ncr_secret" } }),
  );
  if (block) fs.writeFileSync(path.join(dir, "last-block.json"), JSON.stringify(block));
}
const governed = async () => "governed";

test("not installed", async () => {
  freshHome();
  const m = await computeModel({ env: {} });
  assert.equal(m.state, "not-installed");
  assert.match(strip(render(m)), /not configured .* \/norcaster:configure/);
});

test("governed via settings.json, key check cached", async () => {
  const home = freshHome();
  install(home);
  let calls = 0;
  const keyState = async () => {
    calls++;
    return "governed";
  };
  const m = await computeModel({ env: {}, keyState });
  assert.equal(m.state, "governed");
  assert.equal(m.block, null);
  const out = strip(render(m));
  assert.match(out, /Norcaster: Governed/);
  assert.match(out, /dep dep-1234/);
  assert.match(out, /Decision Audit/);
  assert.ok(render(m).includes("https://portal.example.test/dashboard/deployments/dep-12345678?tab=Decision%20Audit"));
  await computeModel({ env: {}, keyState });
  assert.equal(calls, 1, "second call within 60s uses the cache");
});

test("live env pointing elsewhere wins over settings", async () => {
  const home = freshHome();
  install(home);
  const m = await computeModel({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, keyState: governed });
  assert.equal(m.state, "routed-elsewhere");
  assert.match(strip(render(m)), /routed to https:\/\/api.anthropic.com/);
});

test("recent block is shown with notice and forward hint; old block is not", async () => {
  const home = freshHome();
  install(home, {
    block: {
      action: "blocked",
      created_at: new Date(Date.now() - 65_000).toISOString(),
      notice: "AWS key detected",
      forwarding: { can_approve: true },
    },
  });
  const m = await computeModel({ env: {}, keyState: governed });
  assert.ok(m.block);
  const out = strip(render(m));
  assert.match(out, /blocked a request 1m ago/);
  assert.match(out, /AWS key detected/);
  assert.match(out, /Forward once available/);
  assert.match(out, /\/norcaster:events/);

  const home2 = freshHome();
  install(home2, { block: { action: "blocked", created_at: new Date(Date.now() - 20 * 60_000).toISOString() } });
  const m2 = await computeModel({ env: {}, keyState: governed });
  assert.equal(m2.block, null);
});

test("invalid key and unreachable gateway render as warnings", async () => {
  const home = freshHome();
  install(home);
  const bad = await computeModel({ env: {}, keyState: async () => "invalid-key" });
  assert.match(strip(render(bad)), /key rejected/);
  const home2 = freshHome();
  install(home2);
  const down = await computeModel({ env: {}, keyState: async () => "unreachable" });
  assert.match(strip(render(down)), /gateway unreachable/);
});

test("not routed when neither env nor settings point at the gateway", async () => {
  const home = freshHome();
  install(home, { settings: { env: { OTHER: "x" } } });
  const m = await computeModel({ env: {}, keyState: governed });
  assert.equal(m.state, "not-routed");
  assert.match(strip(render(m)), /not routed through the gateway/);
});

test("helper mode: the token comes from apiKeyHelper; a failing helper shows no-credential", async () => {
  const home = freshHome();
  install(home, { settings: { env: { ANTHROPIC_BASE_URL: "https://api.example.test" }, apiKeyHelper: "echo ncr_from_helper" } });
  let seen;
  const m = await computeModel({ env: {}, keyState: async (_url, token) => ((seen = token), "governed") });
  assert.equal(m.state, "governed");
  assert.equal(seen, "ncr_from_helper");

  const home2 = freshHome();
  install(home2, { settings: { env: { ANTHROPIC_BASE_URL: "https://api.example.test" }, apiKeyHelper: "false" } });
  const m2 = await computeModel({ env: {}, keyState: governed });
  assert.equal(m2.state, "no-credential");
  assert.match(strip(render(m2)), /no credential found/);
});

test("a token exported in the user's shell is never read (directory policy)", async () => {
  const home = freshHome();
  install(home, { settings: { env: { ANTHROPIC_BASE_URL: "https://api.example.test" }, apiKeyHelper: "echo ncr_from_helper" } });
  let seen;
  const m = await computeModel({
    env: { ANTHROPIC_BASE_URL: "https://api.example.test", ANTHROPIC_AUTH_TOKEN: "ncr_from_shell" },
    keyState: async (_url, token) => ((seen = token), "governed"),
  });
  assert.equal(m.state, "governed");
  assert.equal(seen, "ncr_from_helper", "the stored key, not the shell's");

  const home2 = freshHome();
  install(home2, { settings: { env: { ANTHROPIC_BASE_URL: "https://api.example.test" } } });
  let checked = false;
  const m2 = await computeModel({
    env: { ANTHROPIC_AUTH_TOKEN: "ncr_from_shell" },
    keyState: async () => ((checked = true), "governed"),
  });
  assert.equal(m2.state, "no-credential");
  assert.equal(checked, false, "the shell's token is never sent to the gateway");
});
