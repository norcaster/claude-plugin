import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeGateway } from "./fake-gateway.mjs";
import { startServer } from "./mcp-client.mjs";
import { shape } from "../plugin/server/console-tools.mjs";

const env = (gw) => ({
  HOME: fs.mkdtempSync(path.join(os.tmpdir(), "ncr-console-")),
  CLAUDE_PLUGIN_OPTION_API_KEY: "ncr_test",
  CLAUDE_PLUGIN_OPTION_DEPLOYMENT_ID: "dep-1",
  CLAUDE_PLUGIN_OPTION_API_URL: gw.url,
  CLAUDE_PLUGIN_OPTION_PORTAL_URL: "https://portal.example.test",
  NORCASTER_CREDENTIAL_STORE: "file",
  ANTHROPIC_BASE_URL: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
});

test("console tools: read-only, tenancy-scoped, compact", async (t) => {
  const gw = await startFakeGateway();
  const srv = startServer(env(gw));
  t.after(async () => {
    srv.close();
    await gw.close();
  });
  const list = await srv.request("tools/list");
  const console_ = list.result.tools.filter((x) => ["list_deployments", "get_deployment", "get_deployment_metrics", "get_deployment_costs", "get_deployment_errors", "get_compliance_report", "list_runs", "get_run", "get_run_trace", "simulate_policy"].includes(x.name));
  assert.equal(console_.length, 10);
  assert.ok(console_.filter((x) => x.name !== "simulate_policy").every((x) => x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false));
  assert.equal(console_.find((x) => x.name === "simulate_policy").annotations.destructiveHint, false);

  const deps = await srv.callTool("list_deployments", { limit: 5, q: "opus", fields: ["id", "status"] });
  assert.equal(deps.isError, false);
  assert.deepEqual(deps.data.deployments, [{ id: "dep-1", status: "active" }, { id: "dep-2", status: "stopped" }]);
  const listCall = gw.calls.find((c) => c.path === "/deployments");
  assert.deepEqual(listCall.query, { limit: "5", q: "opus" });
  assert.equal(listCall.headers["x-api-key"], "ncr_test");

  const dep = await srv.callTool("get_deployment");
  assert.equal(dep.data.id, "dep-1", "defaults to the configured deployment");
  const missing = await srv.callTool("get_deployment", { deployment_id: "dep-404" });
  assert.equal(missing.isError, true);
  assert.match(missing.data.error, /not found for your account/);

  const runs = await srv.callTool("list_runs", { limit: 5, status: "blocked", fields: ["id", "status"] });
  assert.deepEqual(runs.data.runs, [{ id: "run-1", status: "blocked" }, { id: "run-2", status: "ok" }]);
  assert.deepEqual(gw.calls.find((c) => c.path === "/observability/runs").query, { deployment_id: "dep-1", limit: "5", status: "blocked" });
  await srv.callTool("list_runs", { deployment_id: "*" });
  assert.equal("deployment_id" in gw.calls.filter((c) => c.path === "/observability/runs").at(-1).query, false);

  const run = await srv.callTool("get_run", { run_id: "run-1" });
  assert.equal(run.data.metrics.latency_ms, 12);
  const trace = await srv.callTool("get_run_trace", { run_id: "run-1" });
  assert.equal(trace.data.spans.length, 2);
  const noRun = await srv.callTool("get_run", { run_id: "run-404" });
  assert.equal(noRun.isError, true);

  for (const name of ["get_deployment_metrics", "get_deployment_costs", "get_deployment_errors"]) {
    const r = await srv.callTool(name);
    assert.equal(r.data.deployment_id, "dep-1");
  }
  const metrics = await srv.callTool("get_deployment_metrics", { start_time: "2026-09-01T00:00:00Z" });
  assert.equal(metrics.data.kind, "metrics");
  assert.deepEqual(gw.calls.filter((c) => c.path.endsWith("/metrics")).at(-1).query, { start_time: "2026-09-01T00:00:00Z" });

  const report = await srv.callTool("get_compliance_report");
  assert.deepEqual(report.data.guarantees, ["pii_redaction"]);

  const sim = await srv.callTool("simulate_policy", { input: "debug this: AKIAIOSFODNN7EXAMPLE" });
  assert.equal(sim.data.dry_run, true);
  assert.equal(sim.data.allowed, false);
  assert.deepEqual(gw.calls.find((c) => c.path.endsWith("/simulate-policy")).body, { input: { prompt: "debug this: AKIAIOSFODNN7EXAMPLE" } });
  const simObj = await srv.callTool("simulate_policy", { input: { messages: [{ role: "user", content: "hello" }] }, deployment_id: "dep-2" });
  assert.equal(simObj.data.allowed, true);
  assert.equal(gw.calls.filter((c) => c.path.endsWith("/simulate-policy")).at(-1).path, "/deployments/dep-2/simulate-policy");
  const noInput = await srv.callTool("simulate_policy", {});
  assert.equal(noInput.isError, true);
});

test("shape(): projection and automatic trimming", () => {
  assert.deepEqual(shape({ runs: [{ id: 1, big: { x: 1 }, status: "ok" }] }, ["id"]), { runs: [{ id: 1 }] });
  assert.deepEqual(shape([{ a: 1, b: 2 }], ["b"]), [{ b: 2 }]);
  const huge = { runs: Array.from({ length: 300 }, (_, i) => ({ id: i, status: "ok", payload: "x".repeat(200), nested: { deep: "y".repeat(50) } })) };
  const out = shape(huge);
  assert.match(out._note, /Nested fields were dropped/);
  assert.match(out._note, /Showing the first \d+ of 300 items/);
  assert.deepEqual(out.runs[0]._dropped, ["nested"]);
  assert.equal(out.runs[0].status, "ok");
  assert.ok(out.runs.length < 300 && out.runs.length >= 1);
  assert.ok(JSON.stringify(out).length <= 24000);
  const fits = { runs: Array.from({ length: 40 }, (_, i) => ({ id: i, nested: { deep: "y".repeat(1000) } })) };
  const trimmed = shape(fits);
  assert.equal(trimmed.runs.length, 40, "dropping nested fields was enough; no items cut");
  assert.ok(!/Showing the first/.test(trimmed._note));
});
