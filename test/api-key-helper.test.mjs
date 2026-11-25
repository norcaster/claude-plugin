import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";

const HELPER_SRC = fileURLToPath(new URL("../plugin/scripts/api-key-helper.mjs", import.meta.url));
const STATUSLINE_SRC = fileURLToPath(new URL("../plugin/scripts/statusline.mjs", import.meta.url));
const { applyConfigure, applyRemove } = await import("../plugin/lib/claude-settings.mjs");

test("file store: the installed helper prints the key and nothing else; remove deletes it", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ncr-helper-"));
  process.env.HOME = home;
  const result = applyConfigure({
    apiUrl: "https://api.example.test",
    portalUrl: "https://portal.example.test",
    deploymentId: "dep-1",
    apiKey: "ncr_from_file",
    credentialMode: "helper",
    storeName: "file",
    statuslineSource: STATUSLINE_SRC,
    helperSource: HELPER_SRC,
    pluginVersion: "test",
  });
  assert.equal(result.ok, true);
  assert.equal(result.credential_store, "file");
  const keyFile = path.join(home, ".claude", "norcaster", "api-key");
  assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
  const helper = path.join(home, ".claude", "norcaster", "api-key-helper.mjs");
  assert.equal(fs.statSync(helper).mode & 0o777, 0o700);
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.apiKeyHelper, `node "${helper}"`);

  // Run exactly what Claude Code runs.
  const r = spawnSync(settings.apiKeyHelper, { shell: true, encoding: "utf8", env: childEnv({ HOME: home }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "ncr_from_file\n");
  assert.equal(r.stderr, "");

  const rm = applyRemove([]);
  assert.equal(rm.ok, true);
  assert.equal(rm.api_key_helper_restored, true);
  assert.equal(rm.credential_removed, true);
  assert.equal(fs.existsSync(keyFile), false);
  const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
  assert.equal("apiKeyHelper" in after, false);
  const gone = spawnSync(process.execPath, [helper], { encoding: "utf8", env: childEnv({ HOME: home }) });
  assert.notEqual(gone.status, 0, "helper is gone with the state dir");
});
