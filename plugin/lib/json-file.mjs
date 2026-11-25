import fs from "node:fs";
import path from "node:path";

/**
 * Read a JSON file without ever turning a parse error into `{}`: writing `{}`
 * back would destroy the user's Claude Code settings. Callers must skip and
 * report malformed files instead.
 */
export function readJsonFile(file) {
  if (!fs.existsSync(file)) return { exists: false, ok: true, value: undefined };
  try {
    return { exists: true, ok: true, value: JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (err) {
    return { exists: true, ok: false, error: String(err?.message ?? err) };
  }
}

/** Owner-only, atomic write that follows a symlinked settings file rather than replacing the link. */
export function writeJsonFile(file, value, { mode = 0o600 } = {}) {
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(tmp, target);
}
