import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the installed MCP v2 SDK entry points so generated fixture scripts can
// import them by absolute path from temp dirs (bare specifiers would not resolve
// outside the repo).
const SERVER_INDEX_PATH = fileURLToPath(import.meta.resolve("@modelcontextprotocol/server"));
const SERVER_STDIO_PATH = fileURLToPath(import.meta.resolve("@modelcontextprotocol/server/stdio"));
const CLIENT_INDEX_PATH = fileURLToPath(import.meta.resolve("@modelcontextprotocol/client"));
const CLIENT_STDIO_PATH = fileURLToPath(import.meta.resolve("@modelcontextprotocol/client/stdio"));

export async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

const PROBE_TOOL_REGISTRATION = `const server = new McpServer({ name: "bundle-probe", version: "1.0.0" });
server.registerTool("bundle_probe", { description: "Bundle MCP probe" }, async () => {
  return {
    content: [{ type: "text", text: process.env.BUNDLE_PROBE_TEXT ?? "missing-probe-text" }],
  };
});
`;

/**
 * Writes a probe MCP server built on the v2 SDK that serves the legacy
 * (2025-era) protocol over stdio — the compatibility leg for existing
 * user-configured MCP servers.
 */
export async function writeBundleProbeMcpServer(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(SERVER_INDEX_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SERVER_STDIO_PATH)};

${PROBE_TOOL_REGISTRATION}
await server.connect(new StdioServerTransport());
`,
  );
}

/**
 * Writes a probe MCP server built on the v2 SDK that only accepts 2026-07-28
 * (stateless) openings and rejects the legacy initialize handshake — used to
 * prove the client negotiates the modern era end-to-end.
 */
export async function writeBundleProbeMcpServerStateless(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(SERVER_INDEX_PATH)};
import { serveStdio } from ${JSON.stringify(SERVER_STDIO_PATH)};

serveStdio(
  () => {
    ${PROBE_TOOL_REGISTRATION.replace(/^/gm, "    ").trimEnd()}
    return server;
  },
  { legacy: "reject" },
);
`,
  );
}

export async function writeClaudeBundle(params: {
  pluginRoot: string;
  serverScriptPath: string;
}): Promise<void> {
  await fs.mkdir(path.join(params.pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(params.pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(params.pluginRoot, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: [path.relative(params.pluginRoot, params.serverScriptPath)],
            env: {
              BUNDLE_PROBE_TEXT: "FROM-BUNDLE",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export async function writeFakeClaudeCli(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Client } from ${JSON.stringify(CLIENT_INDEX_PATH)};
import { StdioClientTransport } from ${JSON.stringify(CLIENT_STDIO_PATH)};

function readArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(name + "=")) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

const mcpConfigPath = readArg("--mcp-config");
if (!mcpConfigPath) {
  throw new Error("missing --mcp-config");
}

const raw = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
const servers = raw?.mcpServers ?? raw?.servers ?? {};
const server = servers.bundleProbe ?? Object.values(servers)[0];
if (!server || typeof server !== "object") {
  throw new Error("missing bundleProbe MCP server");
}

const transport = new StdioClientTransport({
  command: server.command,
  args: Array.isArray(server.args) ? server.args : [],
  env: server.env && typeof server.env === "object" ? server.env : undefined,
  cwd:
    typeof server.cwd === "string"
      ? server.cwd
      : typeof server.workingDirectory === "string"
        ? server.workingDirectory
        : undefined,
});
// Default (legacy) connect on purpose: this fixture emulates an external
// 2025-era host CLI talking to the bundle probe server.
const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
if (!tools.tools.some((tool) => tool.name === "bundle_probe")) {
  throw new Error("bundle_probe tool not exposed");
}
const result = await client.callTool({ name: "bundle_probe", arguments: {} });
await transport.close();

const text = Array.isArray(result.content)
  ? result.content
      .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("\\n")
  : "";

process.stdout.write(
  JSON.stringify({
    session_id: readArg("--session-id") ?? randomUUID(),
    message: "BUNDLE MCP OK " + text,
  }) + "\\n",
);
`,
  );
}
