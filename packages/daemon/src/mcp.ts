/**
 * MCP projection of the registry: every command becomes a tool, with `inputSchema` derived
 * from its zod args. The same handlers serve stdio and the daemon's `/mcp` route.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  EXIT,
  commandToTool,
  errorEnvelope,
  invokeCommand,
  toolNameToCommandName,
  type BaseContext,
  type JsonEnvelope,
  type McpToolDescriptor,
} from "@titan-design/registry";
import type { SurfaceOptions } from "./surface.js";

export interface McpServerOptions<Ctx extends BaseContext = BaseContext> extends SurfaceOptions<Ctx> {
  /** Prepended to every tool name so one client can host several registries, e.g. `active__`. */
  toolPrefix: string;
  /** Server identity reported in the MCP handshake. */
  name: string;
  version: string;
}

export interface ToolCallOutcome {
  isError: boolean;
  envelope: JsonEnvelope<unknown>;
}

/** Every registered command as an MCP tool, sorted by the registry. */
export function listTools<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): McpToolDescriptor[] {
  return options.registry.list().map((cmd) => commandToTool(cmd, { prefix: options.toolPrefix }));
}

/** Resolve a tool name to its command and run it. Always returns an envelope; never throws. */
export async function invokeTool<Ctx extends BaseContext>(
  options: McpServerOptions<Ctx>,
  toolName: string,
  rawArgs: unknown,
): Promise<ToolCallOutcome> {
  const commandName = toolNameToCommandName(toolName, { prefix: options.toolPrefix });
  const cmd = commandName ? options.registry.get(commandName) : undefined;
  if (!cmd) {
    return { isError: true, envelope: errorEnvelope(`Unknown tool: ${toolName}`, EXIT.USAGE) };
  }

  const { envelope } = await invokeCommand(cmd, rawArgs, options.createContext("mcp"), {
    invalidArgsCode: EXIT.DATAERR,
    formatError: options.formatError,
  });
  return { isError: !envelope.ok, envelope };
}

/** Wire the tool handlers onto a server instance. Exposed so tests can use a linked transport pair. */
export function attachHandlers<Ctx extends BaseContext>(server: Server, options: McpServerOptions<Ctx>): void {
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listTools(options) }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const { isError, envelope } = await invokeTool(options, name, args);
    return { isError, content: [{ type: "text", text: JSON.stringify(envelope) }] };
  });
}

/** A fully-wired MCP server, sans transport. */
export function createMcpServer<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): Server {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: {} } },
  );
  attachHandlers(server, options);
  return server;
}

/** Serve MCP over stdio. Resolves when the transport closes (the client disconnected). */
export async function runMcpStdio<Ctx extends BaseContext>(options: McpServerOptions<Ctx>): Promise<void> {
  const server = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await new Promise<void>((resolve) => {
    const original = transport.onclose;
    transport.onclose = () => {
      try {
        original?.();
      } finally {
        resolve();
      }
    };
  });
}
