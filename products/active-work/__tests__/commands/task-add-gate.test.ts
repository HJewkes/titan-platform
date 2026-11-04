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
import { assembleBootstrap } from '../../src/bootstrap/prompt.js';
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

describe('task.add --draft', () => {
  const draft = { slug: 'gate-test', title: 'Sketch the idea', draft: true };
  type Row = { id: string; status: string; tags?: string[]; done_when?: string };

  it('an agent caller with --draft files a draft and no done_when', async () => {
    await withInitiative(async (root) => {
      const task = (await run('task.add', draft, root, 'agent')) as Row;
      expect(task.tags).toContain('draft');
      expect(task.done_when).toBeUndefined();
    });
  });

  it('a draft is written as an open task so a reader that knows only open and done parses it', async () => {
    await withInitiative(async (root) => {
      const task = (await run('task.add', { ...draft, tags: ['x'] }, root, 'agent')) as Row;
      expect(task.status).toBe('open');
      expect(task.tags).toEqual(['x', 'draft']);
    });
  });

  it('an agent caller without --draft is still refused, naming --draft', async () => {
    await withInitiative(async (root) => {
      await expect(run('task.add', { slug: 'gate-test', title: 'Sketch the idea' }, root, 'agent')).rejects.toThrow(
        /--draft/,
      );
    });
  });

  it('a human caller without --draft files an untagged open task', async () => {
    await withInitiative(async (root) => {
      const task = (await run('task.add', { slug: 'gate-test', title: 'T' }, root)) as Row;
      expect(task.status).toBe('open');
      expect(task.tags).toBeUndefined();
    });
  });

  it('a draft is absent from the bootstrap open list', async () => {
    await withInitiative(async (root) => {
      await run('task.add', { ...draft, title: 'Hidden draft title' }, root, 'agent');
      await run('task.add', { slug: 'gate-test', title: 'Visible open title', done_when: GOOD }, root, 'agent');
      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: 'gate-test',
        now: new Date(),
        includeLiveStatus: false,
      });
      expect(prompt).toContain('Visible open title');
      expect(prompt).not.toContain('Hidden draft title');
    });
  });

  it('task list still shows a draft', async () => {
    await withInitiative(async (root) => {
      await run('task.add', draft, root, 'agent');
      const listed = (await run('task.list', { slug: 'gate-test' }, root)) as unknown as {
        tasks: { title: string }[];
      };
      expect(listed.tasks.map((t) => t.title)).toContain('Sketch the idea');
    });
  });

  it('task edit --remove-tag draft promotes a draft once it has a usable done_when', async () => {
    await withInitiative(async (root) => {
      const { id } = await run('task.add', { ...draft, title: 'Promoted title' }, root, 'agent');
      await run('task.edit', { slug: 'gate-test', id, field: 'done_when', value: GOOD }, root, 'agent');
      await run('task.edit', { slug: 'gate-test', id, remove_tag: 'draft' }, root, 'agent');
      const { prompt } = await assembleBootstrap({
        activeRoot: root,
        slug: 'gate-test',
        now: new Date(),
        includeLiveStatus: false,
      });
      expect(prompt).toContain('Promoted title');
    });
  });

  it('an agent removing draft from a draft with no done_when is refused and the tag stays', async () => {
    await withInitiative(async (root) => {
      const { id } = await run('task.add', draft, root, 'agent');
      await expect(run('task.edit', { slug: 'gate-test', id, remove_tag: 'draft' }, root, 'agent')).rejects.toThrow(
        /cannot leave draft/,
      );
      await expect(
        run('task.edit', { slug: 'gate-test', id, field: 'tags', value: 'x', force: true }, root, 'agent'),
      ).rejects.toThrow(/cannot leave draft/);
      const listed = (await run('task.list', { slug: 'gate-test' }, root)) as unknown as {
        tasks: { tags?: string[] }[];
      };
      expect(listed.tasks[0]?.tags).toContain('draft');
    });
  });

  it('a human removing draft from a draft with no done_when is allowed', async () => {
    await withInitiative(async (root) => {
      const { id } = await run('task.add', draft, root, 'agent');
      await run('task.edit', { slug: 'gate-test', id, remove_tag: 'draft' }, root);
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
