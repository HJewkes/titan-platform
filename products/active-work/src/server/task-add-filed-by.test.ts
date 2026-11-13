import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import '../commands/index.js';
import taskAdd from '../commands/task-add.js';
import { asTask } from '../test-support/as-task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { buildHttpApp } from './http.js';
import { invokeTool, mcpOptions } from './mcp.js';

/*
 * Over /rpc and MCP, `process.env` is the daemon's: its AGENT_CHAT_NAME, or none at all when the owner started it.
 * Neither says who called, so a task filed through either surface must never read as the owner's or the daemon's.
 */

const SLUG = 'sample-initiative';
const TEST_PORT = 17400;

const add = { slug: SLUG, title: 'Filed remotely', done_when: 'the task file records who filed it, never the owner' };

const FiledBy = z.object({ filed_by: z.string() });

afterEach(() => {
  vi.unstubAllEnvs();
});

async function filedOverRpc(): Promise<string> {
  const res = await buildHttpApp({ port: TEST_PORT }).fetch(
    new Request(`http://127.0.0.1:${TEST_PORT}/rpc/task.add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-titan-client': 'test' },
      body: JSON.stringify(add),
    }),
  );
  return z.object({ ok: z.literal(true), data: FiledBy }).parse(await res.json()).data.filed_by;
}

async function filedOverMcp(): Promise<string> {
  const { envelope } = await invokeTool('active__task__add', add);
  return z.object({ ok: z.literal(true), data: FiledBy }).parse(envelope).data.filed_by;
}

describe('filed_by on the daemon surfaces', () => {
  it.each([
    ['an owner-started daemon', ''],
    ['a daemon an agent started', 'sample-daemon-agent'],
  ])('task add over rpc never records filed_by owner (%s)', async (_label, daemonName) => {
    await withTempActiveRoot(async () => {
      vi.stubEnv('AGENT_CHAT_NAME', daemonName);

      const viaHttpApp = await filedOverRpc();
      const viaDaemonContext = asTask(await taskAdd.run(add, mcpOptions().createContext('http'))).filed_by;

      expect(viaHttpApp).toBe('unknown');
      expect(viaDaemonContext).toBe('unknown');
    });
  });

  it.each([
    ['an owner-started daemon', ''],
    ['a daemon an agent started', 'sample-daemon-agent'],
  ])('task add over mcp never records filed_by owner (%s)', async (_label, daemonName) => {
    await withTempActiveRoot(async () => {
      vi.stubEnv('AGENT_CHAT_NAME', daemonName);

      const filed = await filedOverMcp();

      expect(filed).toBe('unknown');
    });
  });
});
