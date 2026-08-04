import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { OpenClawConfig } from "../config/config.js";
import { logDebug, logWarn } from "../logger.js";
import { loadEmbeddedPiMcpConfig } from "./embedded-pi-mcp.js";
import {
  describeStdioMcpServerLaunchConfig,
  resolveStdioMcpServerLaunchConfig,
} from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";

type BundleMcpToolRuntime = {
  tools: AnyAgentTool[];
  dispose: () => Promise<void>;
};

// Cap the 2026-07-28 era probe so legacy stdio servers that never answer
// pre-initialize requests only delay startup by this much per server.
const BUNDLE_MCP_VERSION_PROBE_TIMEOUT_MS = 3000;

type BundleMcpSession = {
  serverName: string;
  client: Client;
  transport: StdioClientTransport;
  detachStderr?: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function listAllTools(client: Client) {
  // v2 listTools() without a cursor auto-aggregates every page.
  const listed = await client.listTools();
  return listed.tools;
}

function toAgentToolResult(params: {
  serverName: string;
  toolName: string;
  result: CallToolResult;
}): AgentToolResult<unknown> {
  const content = Array.isArray(params.result.content)
    ? (params.result.content as AgentToolResult<unknown>["content"])
    : [];
  const normalizedContent: AgentToolResult<unknown>["content"] =
    content.length > 0
      ? content
      : params.result.structuredContent !== undefined
        ? [
            {
              type: "text",
              text: JSON.stringify(params.result.structuredContent, null, 2),
            },
          ]
        : ([
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: params.result.isError === true ? "error" : "ok",
                  server: params.serverName,
                  tool: params.toolName,
                },
                null,
                2,
              ),
            },
          ] as AgentToolResult<unknown>["content"]);
  const details: Record<string, unknown> = {
    mcpServer: params.serverName,
    mcpTool: params.toolName,
  };
  if (params.result.structuredContent !== undefined) {
    details.structuredContent = params.result.structuredContent;
  }
  if (params.result.isError === true) {
    details.status = "error";
  }
  return {
    content: normalizedContent,
    details,
  };
}

function attachStderrLogging(serverName: string, transport: StdioClientTransport) {
  const stderr = transport.stderr;
  if (!stderr || typeof stderr.on !== "function") {
    return undefined;
  }
  const onData = (chunk: Buffer | string) => {
    const message = String(chunk).trim();
    if (!message) {
      return;
    }
    for (const line of message.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed) {
        logDebug(`bundle-mcp:${serverName}: ${trimmed}`);
      }
    }
  };
  stderr.on("data", onData);
  return () => {
    if (typeof stderr.off === "function") {
      stderr.off("data", onData);
    } else if (typeof stderr.removeListener === "function") {
      stderr.removeListener("data", onData);
    }
  };
}

async function disposeSession(session: BundleMcpSession) {
  session.detachStderr?.();
  await session.client.close().catch(() => {});
  await session.transport.close().catch(() => {});
}

export async function createBundleMcpToolRuntime(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  reservedToolNames?: Iterable<string>;
}): Promise<BundleMcpToolRuntime> {
  const loaded = loadEmbeddedPiMcpConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
  });
  for (const diagnostic of loaded.diagnostics) {
    logWarn(`bundle-mcp: ${diagnostic.pluginId}: ${diagnostic.message}`);
  }
  // Skip spawning when no MCP servers are configured.
  if (Object.keys(loaded.mcpServers).length === 0) {
    return { tools: [], dispose: async () => {} };
  }

  const reservedNames = new Set(
    Array.from(params.reservedToolNames ?? [], (name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const sessions: BundleMcpSession[] = [];
  const tools: AnyAgentTool[] = [];

  try {
    for (const [serverName, rawServer] of Object.entries(loaded.mcpServers)) {
      const launch = resolveStdioMcpServerLaunchConfig(rawServer);
      if (!launch.ok) {
        logWarn(`bundle-mcp: skipped server "${serverName}" because ${launch.reason}.`);
        continue;
      }
      const launchConfig = launch.config;

      const transport = new StdioClientTransport({
        command: launchConfig.command,
        args: launchConfig.args,
        env: launchConfig.env,
        cwd: launchConfig.cwd,
        stderr: "pipe",
      });
      const client = new Client(
        {
          name: "openclaw-bundle-mcp",
          version: "0.0.0",
        },
        {
          // Speak the 2026-07-28 stateless protocol when the server supports it
          // (no initialize handshake), and fall back to the legacy 2025 handshake
          // for older servers.
          versionNegotiation: {
            mode: "auto",
            probe: { timeoutMs: BUNDLE_MCP_VERSION_PROBE_TIMEOUT_MS },
          },
        },
      );
      const session: BundleMcpSession = {
        serverName,
        client,
        transport,
        detachStderr: attachStderrLogging(serverName, transport),
      };

      try {
        await client.connect(transport);
        const listedTools = await listAllTools(client);
        sessions.push(session);
        for (const tool of listedTools) {
          const normalizedName = tool.name.trim().toLowerCase();
          if (!normalizedName) {
            continue;
          }
          if (reservedNames.has(normalizedName)) {
            logWarn(
              `bundle-mcp: skipped tool "${tool.name}" from server "${serverName}" because the name already exists.`,
            );
            continue;
          }
          reservedNames.add(normalizedName);
          tools.push({
            name: tool.name,
            label: tool.title ?? tool.name,
            description:
              tool.description?.trim() ||
              `Provided by bundle MCP server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}).`,
            parameters: tool.inputSchema,
            execute: async (_toolCallId, input) => {
              const result = await client.callTool({
                name: tool.name,
                arguments: isRecord(input) ? input : {},
              });
              return toAgentToolResult({
                serverName,
                toolName: tool.name,
                result,
              });
            },
          });
        }
      } catch (error) {
        logWarn(
          `bundle-mcp: failed to start server "${serverName}" (${describeStdioMcpServerLaunchConfig(launchConfig)}): ${String(error)}`,
        );
        await disposeSession(session);
      }
    }

    return {
      tools,
      dispose: async () => {
        await Promise.allSettled(sessions.map((session) => disposeSession(session)));
      },
    };
  } catch (error) {
    await Promise.allSettled(sessions.map((session) => disposeSession(session)));
    throw error;
  }
}
