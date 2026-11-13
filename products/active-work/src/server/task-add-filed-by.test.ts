import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CLIENT_HEADER, silentLogger, type DaemonHandle } from '@titan-design/daemon';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { captureStderr, withStderr } from '../test-support/child-startup.js';
import { requireDistBin } from '../test-support/cli-runner.js';
import { assertSafeToRemove, withTempActiveRoot } from '../test-support/test-helpers.js';
import { startActiveWorkDaemon } from './daemon.js';
import { buildHttpApp } from './http.js';

/*
 * Who filed a task depends on whose environment the command reads. The daemon's /rpc and MCP-over-HTTP run in the
 * daemon's process, whose AGENT_CHAT_NAME (or its absence, when the owner started it) says nothing about the caller, so
 * a task filed there must never read as the owner's or the daemon's. Stdio MCP runs as the caller's own child, so its
 * environment is the caller's and a named agent keeps its name.
 */

const SLUG = 'sample-initiative';
const TEST_PORT = 17400;
const MCP_ACCEPT = 'application/json, text/event-stream';

const add = { slug: SLUG, title: 'Filed remotely', done_when: 'the task file records who filed it, never the owner' };

const Envelope = z.object({ ok: z.literal(true), data: z.object({ filed_by: z.string() }) });

const DAEMON_ENVIRONMENTS = [
  ['an owner-started daemon', ''],
  ['a daemon an agent started', 'sample-daemon-agent'],
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function withDaemon(fn: (port: number) => Promise<void>): Promise<void> {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), 'aw-test-'));
  let handle: DaemonHandle | null = null;
  try {
    handle = await startActiveWorkDaemon({ port: 0, stateDir, logger: silentLogger });
    await fn(handle.port);
  } finally {
    await handle?.close();
    assertSafeToRemove(stateDir);
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function postJson(port: number, route: string, body: unknown): Promise<Response> {
  const accept: Record<string, string> = route === '/mcp' ? { accept: MCP_ACCEPT } : {};
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', ...accept },
    body: JSON.stringify(body),
  });
}

async function filedOverRpc(port: number): Promise<string> {
  return Envelope.parse(await (await postJson(port, '/rpc/task.add', add)).json()).data.filed_by;
}

/** The MCP reply is either plain JSON or one server-sent `data:` line. */
function mcpReply(raw: string): unknown {
  const json = raw.startsWith('{') ? raw : (raw.split('\n').find((line) => line.startsWith('data:')) ?? '').slice(5);
  return JSON.parse(json);
}

async function filedOverMcpHttp(port: number): Promise<string> {
  const call = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'active__task__add', arguments: add } };
  const reply = z
    .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
    .parse(mcpReply(await (await postJson(port, '/mcp', call)).text()));
  return Envelope.parse(JSON.parse(reply.result.content[0]?.text ?? '')).data.filed_by;
}

async function filedOverStdio(env: Record<string, string>): Promise<string> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [requireDistBin(), 'mcp', 'serve', '--stdio'],
    env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'filed-by-test', version: '0.0.0' }, { capabilities: {} });
  const stderr = captureStderr(transport.stderr);
  try {
    await withStderr(client.connect(transport), stderr);
    const result = await withStderr(client.callTool({ name: 'active__task__add', arguments: add }), stderr);
    const content = z.array(z.object({ text: z.string() })).parse(result.content);
    return Envelope.parse(JSON.parse(content[0]?.text ?? '')).data.filed_by;
  } finally {
    await client.close();
  }
}

function stringEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

describe('filed_by on the daemon surfaces', () => {
  it.each(DAEMON_ENVIRONMENTS)('task add over rpc never records filed_by owner (%s)', async (_label, daemonName) => {
    await withTempActiveRoot(async () => {
      vi.stubEnv('AGENT_CHAT_NAME', daemonName);
      const viaHttpApp = Envelope.parse(
        await (
          await buildHttpApp({ port: TEST_PORT }).fetch(
            new Request(`http://127.0.0.1:${TEST_PORT}/rpc/task.add`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test' },
              body: JSON.stringify(add),
            }),
          )
        ).json(),
      ).data.filed_by;

      let viaDaemon = '';
      await withDaemon(async (port) => {
        viaDaemon = await filedOverRpc(port);
      });

      expect(viaHttpApp).toBe('unknown');
      expect(viaDaemon).toBe('unknown');
    });
  });

  it.each(DAEMON_ENVIRONMENTS)('task add over mcp never records filed_by owner (%s)', async (_label, daemonName) => {
    await withTempActiveRoot(async () => {
      vi.stubEnv('AGENT_CHAT_NAME', daemonName);

      let filed = '';
      await withDaemon(async (port) => {
        filed = await filedOverMcpHttp(port);
      });

      expect(filed).toBe('unknown');
    });
  });
});

describe('filed_by over stdio MCP', () => {
  it("task add over stdio mcp records the calling agent's name", async () => {
    await withTempActiveRoot(async () => {
      const filed = await filedOverStdio({ ...stringEnv(), AGENT_CHAT_NAME: 'sample-stdio-agent' });

      expect(filed).toBe('sample-stdio-agent');
    });
  });
});
