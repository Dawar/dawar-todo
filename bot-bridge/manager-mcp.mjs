// One stdio MCP adapter per manager session. Only the service owns state/native RPC.
import { createInterface } from "node:readline";
import { request } from "node:http";
import { MANAGER_TOOLS } from "./manager-tools.mjs";

const [socketPath, botId] = process.argv.slice(2);
const token = process.env.DAWAR_MANAGER_TOKEN;
if (!socketPath || !botId || !token)
  throw new Error("Missing manager connection configuration.");
const reply = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const invoke = (name, args) =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify({ botId, name, args });
    const req = request(
      {
        socketPath,
        path: "/tools/call",
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 110000,
      },
      (res) => {
        let bytes = 0,
          chunks = [];
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 8 * 1024 * 1024)
            res.destroy(new Error("Manager response too large."));
          else chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks));
            value.error
              ? reject(new Error(value.error))
              : resolve(value.result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("timeout", () =>
      req.destroy(
        new Error(
          "Manager operation timed out; inspect its receipt before retrying.",
        ),
      ),
    );
    req.on("error", reject);
    req.end(body);
  });
async function handle(message) {
  if (message.id === undefined) return;
  const id = message.id;
  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: ["2024-11-05", "2025-03-26", "2025-06-18"].includes(
            message.params?.protocolVersion,
          )
            ? message.params.protocolVersion
            : "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "dawar-codex-manager", version: "1.0.0" },
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: MANAGER_TOOLS };
        break;
      case "tools/call":
        try {
          const value = await invoke(
            message.params.name,
            message.params.arguments ?? {},
          );
          result = { content: [{ type: "text", text: JSON.stringify(value) }] };
        } catch (error) {
          result = {
            isError: true,
            content: [{ type: "text", text: error.message }],
          };
        }
        break;
      default:
        reply({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Unknown MCP method." },
        });
        return;
    }
    reply({ jsonrpc: "2.0", id, result });
  } catch (error) {
    reply({
      jsonrpc: "2.0",
      id,
      error: { code: -32603, message: error.message },
    });
  }
}
createInterface({ input: process.stdin }).on("line", (line) => {
  if (Buffer.byteLength(line) > 256 * 1024) return;
  try {
    void handle(JSON.parse(line));
  } catch {
    reply({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Invalid JSON." },
    });
  }
});
