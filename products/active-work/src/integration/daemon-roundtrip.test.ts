/**
 * Integration: spawn the live HTTP daemon from dist as a child process on a random
 * free port, exercise /health, /version, /rpc/*, /mcp, /ui, then SIGTERM
 * and confirm the PID file is cleaned up.
 *
 * Each request runs against a real network socket — this test catches
 * regressions in the hono routing, JSON envelope, MCP-over-HTTP transport,
 * and the dashboard placeholder route that the unit suite can't see.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { waitForHealth } from '../test-support/child-startup.js';
import { findDaemonPidFile, findFreePort, spawnDaemon, stopDaemon } from '../test-support/daemon-harness.js';

async function postJson<S extends z.ZodType>(
  schema: S,
  url: string,
  body: unknown,
): Promise<{ status: number; envelope: { ok: true; data: z.infer<S> } }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-titan-client': 'test' },
    body: JSON.stringify(body),
  });
  const raw = z.object({ ok: z.literal(true), data: z.unknown() }).parse(await res.json());
  return { status: res.status, envelope: { ok: raw.ok, data: schema.parse(raw.data) } };
}

const mcpResponse = z.object({
  result: z
    .object({
      tools: z.array(z.unknown()).optional(),
      content: z.array(z.object({ type: z.string(), text: z.string() })).optional(),
    })
    .optional(),
  error: z.unknown().optional(),
});

function parseMcpResponse(raw: string): z.infer<typeof mcpResponse> {
  if (raw.startsWith('{')) return mcpResponse.parse(JSON.parse(raw));
  // Server-Sent Events form: data:<json>\n
  const dataLine = raw.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) throw new Error(`unexpected MCP response shape: ${raw.slice(0, 200)}`);
  return mcpResponse.parse(JSON.parse(dataLine.slice('data:'.length).trim()));
}

describe('integration: live daemon roundtrip on a random port', () => {
  it('serves health, version, rpc, mcp, ui; cleans pid file on SIGTERM', async () => {
    const port = await findFreePort();
    const stateRoot = mkdtempSync(path.join(tmpdir(), 'aw-rt-state-'));
    const activeRoot = mkdtempSync(path.join(tmpdir(), 'aw-rt-active-'));

    const { child, stderr } = spawnDaemon(port, stateRoot, activeRoot, { indexWatch: true });

    try {
      await waitForHealth(port, 15_000, child, stderr);

      // /health
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
      expect(healthRes.status).toBe(200);
      const health = z
        .object({ ok: z.boolean(), port: z.number(), version: z.string() })
        .parse(await healthRes.json());
      expect(health.ok).toBe(true);
      expect(health.port).toBe(port);
      expect(typeof health.version).toBe('string');

      // /version
      const versionRes = await fetch(`http://127.0.0.1:${port}/version`);
      expect(versionRes.status).toBe(200);
      const version = z.object({ version: z.string() }).parse(await versionRes.json());
      expect(typeof version.version).toBe('string');

      // /rpc/new — create an initiative on disk via the live HTTP path.
      const newRes = await postJson(
        z.object({ slug: z.string(), dir: z.string() }),
        `http://127.0.0.1:${port}/rpc/new`,
        { slug: 'rt-init', title: 'Roundtrip Init', ship_target: '2026-Q4' },
      );
      expect(newRes.status).toBe(200);
      expect(newRes.envelope.ok).toBe(true);
      expect(newRes.envelope.data.slug).toBe('rt-init');
      expect(existsSync(path.join(activeRoot, 'rt-init', 'brief.md'))).toBe(true);

      // /rpc/task.add — task file written.
      const taskRes = await postJson(z.object({ id: z.string() }), `http://127.0.0.1:${port}/rpc/task.add`, {
        slug: 'rt-init',
        title: 'first task',
      });
      expect(taskRes.envelope.ok).toBe(true);
      expect(taskRes.envelope.data.id).toBe('RI-1');
      expect(existsSync(path.join(activeRoot, 'rt-init', 'tasks', 'RI-1.yml'))).toBe(true);

      // /rpc/list — initiative shows up.
      const listRes = await postJson(
        z.object({
          sections: z.array(
            z.object({ heading: z.string(), items: z.array(z.object({ slug: z.string() })) }),
          ),
        }),
        `http://127.0.0.1:${port}/rpc/list`,
        {},
      );
      const focused = listRes.envelope.data.sections.find((s) => s.heading === 'Focused');
      expect(focused?.items.map((i) => i.slug)).toContain('rt-init');

      // /mcp — tools/list.
      const toolsRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-titan-client': 'test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      });
      expect(toolsRes.ok).toBe(true);
      const toolsParsed = parseMcpResponse(await toolsRes.text());
      expect(Array.isArray(toolsParsed.result?.tools)).toBe(true);
      expect(toolsParsed.result!.tools!.length).toBeGreaterThanOrEqual(36);

      // /mcp — tools/call active__list.
      const callRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'x-titan-client': 'test',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'active__list', arguments: {} },
        }),
      });
      expect(callRes.ok).toBe(true);
      const callParsed = parseMcpResponse(await callRes.text());
      const content = callParsed.result?.content;
      expect(Array.isArray(content)).toBe(true);
      const inner = z
        .object({ ok: z.boolean(), data: z.object({ sections: z.unknown() }) })
        .parse(JSON.parse(content![0].text));
      expect(inner.ok).toBe(true);
      expect(inner.data.sections).toBeDefined();

      // /ui/ — placeholder or built dashboard.
      const uiRes = await fetch(`http://127.0.0.1:${port}/ui/`);
      expect(uiRes.status).toBe(200);
      const html = await uiRes.text();
      // Accept either the placeholder or a built index.
      expect(html.toLowerCase()).toMatch(/<html|<!doctype/);
    } finally {
      await stopDaemon(child, 10_000);
      // Poll briefly for PID file removal — handler runs after server close.
      const pidGone = await pollUntilGone(() => findDaemonPidFile(stateRoot), 5_000);
      expect(pidGone).toBe(true);
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(activeRoot, { recursive: true, force: true });
    }
  }, 45_000);
});

async function pollUntilGone(probe: () => string | null, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe() === null) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return probe() === null;
}
