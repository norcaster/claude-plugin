/**
 * Where the gateway API key lives when Claude Code fetches it through an
 * `apiKeyHelper` instead of reading it from settings.json.
 *
 * Claude Code sends the helper's output in BOTH the Authorization and
 * x-api-key headers, which is exactly what the gateway's wire contract needs,
 * so the key no longer has to sit in plaintext in ~/.claude/settings.json.
 * macOS: the login Keychain via /usr/bin/security. Elsewhere: an owner-only
 * file under ~/.claude/norcaster (still outside any dotfile-synced settings).
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { stateDir } from "./paths.mjs";

export const KEYCHAIN_SERVICE = "norcaster-claude-code";
/** Substring that identifies an apiKeyHelper command as ours, wherever the home directory lives. */
export const HELPER_MARKER = path.join("norcaster", "api-key-helper.mjs");

export function installedHelperPath() {
  return path.join(stateDir(), "api-key-helper.mjs");
}
export function keyFilePath() {
  return path.join(stateDir(), "api-key");
}
/** Claude Code runs the helper through the shell; node is on PATH wherever Claude Code runs. */
export function helperCommand() {
  return `node "${installedHelperPath()}"`;
}
export function isOurHelper(value) {
  return typeof value === "string" && value.includes(HELPER_MARKER);
}

/** keychain on macOS, file elsewhere; NORCASTER_CREDENTIAL_STORE overrides (tests, CI, headless Macs). */
export function defaultStore(env = process.env) {
  const forced = String(env.NORCASTER_CREDENTIAL_STORE ?? "").trim();
  if (forced === "keychain" || forced === "file") return forced;
  return process.platform === "darwin" && fs.existsSync("/usr/bin/security") ? "keychain" : "file";
}

export const macKeychain = {
  name: "keychain",
  store(account, secret) {
    // -U updates an existing item in place; execFile keeps the secret off any shell.
    execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", account, "-w", secret], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  },
  read(account) {
    try {
      return execFileSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  },
  remove(account) {
    try {
      execFileSync("/usr/bin/security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};

export const fileStore = {
  name: "file",
  store(_account, secret) {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(keyFilePath(), `${secret}\n`, { mode: 0o600 });
    fs.chmodSync(keyFilePath(), 0o600);
  },
  read() {
    try {
      return fs.readFileSync(keyFilePath(), "utf8").trim();
    } catch {
      return "";
    }
  },
  remove() {
    fs.rmSync(keyFilePath(), { force: true });
    return true;
  },
};

export function storeFor(name) {
  return name === "keychain" ? macKeychain : fileStore;
}

export function describeStore(name) {
  return name === "keychain" ? "the macOS Keychain" : "an owner-only file under ~/.claude/norcaster";
}

/** Run whatever apiKeyHelper settings.json names, the way Claude Code does. Empty string on failure. */
export function runHelper(command) {
  if (typeof command !== "string" || !command.trim()) return "";
  try {
    const r = spawnSync(command, { shell: true, encoding: "utf8", timeout: 4000, stdio: ["ignore", "pipe", "ignore"] });
    return r.status === 0 ? String(r.stdout ?? "").trim() : "";
  } catch {
    return "";
  }
}
