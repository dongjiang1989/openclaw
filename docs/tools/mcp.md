---
summary: "Run MCP servers as subprocesses and expose their tools to agents"
read_when:
  - You want to give agents tools from an MCP server
  - You want to manage configured MCP servers from the CLI or chat
title: "MCP Servers"
---

# MCP Servers

OpenClaw can run [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers as subprocesses and expose their tools to agents.

## Where servers come from

- **Configured servers**: `mcp.servers` entries in `openclaw.json` (managed by `openclaw mcp` or the `/mcp` chat command).
- **Plugin bundle servers**: `.mcp.json` files shipped inside enabled plugin bundles.

Only **stdio** servers are supported right now. Entries that point at a `url` are skipped with a diagnostic.

## Config example

```json5
{
  mcp: {
    servers: {
      context7: {
        command: "uvx",
        args: ["context7-mcp"],
      },
      filesystem: {
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/srv/shared"],
        env: { LOG_LEVEL: "info" },
        cwd: "/srv/shared",
      },
    },
  },
}
```

Each server entry accepts:

- `command` (required): executable to spawn.
- `args`: command line arguments.
- `env`: environment variables for the server process.
- `cwd` (or `workingDirectory`): working directory for the server process.

Server tools are listed and called over the MCP stdio transport, and each tool's name is checked against the agent's existing tool names (collisions are skipped with a warning).

## Protocol compatibility

OpenClaw negotiates the MCP protocol version per server:

- Servers implementing the **2026-07-28 stateless spec** are used without the legacy `initialize` handshake.
- Older servers keep working through the legacy 2025 handshake (automatic fallback; no configuration needed).

## CLI

```bash
openclaw mcp list
openclaw mcp show [name]
openclaw mcp set <name> '{"command":"uvx","args":["context7-mcp"]}'
openclaw mcp unset <name>
```

In chat, `/mcp show`, `/mcp set <name> <json>`, and `/mcp unset <name>` manage the same configuration.
