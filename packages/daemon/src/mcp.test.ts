import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, listTools, type McpServerOptions } from "./mcp.js";
import { createTestContext, createTestRegistry, type TestContext } from "./test-fixtures.js";

const options: McpServerOptions<TestContext> = {
  registry: createTestRegistry(),
  createContext: createTestContext,
  toolPrefix: "test__",
  name: "test-daemon",
  version: "1.2.3",
};

/** A client wired to a server over a linked in-memory transport pair. */
async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(options);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function envelopeOf(result: unknown): unknown {
  const [first] = (result as { content: [{ text: string }] }).content;
  return JSON.parse(first.text);
}

describe("listTools", () => {
  it("projects every command as a prefixed tool with an object inputSchema", () => {
    const tools = listTools(options);

    expect(tools.map((t) => t.name)).toEqual(["test__boom", "test__greet"]);
    const greet = tools.find((t) => t.name === "test__greet");
    expect(greet?.description).toBe("Greet someone");
    expect(greet?.inputSchema).toMatchObject({ type: "object", properties: { name: { type: "string" } } });
    expect(greet?.inputSchema).not.toHaveProperty("$schema");
  });
});

describe("CallTool", () => {
  it("returns a success envelope built from the mcp context", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "test__greet", arguments: { name: "world" } });

    expect(result.isError).toBeFalsy();
    expect(envelopeOf(result)).toEqual({ ok: true, data: { greeting: "hello world" }, warnings: ["via mcp"] });
  });

  it("returns an error envelope when the command throws", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "test__boom", arguments: {} });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toEqual({ ok: false, error: "kaboom", code: 78 });
  });

  it("returns an error envelope for invalid arguments", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "test__greet", arguments: { name: 42 } });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toMatchObject({ ok: false, code: 65 });
  });

  it("returns an error envelope for a tool outside this registry's prefix", async () => {
    const client = await connectedClient();

    const result = await client.callTool({ name: "other__greet", arguments: {} });

    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toEqual({ ok: false, error: "Unknown tool: other__greet", code: 64 });
  });

  it("lists tools over the wire", async () => {
    const client = await connectedClient();

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual(["test__boom", "test__greet"]);
  });
});
