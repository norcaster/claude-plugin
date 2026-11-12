import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockedEvent, startFakeGateway } from "./fake-gateway.mjs";
import { startServer } from "./mcp-client.mjs";

const freshHome = () => fs.mkdtempSync(path.join(os.tmpdir(), "ncr-srv-"));
const env = (gw, home, extra = {}) => ({
  HOME: home,
  NORCASTER_API_KEY: "ncr_test",
  NORCASTER_DEPLOYMENT_ID: "dep-1",
  NORCASTER_API_URL: gw.url,
  NORCASTER_PORTAL_URL: "https://portal.example.test",
  NORCASTER_CREDENTIAL_STORE: "file",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  ...extra,
});

test("handshake, tool list, status, events, forward once, false positive, unknown method", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ events: [blockedEvent(), { event_id: "evt-2", action_taken: "allowed", created_at: "2026-09-14T09:00:00Z" }] });
  const srv = startServer(env(gw, home));
  t.after(async () => {
    srv.close();
    await gw.close();
  });

  const init = await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "norcaster");
  assert.match(init.result.instructions, /mode "plan" first/);
  srv.notify("notifications/initialized");

  const list = await srv.request("tools/list");
  assert.deepEqual(
    list.result.tools.map((x) => x.name).sort(),
    [
      "check_status", "configure_claude_code", "flag_false_positive", "forward_once", "get_compliance_report", "get_deployment",
      "get_deployment_costs", "get_deployment_errors", "get_deployment_metrics", "get_run", "get_run_trace", "list_deployments",
      "list_enforcement_events", "list_runs", "remove_claude_code_config", "simulate_policy",
    ],
  );
  assert.ok(list.result.tools.every((x) => typeof x.annotations?.readOnlyHint === "boolean" && x.inputSchema?.type === "object"));
  assert.ok(list.result.tools.every((x) => !("run" in x)));

  const status = await srv.callTool("check_status");
  assert.equal(status.isError, false);
  assert.equal(status.data.state, "key-valid-not-routed");
  assert.equal(status.data.decision_audit_url, "https://portal.example.test/dashboard/deployments/dep-1?tab=Decision%20Audit");
  assert.equal(status.data.statusline_installed, false);

  const events = await srv.callTool("list_enforcement_events", { limit: 5 });
  assert.equal(events.data.count, 1, "allowed events are filtered out by default");
  assert.equal(events.data.events[0].notice, "AWS key detected");
  assert.deepEqual(events.data.events[0].rules, ["aws_access_key"]);
  assert.equal(events.data.events[0].forwarding.can_approve, true);
  const listCall = gw.calls.find((c) => c.path === "/enforcement-events");
  assert.equal(listCall.query.deployment_id, "dep-1");
  assert.equal(listCall.query.limit, "5");
  assert.equal(listCall.headers["x-api-key"], "ncr_test");
  assert.equal(listCall.headers.authorization, "Bearer ncr_test");

  const all = await srv.callTool("list_enforcement_events", { only_actionable: false });
  assert.equal(all.data.count, 2);

  const noConfirm = await srv.callTool("forward_once", { event_id: "evt-1" });
  assert.equal(noConfirm.isError, true);
  assert.match(noConfirm.data.confirmation_text, /Approve one exact retry/);
  assert.equal(gw.calls.some((c) => c.path.endsWith("/forward-once")), false, "no network call without confirmation");

  const fwd = await srv.callTool("forward_once", { event_id: "evt-1", confirm: true });
  assert.equal(fwd.isError, false);
  assert.equal(fwd.data.approved, true);
  assert.match(fwd.data.next, /exact original message/);

  const notEligible = await srv.callTool("forward_once", { event_id: "evt-nope", confirm: true });
  assert.equal(notEligible.isError, true);
  assert.match(notEligible.data.error, /not eligible/);

  const claim = await srv.callTool("flag_false_positive", { request_id: "req-9", reason: "documentation fixture" });
  assert.equal(claim.isError, false);
  assert.equal(claim.data.event_id, "evt-from-trace");
  assert.equal(gw.calls.find((c) => c.path === "/enforcement-events/trace").query.request_id, "req-9");
  assert.deepEqual(gw.calls.find((c) => c.path === "/enforcement-events/evt-from-trace/claims").body, { reason: "documentation fixture" });

  const unknown = await srv.request("nope/method");
  assert.equal(unknown.error.code, -32601);
  const unknownTool = await srv.request("tools/call", { name: "nope", arguments: {} });
  assert.equal(unknownTool.error.code, -32602);
});

test("configure plan then apply writes settings; status flips to governed; remove undoes it", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway();
  const srv = startServer(env(gw, home));
  t.after(async () => {
    srv.close();
    await gw.close();
  });
  await srv.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

  const plan = await srv.callTool("configure_claude_code", { mode: "plan" });
  assert.equal(plan.isError, false);
  assert.equal(plan.data.ok, true);
  assert.ok(!JSON.stringify(plan.raw).includes("ncr_test"), "plan output must not contain the key");
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false, "plan writes nothing");

  const apply = await srv.callTool("configure_claude_code", { mode: "apply" });
  assert.equal(apply.isError, false);
  assert.equal(apply.data.gateway_reachable, true);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, gw.url);
  assert.equal("ANTHROPIC_AUTH_TOKEN" in settings.env, false, "helper mode: no plaintext token");
  assert.equal(settings.env.ANTHROPIC_CUSTOM_HEADERS, "X-Norcaster-Deployment-Id: dep-1");
  assert.ok(settings.apiKeyHelper.includes(path.join("norcaster", "api-key-helper.mjs")));
  assert.ok(settings.statusLine.command.includes(path.join("norcaster", "statusline.mjs")));
  assert.equal(fs.readFileSync(path.join(home, ".claude", "norcaster", "api-key"), "utf8").trim(), "ncr_test");
  assert.equal(apply.data.credential_mode, "helper");
  assert.equal(apply.data.credential_store, "file");

  const status = await srv.callTool("check_status");
  assert.equal(status.data.state, "governed");
  assert.equal(status.data.settings_json_routes_through_gateway, true);
  assert.equal(status.data.settings_json_deployment_id, "dep-1");
  assert.equal(status.data.statusline_installed, true);
  assert.equal(status.data.credential_mode, "helper");
  assert.equal(status.data.api_key_helper_installed, true);
  assert.equal(status.data.settings_json_has_plaintext_token, false);

  const envMode = await srv.callTool("configure_claude_code", { mode: "apply", credential_mode: "env" });
  assert.equal(envMode.isError, false);
  const s2 = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(s2.env.ANTHROPIC_AUTH_TOKEN, "ncr_test");
  assert.equal("apiKeyHelper" in s2, false);
  assert.equal(fs.existsSync(path.join(home, ".claude", "norcaster", "api-key")), false, "stored key removed when leaving helper mode");
  const st2 = await srv.callTool("check_status");
  assert.equal(st2.data.credential_mode, "env");
  assert.equal(st2.data.settings_json_has_plaintext_token, true);

  const rmPlan = await srv.callTool("remove_claude_code_config", { mode: "plan", project_dirs: ["relative/ignored"] });
  assert.equal(rmPlan.data.hits.length, 1);
  const rm = await srv.callTool("remove_claude_code_config", { mode: "apply" });
  assert.equal(rm.data.ok, true);
  assert.match(rm.data.message, /no longer governed/);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal("env" in after, false);
  assert.equal("statusLine" in after, false);
});

test("a key bound to one deployment needs no deployment ID and gets no deployment header", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ keyBinding: ["dep-1"], events: [blockedEvent()] });
  const srv = startServer(env(gw, home, { NORCASTER_DEPLOYMENT_ID: "" }));
  t.after(async () => {
    srv.close();
    await gw.close();
  });
  const plan = await srv.callTool("configure_claude_code", { mode: "plan" });
  assert.equal(plan.data.ok, true);
  assert.ok(!plan.data.writes.some((w) => w.key === "env.ANTHROPIC_CUSTOM_HEADERS"), "no header write in helper mode");
  assert.match(plan.data.warnings.join(" "), /bound to deployment dep-1/);
  assert.equal("recommendation" in plan.data, false, "no recommendation once the key is bound");

  const apply = await srv.callTool("configure_claude_code", { mode: "apply" });
  assert.equal(apply.isError, false);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal("ANTHROPIC_CUSTOM_HEADERS" in settings.env, false);
  const state = JSON.parse(fs.readFileSync(path.join(home, ".claude", "norcaster", "config.json"), "utf8"));
  assert.equal(state.deployment_id, "dep-1");

  const envMode = await srv.callTool("configure_claude_code", { mode: "apply", credential_mode: "env" });
  assert.equal(envMode.isError, false);
  const s2 = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(s2.env.ANTHROPIC_CUSTOM_HEADERS, "X-API-Key: ncr_test");

  const status = await srv.callTool("check_status");
  assert.equal(status.data.deployment_id, "dep-1");
  assert.equal(status.data.deployment_id_from_key_binding, true);
  assert.deepEqual(status.data.plugin_config_missing, []);
  const events = await srv.callTool("list_enforcement_events");
  assert.equal(events.isError, false);
  assert.equal(gw.calls.find((c) => c.path === "/enforcement-events").query.deployment_id, "dep-1");
});

test("a bound key keeps a matching deployment ID header-less and refuses a different one", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ keyBinding: ["dep-1"] });
  const same = startServer(env(gw, home));
  const other = startServer(env(gw, home, { NORCASTER_DEPLOYMENT_ID: "dep-2" }));
  t.after(async () => {
    same.close();
    other.close();
    await gw.close();
  });
  const ok = await same.callTool("configure_claude_code", { mode: "plan" });
  assert.equal(ok.data.ok, true);
  assert.ok(!ok.data.writes.some((w) => w.key === "env.ANTHROPIC_CUSTOM_HEADERS"));
  const refused = await other.callTool("configure_claude_code", { mode: "apply" });
  assert.equal(refused.isError, true);
  assert.match(refused.data.problems.join(" "), /bound to deployment dep-1.*deployment ID is dep-2/);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
});

test("an unbound key, or an older gateway without the api_key block, keeps the header", async (t) => {
  for (const keyBinding of [null, ["dep-1", "dep-2"], undefined]) {
    const home = freshHome();
    const gw = await startFakeGateway({ keyBinding });
    const srv = startServer(env(gw, home));
    const plan = await srv.callTool("configure_claude_code", { mode: "plan" });
    assert.deepEqual(
      plan.data.writes.find((w) => w.key === "env.ANTHROPIC_CUSTOM_HEADERS"),
      { file: "~/.claude/settings.json", key: "env.ANTHROPIC_CUSTOM_HEADERS", value: "X-Norcaster-Deployment-Id: dep-1" },
    );
    assert.match(plan.data.recommendation, /dashboard\/connect-tool\?tool=claude_code/);
    const missing = startServer(env(gw, home, { NORCASTER_DEPLOYMENT_ID: "" }));
    const refused = await missing.callTool("configure_claude_code", { mode: "plan" });
    assert.equal(refused.data.ok, false);
    assert.match(refused.data.problems.join(" "), /X-Norcaster-Deployment-Id header unless the API key is bound/);
    srv.close();
    missing.close();
    await gw.close();
  }
});

test("apply refuses to write when the gateway rejects the key", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway({ validKey: "ncr_other" });
  const srv = startServer(env(gw, home));
  t.after(async () => {
    srv.close();
    await gw.close();
  });
  const apply = await srv.callTool("configure_claude_code", { mode: "apply" });
  assert.equal(apply.isError, true);
  assert.match(apply.data.error, /rejected the configured key/);
  assert.equal(fs.existsSync(path.join(home, ".claude", "settings.json")), false);
  const status = await srv.callTool("check_status");
  assert.equal(status.data.state, "invalid-key");
});

test("missing plugin configuration is reported, not guessed", async (t) => {
  const home = freshHome();
  const gw = await startFakeGateway();
  const srv = startServer(env(gw, home, { NORCASTER_API_KEY: "", NORCASTER_DEPLOYMENT_ID: "" }));
  t.after(async () => {
    srv.close();
    await gw.close();
  });
  const status = await srv.callTool("check_status");
  assert.equal(status.data.state, "no-key");
  assert.deepEqual(status.data.plugin_config_missing, ["api_key", "deployment_id"]);
  const plan = await srv.callTool("configure_claude_code", { mode: "plan" });
  assert.equal(plan.data.ok, false);
  assert.equal(plan.data.problems.length, 2);
  const events = await srv.callTool("list_enforcement_events");
  assert.equal(events.isError, true);
});
