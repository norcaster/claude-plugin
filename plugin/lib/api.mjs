/**
 * Gateway wire contract (see portal gateway-setup): BOTH headers are required.
 * X-API-Key resolves the user; Authorization must be present.
 */
export function gatewayHeaders(apiKey, extra = {}) {
  return { Authorization: `Bearer ${apiKey}`, "X-API-Key": apiKey, ...extra };
}

export async function apiRequest(method, apiUrl, urlPath, apiKey, payload, { timeoutMs = 8000, headers = {}, redirect = "follow" } = {}) {
  try {
    const res = await fetch(`${apiUrl}${urlPath}`, {
      method,
      headers: gatewayHeaders(apiKey, { ...headers, ...(payload !== undefined ? { "Content-Type": "application/json" } : {}) }),
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
      redirect,
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body is fine for status checks */
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: String(err?.message ?? err) };
  }
}

export const apiGet = (apiUrl, urlPath, apiKey, opts) => apiRequest("GET", apiUrl, urlPath, apiKey, undefined, opts);
export const apiPost = (apiUrl, urlPath, apiKey, payload = {}, opts) =>
  apiRequest("POST", apiUrl, urlPath, apiKey, payload, opts);

/** governed | invalid-key | unreachable — the same three outcomes the VS Code status bar distinguishes. */
export async function keyState(apiKey, apiUrl, opts) {
  const res = await apiGet(apiUrl, "/v1/models", apiKey, opts);
  if (res.ok) return "governed";
  if (res.status === 401 || res.status === 403) return "invalid-key";
  return "unreachable";
}

/** `GET /auth/me` with the key: its `api_key` block carries the key's deployment binding. Null when the lookup fails. */
export async function keyContext(apiKey, apiUrl, opts) {
  const res = await apiGet(apiUrl, "/auth/me", apiKey, opts);
  return res.ok && res.body && typeof res.body === "object" ? res.body : null;
}
