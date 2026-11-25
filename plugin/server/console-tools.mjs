/**
 * Read-only operator console.
 *
 * Design rules, kept here on purpose:
 *  - never weaken governance: no tool can change a policy; simulate_policy is a dry run
 *  - tenancy is server-side: org/user scoping comes from the key, never from arguments
 *  - domain-meaningful, compact output: `fields` projection and small default pages,
 *    nested blobs dropped automatically when a payload would flood the context
 */
import { apiGet, apiPost } from "../lib/api.mjs";

const MAX_CHARS = 24000;
const LIST_KEYS = ["deployments", "runs", "items", "events", "spans", "errors", "revisions"];

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function pick(obj, fields) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

/** Keep scalars, drop nested objects/arrays — the automatic fallback when a payload is too large. */
function scalarsOnly(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return obj;
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") dropped.push(k);
    else out[k] = v;
  }
  if (dropped.length) out._dropped = dropped;
  return out;
}

function listKey(payload) {
  if (Array.isArray(payload)) return null;
  return LIST_KEYS.find((k) => Array.isArray(payload?.[k])) ?? null;
}

/** Apply a `fields` projection, then shrink automatically if the result would still flood the context. */
export function shape(payload, fields) {
  let out = payload;
  const key = listKey(out);
  const wanted = Array.isArray(fields) && fields.length ? fields.map(String) : null;
  if (wanted) {
    if (Array.isArray(out)) out = out.map((x) => pick(x, wanted));
    else if (key) out = { ...out, [key]: out[key].map((x) => pick(x, wanted)) };
    else out = pick(out, wanted);
  }
  let text = JSON.stringify(out);
  if (text.length <= MAX_CHARS) return out;

  // 1. drop nested blobs from list items
  const notes = ["Nested fields were dropped to fit the context; ask for specific `fields` or a smaller `limit`."];
  if (Array.isArray(out)) out = { items: out.map(scalarsOnly) };
  else if (key) out = { ...out, [key]: out[key].map(scalarsOnly) };
  else out = scalarsOnly(out);
  const k = Array.isArray(payload) ? "items" : key;
  text = JSON.stringify(out);

  // 2. still too big: keep the first N items that fit
  if (text.length > MAX_CHARS && k) {
    const all = out[k];
    let n = all.length;
    while (n > 1 && JSON.stringify({ ...out, [k]: all.slice(0, n) }).length > MAX_CHARS) n = Math.floor(n / 2);
    out = { ...out, [k]: all.slice(0, n) };
    notes.push(`Showing the first ${n} of ${all.length} items; page with \`offset\` or narrow the query.`);
    text = JSON.stringify(out);
  }
  if (text.length > MAX_CHARS) {
    return { _note: `Payload is ${text.length} characters even after trimming; ask for specific \`fields\`.`, preview: text.slice(0, 4000) };
  }
  return { ...out, _note: notes.join(" ") };
}

const FIELDS_SCHEMA = {
  type: "array",
  items: { type: "string" },
  description: "Optional projection: only these top-level fields of each item are returned. Keeps responses small.",
};

export function consoleTools({ cfg, text, fail, missingCredentials, explain }) {
  const ready = () => {
    const missing = missingCredentials();
    return missing.length ? fail(`Plugin configuration incomplete: ${missing.join(", ")}. Set it under /plugin → norcaster.`) : null;
  };
  const deploymentOr = (id) => (typeof id === "string" && id.trim() ? id.trim() : cfg.deploymentId);
  const notOk = (res, what) => {
    if (res.status === 404) return fail(`${what} not found for your account (${explain(res)}). Tenancy is server-side: only what your key can see is visible.`);
    if (res.status === 403) return fail(`${what}: your key lacks the scope for this (${explain(res)}).`);
    return fail(`${what} failed (${explain(res)}).`);
  };
  const get = async (urlPath, what, fields) => {
    const blocked = ready();
    if (blocked) return blocked;
    const res = await apiGet(cfg.apiUrl, urlPath, cfg.apiKey);
    if (!res.ok) return notOk(res, what);
    return text(shape(res.body, fields));
  };
  const ro = (title) => ({ title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  const clampLimit = (limit, dflt, max) => Math.min(max, Math.max(1, Number(limit) | 0 || dflt));

  return [
    {
      name: "list_deployments",
      description: "List the deployments your key can see, with revision counts. Paginated (limit ≤ 50) and searchable. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Page size (default 10)." },
          offset: { type: "integer", minimum: 0 },
          q: { type: "string", description: "Case-insensitive search across deployment id and model id." },
          fields: FIELDS_SCHEMA,
        },
        additionalProperties: false,
      },
      annotations: ro("List deployments"),
      run: ({ limit, offset, q, fields } = {}) =>
        get(`/deployments${qs({ limit: clampLimit(limit, 10, 50), offset, q })}`, "Deployments", fields),
    },
    {
      name: "get_deployment",
      description: "Details of one deployment: config, plan, entitlements, usage. Defaults to the configured deployment. Read-only.",
      inputSchema: { type: "object", properties: { deployment_id: { type: "string" }, fields: FIELDS_SCHEMA }, additionalProperties: false },
      annotations: ro("Get deployment"),
      run: ({ deployment_id, fields } = {}) => get(`/deployments/${encodeURIComponent(deploymentOr(deployment_id))}`, "Deployment", fields),
    },
    {
      name: "get_deployment_metrics",
      description: "Latency, token and request metrics for a deployment over an optional ISO-8601 time window. Defaults to the configured deployment. Read-only.",
      inputSchema: {
        type: "object",
        properties: { deployment_id: { type: "string" }, start_time: { type: "string" }, end_time: { type: "string" } },
        additionalProperties: false,
      },
      annotations: ro("Deployment metrics"),
      run: ({ deployment_id, start_time, end_time } = {}) =>
        get(`/observability/deployments/${encodeURIComponent(deploymentOr(deployment_id))}/metrics${qs({ start_time, end_time })}`, "Deployment metrics"),
    },
    {
      name: "get_deployment_costs",
      description: "Cost summary for a deployment (totals, currency, per-run estimates). Defaults to the configured deployment. Read-only.",
      inputSchema: { type: "object", properties: { deployment_id: { type: "string" } }, additionalProperties: false },
      annotations: ro("Deployment costs"),
      run: ({ deployment_id } = {}) => get(`/observability/deployments/${encodeURIComponent(deploymentOr(deployment_id))}/costs`, "Deployment costs"),
    },
    {
      name: "get_deployment_errors",
      description: "Errors grouped by category for a deployment. Defaults to the configured deployment. Read-only.",
      inputSchema: { type: "object", properties: { deployment_id: { type: "string" } }, additionalProperties: false },
      annotations: ro("Deployment errors"),
      run: ({ deployment_id } = {}) => get(`/observability/deployments/${encodeURIComponent(deploymentOr(deployment_id))}/errors`, "Deployment errors"),
    },
    {
      name: "get_compliance_report",
      description: "Compliance report for a deployment: enabled guarantees, change history, violation statistics. Evidence, not a verdict. Defaults to the configured deployment. Read-only.",
      inputSchema: { type: "object", properties: { deployment_id: { type: "string" }, fields: FIELDS_SCHEMA }, additionalProperties: false },
      annotations: ro("Compliance report"),
      run: ({ deployment_id, fields } = {}) =>
        get(`/deployments/${encodeURIComponent(deploymentOr(deployment_id))}/compliance-report`, "Compliance report", fields),
    },
    {
      name: "list_runs",
      description: "Recent runs (requests) your key can see, newest first, filterable by deployment, status, error category and time window. Paginated (limit ≤ 50). Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          deployment_id: { type: "string", description: "Defaults to the configured deployment; pass \"*\" for all deployments." },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Page size (default 20)." },
          offset: { type: "integer", minimum: 0 },
          status: { type: "string" },
          error_category: { type: "string" },
          start_time: { type: "string" },
          end_time: { type: "string" },
          fields: FIELDS_SCHEMA,
        },
        additionalProperties: false,
      },
      annotations: ro("List runs"),
      run: ({ deployment_id, limit, offset, status, error_category, start_time, end_time, fields } = {}) =>
        get(
          `/observability/runs${qs({
            deployment_id: deployment_id === "*" ? undefined : deploymentOr(deployment_id),
            limit: clampLimit(limit, 20, 50),
            offset,
            status,
            error_category,
            start_time,
            end_time,
          })}`,
          "Runs",
          fields,
        ),
    },
    {
      name: "get_run",
      description: "One run with its metrics and costs. Read-only.",
      inputSchema: { type: "object", properties: { run_id: { type: "string" }, fields: FIELDS_SCHEMA }, required: ["run_id"], additionalProperties: false },
      annotations: ro("Get run"),
      run: ({ run_id, fields } = {}) =>
        typeof run_id === "string" && run_id.trim() ? get(`/observability/runs/${encodeURIComponent(run_id.trim())}`, "Run", fields) : fail("run_id is required."),
    },
    {
      name: "get_run_trace",
      description: "The span tree of one run (parent/child relationships preserved). Can be large: prefer get_run first. Read-only.",
      inputSchema: { type: "object", properties: { run_id: { type: "string" } }, required: ["run_id"], additionalProperties: false },
      annotations: ro("Get run trace"),
      run: ({ run_id } = {}) =>
        typeof run_id === "string" && run_id.trim() ? get(`/observability/runs/${encodeURIComponent(run_id.trim())}/trace`, "Run trace") : fail("run_id is required."),
    },
    {
      name: "simulate_policy",
      description:
        "Dry-run the deployment's full runtime policy against an input — budget checks, pipeline lock, contextual detectors, input guardrails — with NO model call. " +
        "Answers \"would this prompt pass the current policy?\" before anything is sent. Defaults to the configured deployment.",
      inputSchema: {
        type: "object",
        properties: {
          input: { description: "The request to test: a prompt string, or the full request payload object (e.g. {\"prompt\": \"...\"} or {\"messages\": [...]})." },
          deployment_id: { type: "string" },
        },
        required: ["input"],
        additionalProperties: false,
      },
      annotations: { title: "Simulate policy (dry run)", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      async run({ input, deployment_id } = {}) {
        const blocked = ready();
        if (blocked) return blocked;
        if (input === undefined || input === null || input === "") return fail("input is required.");
        const payload = { input: typeof input === "string" ? { prompt: input } : input };
        const res = await apiPost(cfg.apiUrl, `/deployments/${encodeURIComponent(deploymentOr(deployment_id))}/simulate-policy`, cfg.apiKey, payload);
        if (!res.ok) return notOk(res, "Policy simulation");
        return text({ dry_run: true, no_model_call: true, ...shape(res.body) });
      },
    },
  ];
}
