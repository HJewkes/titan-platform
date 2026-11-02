/**
 * Smoke test for the stdio MCP server.
 *
 * Spawns the built CLI's public entrypoint (`active-work mcp serve --stdio`),
 * hands it stdio, drives a `tools/list` request through an MCP `Client`, and
 * asserts a sensible response.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureStderr, withStderr } from './child-startup.js';
import { requireDistBin } from './cli-runner.js';

describe('integration: stdio MCP server', () => {
  it('handshakes and lists tools over real stdio', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'aw-mcp-int-'));
    try {
      const filteredEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string') filteredEnv[k] = v;
      }
      filteredEnv.ACTIVE_ROOT = root;

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [requireDistBin(), 'mcp', 'serve', '--stdio'],
        env: filteredEnv,
        stderr: 'pipe',
      });

      const client = new Client(
        { name: 'integration-test', version: '0.0.0' },
        { capabilities: {} },
      );
      const stderr = captureStderr(transport.stderr);
      await withStderr(client.connect(transport), stderr);

      const listed = await withStderr(client.listTools(), stderr);
      expect(listed.tools.length).toBeGreaterThanOrEqual(34);

      const names = listed.tools.map((t) => t.name);
      expect(names).toContain('active__list');
      expect(names).toContain('active__task__add');
      expect(names).toContain('active__mcp__serve');

      const result = await client.callTool({
        name: 'active__list',
        arguments: {},
      });
      expect(result.isError).toBe(false);
      const content = result.content as Array<{ type: string; text: string }>;
      const envelope = JSON.parse(content[0]!.text) as { ok: boolean };
      expect(envelope.ok).toBe(true);

      await client.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
