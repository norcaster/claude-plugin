import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { childEnv } from "./child-env.mjs";

const SERVER = fileURLToPath(new URL("../server/index.mjs", import.meta.url));

/** Drive the stdio MCP server the way Claude Code does: one JSON-RPC message per line. */
export function startServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buffer = "";
  let nextId = 1;
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (stderr += d));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`timeout waiting for ${method}\n${stderr}`));
        }
      }, 10000).unref();
    });
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const callTool = async (name, args = {}) => {
    const res = await request("tools/call", { name, arguments: args });
    if (res.error) throw new Error(`protocol error: ${res.error.message}`);
    return { isError: res.result.isError === true, data: JSON.parse(res.result.content[0].text), raw: res.result };
  };
  const close = () => {
    child.stdin.end();
    child.kill();
  };
  return { request, notify, callTool, close, stderr: () => stderr };
}
