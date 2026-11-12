import http from "node:http";

/** Minimal stand-in for the gateway and console routes the plugin calls. Both auth headers are required, as in production. */
/**
 * `keyBinding` is the key's `allowed_deployment_ids` that `/auth/me` reports (null = not bound).
 * Leave it undefined for an older gateway, which has no `api_key` block there.
 */
export function startFakeGateway({ validKey = "ncr_test", events = [], deployments, runs, keyBinding, promptCheck } = {}) {
  const calls = [];
  const deps = deployments ?? [
    { id: "dep-1", model_id: "claude-opus-5", status: "active", revision_count: 3, config: { pipeline_lock: { version: "2" } } },
    { id: "dep-2", model_id: "gpt-5", status: "stopped", revision_count: 1, config: {} },
  ];
  const runRows = runs ?? [
    { id: "run-1", deployment_id: "dep-1", status: "blocked", created_at: "2026-09-14T10:00:00Z", metrics: { latency_ms: 12 } },
    { id: "run-2", deployment_id: "dep-1", status: "ok", created_at: "2026-09-14T09:00:00Z", metrics: { latency_ms: 340 } },
  ];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
      const json = (status, obj) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const authed = req.headers["x-api-key"] === validKey && req.headers.authorization === `Bearer ${validKey}`;
      if (!authed) return json(401, { detail: "invalid key" });
      const p = url.pathname;
      let m;
      if (p === "/v1/policy/check" && req.method === "POST") {
        if (promptCheck) {
          const reply = promptCheck(body, req);
          return json(reply.status, reply.body);
        }
        const allowed = !String(body?.prompt).includes("AWS_SECRET_ACCESS_KEY=");
        return json(200, {
          scope: "prompt", allowed, deployment_id: "dep-1", request_id: "req-check",
          ...(!allowed ? { event_id: "evt-check", block_reason: "A credential was detected.", prompt_suggestion: "Replace it with a placeholder." } : {}),
        });
      }
      if (p === "/v1/models") return json(200, { data: [{ id: "claude-opus-5" }] });
      if (p === "/auth/me") {
        const me = { id: "user-1", email: "dev@example.test" };
        return json(200, keyBinding === undefined ? me : { ...me, api_key: { id: "key-1", scopes: ["runs:write"], allowed_deployment_ids: keyBinding, service_account_id: null } });
      }
      if (p === "/enforcement-events") return json(200, { events, next_cursor: null });
      if (p === "/enforcement-events/trace") return json(200, { event_id: "evt-from-trace" });
      if ((m = p.match(/^\/enforcement-events\/([^/]+)\/forward-once$/)) && req.method === "POST") {
        return m[1] === "evt-nope"
          ? json(409, { detail: "not eligible: terminal category" })
          : json(200, { approved: true, event_id: m[1], expires_at: "2026-09-14T00:10:00Z" });
      }
      if ((m = p.match(/^\/enforcement-events\/([^/]+)\/claims$/)) && req.method === "POST") return json(200, { claim_id: "clm-1", already_open: false });
      // --- console routes ---
      if (p === "/deployments") return json(200, { deployments: deps, total: deps.length });
      if ((m = p.match(/^\/deployments\/([^/]+)$/))) {
        const d = deps.find((x) => x.id === m[1]);
        return d ? json(200, d) : json(404, { detail: "Deployment not found" });
      }
      if ((m = p.match(/^\/deployments\/([^/]+)\/compliance-report$/))) return json(200, { deployment_id: m[1], guarantees: ["pii_redaction"], violations: { blocked: 2 } });
      if ((m = p.match(/^\/deployments\/([^/]+)\/simulate-policy$/)) && req.method === "POST") {
        const text = JSON.stringify(body?.input ?? {});
        return json(200, { allowed: !text.includes("AKIA"), severity: text.includes("AKIA") ? "block" : "allow", input_received: body?.input });
      }
      if (p === "/observability/runs") return json(200, { runs: runRows.filter((r) => !url.searchParams.get("deployment_id") || r.deployment_id === url.searchParams.get("deployment_id")) });
      if ((m = p.match(/^\/observability\/runs\/([^/]+)$/))) {
        const r = runRows.find((x) => x.id === m[1]);
        return r ? json(200, r) : json(404, { detail: "Run not found" });
      }
      if ((m = p.match(/^\/observability\/runs\/([^/]+)\/trace$/))) return json(200, { run_id: m[1], spans: [{ id: "s1", parent_id: null }, { id: "s2", parent_id: "s1" }] });
      if ((m = p.match(/^\/observability\/deployments\/([^/]+)\/(metrics|costs|errors)$/))) return json(200, { deployment_id: m[1], kind: m[2], total: 1 });
      return json(404, { detail: "not found" });
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}

export function blockedEvent(overrides = {}) {
  return {
    event_id: "evt-1",
    request_id: "req-1",
    deployment_id: "dep-1",
    action_taken: "blocked",
    severity: "error",
    policy_version: "pv-1",
    violations: [{ rule: "aws_access_key" }],
    contextual: { developer_notice: "AWS key detected", detection_origin: "current_turn", policy_pack: "developer-tools" },
    forwarding: { can_approve: true, state: "eligible", expires_at: "2026-09-14T00:10:00Z" },
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
