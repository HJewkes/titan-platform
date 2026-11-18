import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageError, ValidationError } from '../errors.js';
import type { CommandContext } from '../registry/index.js';
import { TaskSchema } from '../schemas/task.js';
import { asTask } from '../test-support/as-task.js';
import { withTempActiveRoot } from '../test-support/test-helpers.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';
import { planOutcomeAdd } from './plan-add.js';
import taskAdd from './task-add.js';
import taskDone from './task-done.js';
import taskEdit from './task-edit.js';

const SLUG = 'sample-initiative';

const ctx = (activeRoot: string, caller?: 'agent'): CommandContext => ({ activeRoot, warnings: [], format: 'json', caller });

function requireInBrief(root: string, fields: string[]): void {
  const file = path.join(root, SLUG, 'brief.md');
  const lines = fields.map((field) => `  - ${field}`).join('\n');
  writeFileSync(file, readFileSync(file, 'utf8').replace('---\n', `---\ntask_require:\n${lines}\n`));
}

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** An agent-chat home whose events.db holds one spawn naming `task`. */
function agentChatHomeWithSpawn(task: string): void {
  const home = mkdtempSync(path.join(os.tmpdir(), 'aw-s8-chat-'));
  tempDirs.push(home);
  const db = new Database(path.join(home, 'events.db'));
  db.exec('CREATE TABLE events (id INTEGER PRIMARY KEY, ts INTEGER, kind TEXT, actor TEXT, target TEXT, ref TEXT, meta TEXT)');
  db.prepare('INSERT INTO events (ts, kind, actor, target, meta) VALUES (?, ?, ?, ?, ?)').run(
    1,
    'agent_spawned',
    'sample-seat',
    'sample-worker',
    JSON.stringify({ task }),
  );
  db.close();
  vi.stubEnv('AGENT_CHAT_HOME', home);
}

/** Stamps started_at the way `task edit <id> status in-progress` does, without the fixture's status registry. */
async function startOnDisk(root: string, id: string): Promise<void> {
  const file = path.join(root, SLUG, 'tasks', `${id}.yml`);
  await writeYaml(file, { ...(await readYaml(file, TaskSchema)), started_at: '2026-11-01T10:00:00Z' }, TaskSchema);
}

describe('task add records provenance', () => {
  it('add refuses a task without class when the brief requires it', async () => {
    await withTempActiveRoot(async (root) => {
      requireInBrief(root, ['class']);

      const missing = taskAdd.run({ slug: SLUG, title: 'No class' }, ctx(root));
      await expect(missing).rejects.toThrow(ValidationError);
      await expect(missing).rejects.toThrow('requires class on new tasks: pass --class');

      const given = asTask(await taskAdd.run({ slug: SLUG, title: 'Classed', class: 'upkeep' }, ctx(root)));
      expect(given.class).toBe('upkeep');
    });
  });

  it('filed_by comes from AGENT_CHAT_NAME not a flag', async () => {
    await withTempActiveRoot(async (root) => {
      vi.stubEnv('AGENT_CHAT_NAME', 'sample-worker');
      const claimed = { slug: SLUG, title: 'Claimed', draft: true, filed_by: 'owner' } as Parameters<typeof taskAdd.run>[0];

      const task = asTask(await taskAdd.run(claimed, ctx(root, 'agent')));

      expect(task.filed_by).toBe('sample-worker');
      expect(taskAdd.args.safeParse(claimed).data).not.toHaveProperty('filed_by');
    });
  });

  it('filed_by is owner from a plain terminal and unknown from an unnamed agent', async () => {
    await withTempActiveRoot(async (root) => {
      vi.stubEnv('AGENT_CHAT_NAME', '');

      const terminal = asTask(await taskAdd.run({ slug: SLUG, title: 'Mine' }, ctx(root)));
      const agent = asTask(await taskAdd.run({ slug: SLUG, title: 'Theirs', draft: true }, ctx(root, 'agent')));

      expect(terminal.filed_by).toBe('owner');
      expect(agent.filed_by).toBe('unknown');
    });
  });

  it('marks every value given at add as filed, and a follow-up keeps its PR reference', async () => {
    await withTempActiveRoot(async (root) => {
      const add = { slug: SLUG, title: 'Follow up', class: 'upkeep' as const, source: 'follow-up' as const };

      const task = asTask(await taskAdd.run({ ...add, from_pr: 'sample/repo#12', from_task: 'SI-1', serves: 'none' }, ctx(root)));

      expect(task.source_ref).toEqual({ from_pr: 'sample/repo#12', from_task: 'SI-1' });
      expect(task.field_origin).toEqual({ class: 'filed', source: 'filed', source_ref: 'filed', serves: 'filed' });
    });
  });

  it('refuses an outcome the plan does not hold and a source_ref that does not fit its source', async () => {
    await withTempActiveRoot(async (root) => {
      const unknownOutcome = taskAdd.run({ slug: SLUG, title: 'Serve', serves: `${SLUG}/faster-landing` }, ctx(root));
      await expect(unknownOutcome).rejects.toThrow(`Unknown outcome id: ${SLUG}/faster-landing`);
      const ownerWithoutRef = taskAdd.run({ slug: SLUG, title: 'Asked', source: 'owner' }, ctx(root));
      await expect(ownerWithoutRef).rejects.toThrow('source owner needs a decision or owner-queue item id');
    });
  });

  it('accepts an outcome the plan holds', async () => {
    await withTempActiveRoot(async (root) => {
      const outcome = { initiative: SLUG, slug: 'faster-landing', statement: 'Landing is quick', measure: 'p50 minutes' };
      await planOutcomeAdd.run(outcome, ctx(root));

      const task = asTask(await taskAdd.run({ slug: SLUG, title: 'Serve', serves: `${SLUG}/faster-landing` }, ctx(root)));

      expect(task.serves).toBe(`${SLUG}/faster-landing`);
    });
  });
});

describe('task edit guards relabels after dispatch', () => {
  it('sets class before dispatch and marks it filed', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Relabel', class: 'upkeep' }, ctx(root)));

      const edited = asTask(await taskEdit.run({ slug: SLUG, id: added.id, class: 'product' }, ctx(root)));

      expect(edited.class).toBe('product');
      expect(edited.field_origin).toEqual({ class: 'filed' });
    });
  });

  it('class edit after dispatch is refused from the CLI', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Started', class: 'upkeep' }, ctx(root)));
      await startOnDisk(root, added.id);

      const edit = taskEdit.run({ slug: SLUG, id: added.id, class: 'product' }, ctx(root));

      await expect(edit).rejects.toThrow(UsageError);
      await expect(edit).rejects.toThrow('after dispatch only the owner relabels');
    });
  });

  it('refuses source and serves once a spawn names the task, but still takes blocked_on', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Spawned' }, ctx(root)));
      agentChatHomeWithSpawn(`${SLUG}/${added.id}`);

      const source = taskEdit.run({ slug: SLUG, id: added.id, source: 'sweep' }, ctx(root));
      await expect(source).rejects.toThrow('Refusing to change source');
      const serves = taskEdit.run({ slug: SLUG, id: added.id, serves: 'none' }, ctx(root));
      await expect(serves).rejects.toThrow('Refusing to change serves');

      const blocked = asTask(await taskEdit.run({ slug: SLUG, id: added.id, blocked_on: 'owner' }, ctx(root)));
      expect(blocked.blocked_on).toBe('owner');
    });
  });

  it('treats an unreadable spawn store as dispatched', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Unknown' }, ctx(root)));
      const home = mkdtempSync(path.join(os.tmpdir(), 'aw-s8-chat-'));
      tempDirs.push(home);
      writeFileSync(path.join(home, 'events.db'), 'not a database');
      vi.stubEnv('AGENT_CHAT_HOME', home);

      const edit = taskEdit.run({ slug: SLUG, id: added.id, class: 'product' }, ctx(root));

      await expect(edit).rejects.toThrow('Refusing to change class');
    });
  });
});

describe('task done records why it closed', () => {
  it('done records done_reason as filed', async () => {
    await withTempActiveRoot(async (root) => {
      const added = asTask(await taskAdd.run({ slug: SLUG, title: 'Close it' }, ctx(root)));

      const done = asTask(await taskDone.run({ slug: SLUG, id: added.id, reason: 'superseded' }, ctx(root)));

      expect(done.status).toBe('done');
      expect(done.done_reason).toBe('superseded');
      expect(done.field_origin).toEqual({ done_reason: 'filed' });
    });
  });

  it('refuses a reason outside the closed set', () => {
    const parsed = taskDone.args.safeParse({ slug: SLUG, id: 'SI-1', reason: 'finished' });

    expect(parsed.success).toBe(false);
  });
});
