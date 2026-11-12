import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_ENV_KEYS,
  displayHome,
  installedStatuslinePath,
  stateConfigPath,
  stateDir,
  userSettingsPath,
} from "./paths.mjs";
import { readJsonFile, writeJsonFile } from "./json-file.mjs";
import {
  KEYCHAIN_SERVICE,
  defaultStore,
  describeStore,
  helperCommand,
  installedHelperPath,
  isOurHelper,
  keyFilePath,
  storeFor,
} from "./credentials.mjs";

/** Substring that identifies a status line as ours, wherever the home directory lives. */
export const STATUSLINE_MARKER = path.join("norcaster", "statusline.mjs");

/**
 * helper: the key lives in the OS keychain (macOS) or an owner-only file and
 *         Claude Code fetches it through apiKeyHelper — nothing secret in settings.json.
 * env:    the key is written into settings.json env, as the VS Code extension does.
 */
export const CREDENTIAL_MODES = ["helper", "env"];

/**
 * Every settings file Claude Code reads env from: the user-level file plus
 * `.claude/settings.json` and `.claude/settings.local.json` in each project
 * directory given. Project-level files are the ones that bite — a partial
 * revert that leaves ANTHROPIC_BASE_URL behind in a repo file points the
 * assistant at the gateway with no credentials, which fails harder than being governed.
 */
export function settingsTargets(projectDirs = []) {
  const targets = [{ file: userSettingsPath(), label: displayHome(userSettingsPath()) }];
  for (const dir of projectDirs) {
    if (!dir || typeof dir !== "string") continue;
    for (const name of ["settings.json", "settings.local.json"]) {
      targets.push({
        file: path.join(dir, ".claude", name),
        label: `${path.basename(path.resolve(dir))}/.claude/${name}`,
      });
    }
  }
  const seen = new Set();
  return targets.filter((t) => {
    const key = path.resolve(t.file);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scanSettings(projectDirs = []) {
  const hits = [];
  const malformed = [];
  for (const target of settingsTargets(projectDirs)) {
    const r = readJsonFile(target.file);
    if (!r.exists) continue;
    if (!r.ok) {
      malformed.push(target);
      continue;
    }
    const env = r.value?.env;
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    const present = CLAUDE_ENV_KEYS.filter((k) => k in env);
    if (present.length > 0) hits.push({ target, parsed: r.value, present });
  }
  return { hits, malformed };
}

export function statuslineSetting() {
  return { type: "command", command: `node "${installedStatuslinePath()}"`, refreshInterval: 30 };
}

export function isOurStatusline(value) {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.command === "string" &&
    value.command.includes(STATUSLINE_MARKER)
  );
}

const ENV_MODE_NOTE =
  "The key is stored in plaintext in ~/.claude/settings.json — that is how Claude Code consumes env. " +
  "Keep the file out of dotfile repos. Files are written with owner-only permissions.";

function helperModeNote(storeName) {
  return (
    `The key is stored in ${describeStore(storeName)}, not in settings.json. Claude Code runs the helper (cached five minutes) ` +
    "and sends the key in both the Authorization and x-api-key headers, which is what the gateway needs. Files are written with owner-only permissions."
  );
}

/** Shown when configure still writes the deployment header: the setup the Companion recommends. */
export const BOUND_KEY_RECOMMENDATION =
  "Recommended: use a personal key bound to this one deployment. Create it at https://www.norcaster.com/dashboard/connect-tool?tool=claude_code " +
  "(scopes runs:write and deployments:read), put it in the plugin's api_key and clear deployment_id. The gateway then resolves the deployment from the key, " +
  "and configure writes no X-Norcaster-Deployment-Id header.";

const deploymentLine = (deploymentHeader, deploymentId) => (deploymentHeader ? [`X-Norcaster-Deployment-Id: ${deploymentId}`] : []);

/**
 * `deploymentHeader: false` leaves X-Norcaster-Deployment-Id out: the key is bound to exactly
 * `deploymentId`, so the gateway resolves it. `deploymentProblem` says why there is no deployment
 * (from the key-binding lookup) and replaces the generic message.
 */
export function planConfigure({
  apiUrl,
  deploymentId,
  deploymentHeader = true,
  deploymentProblem,
  apiKey,
  credentialMode = "helper",
  storeName = defaultStore(),
}) {
  const file = userSettingsPath();
  const r = readJsonFile(file);
  const problems = [];
  const warnings = [];
  if (!apiKey) {
    problems.push(
      "No API key is configured for the plugin. Set it in the plugin's user configuration (/plugin → norcaster) — it is stored in your OS keychain and never shown in chat.",
    );
  }
  if (!deploymentId) {
    problems.push(
      deploymentProblem ??
        "No deployment ID is configured. The gateway needs the X-Norcaster-Deployment-Id header unless the API key is bound to exactly one deployment; set it in the plugin's user configuration.",
    );
  }
  if (r.exists && !r.ok) {
    problems.push(`${displayHome(file)} is not valid JSON (${r.error}). Fix it by hand before configuring.`);
  }
  if (!CREDENTIAL_MODES.includes(credentialMode)) {
    problems.push(`Unknown credential_mode "${credentialMode}"; use "helper" (default) or "env".`);
  }
  const existing = r.ok && r.value ? r.value : {};
  const env = existing.env && typeof existing.env === "object" ? existing.env : {};
  const label = displayHome(file);
  const writes = [{ file: label, key: "env.ANTHROPIC_BASE_URL", value: apiUrl }];

  const headerLines = deploymentLine(deploymentHeader, deploymentId);
  if (!deploymentHeader && deploymentId) {
    warnings.push(
      `No deployment header: the API key is bound to deployment ${deploymentId}, so the gateway uses that one. ` +
        "If the key's binding later covers more than one deployment, run /norcaster:configure again.",
    );
  }
  if (credentialMode === "env") {
    writes.push({ file: label, key: "env.ANTHROPIC_AUTH_TOKEN", value: "<your API key>" });
    writes.push({
      file: label,
      key: "env.ANTHROPIC_CUSTOM_HEADERS",
      value: [...headerLines, "X-API-Key: <your API key>"].join("\n"),
    });
    if (isOurHelper(existing.apiKeyHelper)) {
      writes.push({ file: label, key: "apiKeyHelper", value: "(removed — the key moves back into settings.json)", replaces: existing.apiKeyHelper });
    }
  } else {
    if (deploymentHeader) {
      writes.push({ file: label, key: "env.ANTHROPIC_CUSTOM_HEADERS", value: headerLines[0] });
    } else if ("ANTHROPIC_CUSTOM_HEADERS" in env) {
      writes.push({ file: label, key: "env.ANTHROPIC_CUSTOM_HEADERS", value: "(removed — the key's binding names the deployment)" });
    }
    writes.push({
      file: label,
      key: "apiKeyHelper",
      value: helperCommand(),
      replaces: isOurHelper(existing.apiKeyHelper) ? "(already Norcaster's)" : (existing.apiKeyHelper ?? "(none)"),
    });
    if ("ANTHROPIC_AUTH_TOKEN" in env) {
      writes.push({ file: label, key: "env.ANTHROPIC_AUTH_TOKEN", value: "(removed — a plaintext token from an earlier configure; the helper replaces it)" });
    }
    writes.push({
      file: displayHome(installedHelperPath()),
      key: "file",
      value: `self-contained helper that prints the key from ${describeStore(storeName)}`,
    });
    writes.push(
      storeName === "keychain"
        ? { file: "macOS Keychain", key: `item "${KEYCHAIN_SERVICE}" for account ${apiUrl}`, value: "<your API key>" }
        : { file: displayHome(keyFilePath()), key: "file (owner-only)", value: "<your API key>" },
    );
  }
  if ("ANTHROPIC_API_KEY" in env) {
    warnings.push(
      "env.ANTHROPIC_API_KEY is set in this file. It takes precedence over the gateway credential and would reach the gateway in the x-api-key header; remove it or requests fail with 401.",
    );
  }
  writes.push({
    file: label,
    key: "statusLine",
    value: statuslineSetting().command,
    replaces: isOurStatusline(existing.statusLine) ? "(already Norcaster's)" : (existing.statusLine ?? "(none)"),
  });
  writes.push({ file: displayHome(installedStatuslinePath()), key: "file", value: "self-contained status-line script copied from the plugin" });
  writes.push({
    file: displayHome(stateConfigPath()),
    key: "file",
    value: "deployment, URLs, credential store, and your previous status line / apiKeyHelper, so /norcaster:remove can restore them",
  });
  return {
    ok: problems.length === 0,
    problems,
    warnings,
    credential_mode: credentialMode,
    credential_store: credentialMode === "helper" ? storeName : null,
    writes,
    preserves: "Everything else in each file is preserved (merge, not overwrite).",
    note: credentialMode === "env" ? ENV_MODE_NOTE : helperModeNote(storeName),
    ...(deploymentHeader && deploymentId ? { recommendation: BOUND_KEY_RECOMMENDATION } : {}),
  };
}

export function applyConfigure({
  apiUrl,
  portalUrl,
  deploymentId,
  deploymentHeader = true,
  deploymentProblem,
  apiKey,
  credentialMode = "helper",
  storeName = defaultStore(),
  store = storeFor(storeName),
  statuslineSource,
  helperSource,
  pluginVersion,
}) {
  const plan = planConfigure({ apiUrl, deploymentId, deploymentHeader, deploymentProblem, apiKey, credentialMode, storeName });
  if (!plan.ok) return { ok: false, problems: plan.problems };

  const file = userSettingsPath();
  const existing = readJsonFile(file).value ?? {};
  const previousState = readJsonFile(stateConfigPath()).value;
  const env = { ...(existing.env ?? {}), ANTHROPIC_BASE_URL: apiUrl };

  // Remember what we replace — but never remember our own, so re-running
  // configure keeps the user's originals for /norcaster:remove.
  const previousStatusLine = isOurStatusline(existing.statusLine)
    ? (previousState?.previous_status_line ?? null)
    : (existing.statusLine ?? null);
  const previousHelper = isOurHelper(existing.apiKeyHelper)
    ? (previousState?.previous_api_key_helper ?? null)
    : (existing.apiKeyHelper ?? null);

  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  let credential;
  if (credentialMode === "env") {
    env.ANTHROPIC_AUTH_TOKEN = apiKey;
    // Gateway requires X-API-Key for user auth (AUTH_TOKEN only sends Authorization)
    // plus the deployment header unless the key is bound to one deployment. Newline separates headers.
    env.ANTHROPIC_CUSTOM_HEADERS = [...deploymentLine(deploymentHeader, deploymentId), `X-API-Key: ${apiKey}`].join("\n");
    if (isOurHelper(existing.apiKeyHelper)) {
      if (previousHelper) existing.apiKeyHelper = previousHelper;
      else delete existing.apiKeyHelper;
    }
    if (previousState?.credential?.mode === "helper") {
      storeFor(previousState.credential.store).remove(previousState.credential.account);
    }
    fs.rmSync(installedHelperPath(), { force: true });
    credential = { mode: "env" };
  } else {
    try {
      store.store(apiUrl, apiKey);
    } catch (err) {
      return { ok: false, problems: [`Could not store the key in ${describeStore(store.name)}: ${err?.message ?? err}. Nothing was written.`] };
    }
    delete env.ANTHROPIC_AUTH_TOKEN;
    const line = deploymentLine(deploymentHeader, deploymentId);
    if (line.length > 0) env.ANTHROPIC_CUSTOM_HEADERS = line[0];
    else delete env.ANTHROPIC_CUSTOM_HEADERS;
    fs.copyFileSync(helperSource, installedHelperPath());
    fs.chmodSync(installedHelperPath(), 0o700);
    existing.apiKeyHelper = helperCommand();
    credential = { mode: "helper", store: store.name, account: apiUrl, service: KEYCHAIN_SERVICE };
  }

  fs.copyFileSync(statuslineSource, installedStatuslinePath());
  fs.chmodSync(installedStatuslinePath(), 0o600);
  writeJsonFile(stateConfigPath(), {
    api_url: apiUrl,
    portal_url: portalUrl,
    deployment_id: deploymentId,
    credential,
    previous_status_line: previousStatusLine,
    previous_api_key_helper: previousHelper,
    installed_at: new Date().toISOString(),
    plugin_version: pluginVersion,
  });
  existing.env = env;
  existing.statusLine = statuslineSetting();
  writeJsonFile(file, existing);

  return {
    ok: true,
    file: displayHome(file),
    credential_mode: credentialMode,
    credential_store: credential.store ?? null,
    warnings: plan.warnings,
    next:
      "Fully restart Claude Code — the settings env is read at startup. Then run /status: the Anthropic base URL line should show the gateway" +
      (credentialMode === "helper" ? " and the credential line should name apiKeyHelper." : ".") +
      " If /status shows a claude.ai subscription session instead, run /logout so the gateway credential takes over. " +
      "From then on every request, including streamed responses and tool use, flows through the gateway's /v1/messages route.",
  };
}

export function planRemove(projectDirs = []) {
  const { hits, malformed } = scanSettings(projectDirs);
  const settings = readJsonFile(userSettingsPath());
  const statuslineOurs = settings.ok && isOurStatusline(settings.value?.statusLine);
  const helperOurs = settings.ok && isOurHelper(settings.value?.apiKeyHelper);
  const state = readJsonFile(stateConfigPath()).value;
  const stateExists = fs.existsSync(stateDir());
  return {
    scanned: settingsTargets(projectDirs).map((t) => t.label),
    hits: hits.map((h) => ({ file: h.target.label, keys: h.present })),
    malformed: malformed.map((m) => m.label),
    statusline: statuslineOurs ? { restore_to: state?.previous_status_line ?? "(none — status line removed)" } : null,
    api_key_helper: helperOurs ? { restore_to: state?.previous_api_key_helper ?? "(none — helper removed)" } : null,
    credential_store:
      state?.credential?.mode === "helper" ? `${describeStore(state.credential.store)} (the stored key is deleted)` : null,
    state_dir: stateExists ? displayHome(stateDir()) : null,
    nothing_to_do: hits.length === 0 && !statuslineOurs && !helperOurs && !stateExists,
    preserves: "Everything else in each file is preserved.",
    effect: "Claude Code will talk to the provider directly after this: its traffic will no longer be governed.",
  };
}

/** Put back whatever we replaced in the user-level file. Returns what was restored. */
function restoreUserFile(parsed, state) {
  const out = { statusline: false, helper: false };
  if (isOurStatusline(parsed.statusLine)) {
    if (state?.previous_status_line) parsed.statusLine = state.previous_status_line;
    else delete parsed.statusLine;
    out.statusline = true;
  }
  if (isOurHelper(parsed.apiKeyHelper)) {
    if (state?.previous_api_key_helper) parsed.apiKeyHelper = state.previous_api_key_helper;
    else delete parsed.apiKeyHelper;
    out.helper = true;
  }
  return out;
}

export function applyRemove(projectDirs = []) {
  const { hits, malformed } = scanSettings(projectDirs);
  const state = readJsonFile(stateConfigPath()).value;
  const userFile = userSettingsPath();
  const removed = [];
  const failed = [];
  let restored = { statusline: false, helper: false };

  for (const hit of hits) {
    try {
      const nextEnv = { ...hit.parsed.env };
      for (const k of CLAUDE_ENV_KEYS) delete nextEnv[k];
      if (Object.keys(nextEnv).length === 0) delete hit.parsed.env;
      else hit.parsed.env = nextEnv;
      if (path.resolve(hit.target.file) === path.resolve(userFile)) restored = restoreUserFile(hit.parsed, state);
      writeJsonFile(hit.target.file, hit.parsed);
      removed.push(hit.target.label);
    } catch (err) {
      failed.push(`${hit.target.label} (${err?.message ?? err})`);
    }
  }

  // The user file may carry our status line or helper without any env hit (e.g. env was hand-removed).
  if (!hits.some((h) => path.resolve(h.target.file) === path.resolve(userFile))) {
    const r = readJsonFile(userFile);
    if (r.ok && r.value) {
      const r2 = restoreUserFile(r.value, state);
      if (r2.statusline || r2.helper) {
        try {
          writeJsonFile(userFile, r.value);
          restored = r2;
        } catch (err) {
          failed.push(`${displayHome(userFile)} (${err?.message ?? err})`);
        }
      }
    }
  }

  let credentialRemoved = false;
  if (failed.length === 0) {
    if (state?.credential?.mode === "helper") {
      credentialRemoved = storeFor(state.credential.store).remove(state.credential.account);
    }
    fs.rmSync(stateDir(), { recursive: true, force: true });
  }

  const malformedNote =
    malformed.length > 0
      ? ` Skipped (not valid JSON, fix by hand): ${malformed.map((m) => m.label).join(", ")}.`
      : "";
  let message;
  if (failed.length > 0) {
    // A partial removal is the worst outcome: a leftover ANTHROPIC_BASE_URL with no
    // credentials makes every request fail with 401.
    message =
      `Removed from ${removed.join(", ") || "no files"}, but FAILED on ${failed.join(", ")}. ` +
      "Claude Code is now in a broken half-state — a leftover ANTHROPIC_BASE_URL without credentials makes every request fail with 401. " +
      `Remove the keys from the failed file(s) by hand before restarting.${malformedNote}`;
  } else if (removed.length === 0 && !restored.statusline && !restored.helper) {
    message = `No gateway env keys found in any Claude Code settings file that was scanned.${malformedNote}`;
  } else {
    message =
      `Claude Code configuration removed from ${removed.join(", ") || "the status line and helper only"} — this machine's assistant traffic is no longer governed. ` +
      "Fully restart Claude Code, then run /login. Start a new conversation rather than resuming one that was blocked: anything already in that history will now reach the provider. " +
      `Only the working directory and any project_dirs given were scanned — other repos with their own .claude/settings.json are untouched.${malformedNote}`;
  }
  return {
    ok: failed.length === 0,
    removed,
    failed,
    malformed: malformed.map((m) => m.label),
    statusline_restored: restored.statusline,
    api_key_helper_restored: restored.helper,
    credential_removed: credentialRemoved,
    message,
  };
}
