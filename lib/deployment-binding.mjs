/**
 * Whether the Claude Code config needs the X-Norcaster-Deployment-Id header.
 *
 * The gateway resolves the deployment from the API key when the key is bound to exactly one
 * deployment, so the header can be left out. `GET /auth/me` called with the key returns that
 * binding in `api_key.allowed_deployment_ids` (null = not bound). An older gateway has no
 * `api_key` block, and a failed lookup gives nothing: both keep today's behaviour, header on.
 */

export const DEPLOYMENT_HEADER = "X-Norcaster-Deployment-Id";

/** The one deployment the key is bound to, from a `/auth/me` body; null when not exactly one. */
export function boundDeploymentId(me) {
  const ids = me?.api_key?.allowed_deployment_ids;
  if (!Array.isArray(ids) || ids.length !== 1) return null;
  const id = ids[0];
  return typeof id === "string" && id.trim() ? id.trim() : null;
}

/**
 * `setting` is the configured deployment id ("" when empty). `me` is the `/auth/me` body, or
 * null when the lookup failed. Returns { ok, deploymentId, sendHeader, source } or { ok: false, problem }.
 */
export function resolveDeploymentRouting(setting, me) {
  const configured = String(setting ?? "").trim();
  const bound = boundDeploymentId(me);
  if (bound) {
    if (configured && configured !== bound) {
      return {
        ok: false,
        problem:
          `The API key is bound to deployment ${bound}, but the plugin's deployment ID is ${configured}. ` +
          "The gateway refuses a deployment the key isn't bound to: clear the deployment ID under /plugin → norcaster to use the key's deployment, or use a key for this one.",
      };
    }
    return { ok: true, deploymentId: bound, sendHeader: false, source: "binding" };
  }
  if (configured) return { ok: true, deploymentId: configured, sendHeader: true, source: "setting" };
  return {
    ok: false,
    problem:
      me === null
        ? `No deployment ID is configured, and the key's deployment binding couldn't be read from the gateway, so the ${DEPLOYMENT_HEADER} header is needed. Set the deployment ID in the plugin's user configuration.`
        : `No deployment ID is configured. The gateway needs the ${DEPLOYMENT_HEADER} header unless the API key is bound to exactly one deployment; set the deployment ID in the plugin's user configuration, or use a key bound to one deployment.`,
  };
}
