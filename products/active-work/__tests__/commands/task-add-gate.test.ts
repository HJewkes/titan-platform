import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import '../../src/commands/index.js';
import { registry } from '../../src/registry/index.js';
import type { CommandContext } from '../../src/registry/types.js';
import { ValidationError } from '../../src/errors.js';
import {
  agentCaller,
  DONE_WHEN_MIN_CHARS,
  doneWhenProblem,
} from '../../src/commands/_done-when-gate.js';
import { withEmptyActiveRoot } from '../setup/test-helpers.js';

const GOOD = 'the gate refuses short entries and the tests prove it';

async function run(name: string, args: unknown, activeRoot: string, caller?: 'agent') {
  const cmd = registry.get(name);
  if (!cmd) throw new Error(`unknown command: ${name}`);
  const ctx: CommandContext = { activeRoot, warnings: [], format: 'json', caller };
  return cmd.run(cmd.args.parse(args), ctx) as Promise<{ id: string }>;
}

async function withInitiative(fn: (root: string) => Promise<void>): Promise<void> {
  await withEmptyActiveRoot(async (root) => {
    await run('new', { slug: 'gate-test', title: 'Gate' }, root);
    await fn(root);
  });
}

async function taskFiles(root: string): Promise<string[]> {
  const dir = path.join(root, 'gate-test', 'tasks');
  return fs.readdir(dir).catch(() => []);
}

describe('task.add done_when gate', () => {
  it('an agent caller with no done_when is refused and no file is written', async () => {
    await withInitiative(async (root) => {
      await expect(run('task.add', { slug: 'gate-test', title: 'T' }, root, 'agent')).rejects.toThrow(
        ValidationError,
      );
      expect(await taskFiles(root)).toEqual([]);
    });
  });

  it('an agent caller with a short done_when is refused with the minimum named', async () => {
    await withInitiative(async (root) => {
      await expect(
        run('task.add', { slug: 'gate-test', title: 'T', done_when: 'tests pass' }, root, 'agent'),
      ).rejects.toThrow(`at least ${DONE_WHEN_MIN_CHARS} characters`);
    });
  });

  it('an agent caller with a good done_when files the task', async () => {
    await withInitiative(async (root) => {
      const task = await run('task.add', { slug: 'gate-test', title: 'T', done_when: GOOD }, root, 'agent');
      expect(task.id).toMatch(/-1$/);
    });
  });

  it('a human caller with a short done_when still files', async () => {
    await withInitiative(async (root) => {
      await run('task.add', { slug: 'gate-test', title: 'T', done_when: 'ok' }, root);
      await run('task.add', { slug: 'gate-test', title: 'U' }, root);
      expect(await taskFiles(root)).toHaveLength(2);
    });
  });

  it('a done_when equal to the title is refused', () => {
    expect(doneWhenProblem('Ship   The Thing please, fully and completely done', ' ship the thing please, fully and completely done ')).toMatch(
      /repeats the title/,
    );
  });

  it('39 chars refused, 40 accepted', () => {
    expect(doneWhenProblem('t', 'x'.repeat(39))).toBeDefined();
    expect(doneWhenProblem('t', 'x'.repeat(40))).toBeUndefined();
  });

  it('the refused call leaves the next id unchanged', async () => {
    await withInitiative(async (root) => {
      await expect(run('task.add', { slug: 'gate-test', title: 'T' }, root, 'agent')).rejects.toThrow();
      const task = await run('task.add', { slug: 'gate-test', title: 'T', done_when: GOOD }, root, 'agent');
      expect(task.id).toMatch(/-1$/);
    });
  });
});

describe('agentCaller', () => {
  it('reads AGENT_CHAT_NAME and CLAUDECODE, and nothing else', () => {
    expect(agentCaller({ AGENT_CHAT_NAME: 'x' })).toBe('agent');
    expect(agentCaller({ CLAUDECODE: '1' })).toBe('agent');
    expect(agentCaller({ HOME: '/h' })).toBeUndefined();
  });
});
