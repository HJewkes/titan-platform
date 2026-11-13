import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { NotFoundError, UsageError, ValidationError } from '../errors.js';
import { registry, type CommandContext } from '../registry/index.js';
import './index.js';
import { listTools } from '../server/mcp.js';
import { runCliInProcess } from '../test-support/cli-runner.js';
import { parseJson } from '../test-support/parse-json.js';
import { withTempActiveRoot, writeAgentVisibleBrief } from '../test-support/test-helpers.js';
import { readPlanRecord, writePlanRecord } from '@titan-design/pm/node';
import { planFreezeAdd, planOutcomeAdd, planOutOfScopeAdd } from './plan-add.js';
import { planBetAdd, planBetList } from './plan-bet.js';
import { planBetShow, planFreezeShow, planOutcomeList, planOutcomeShow, planOutOfScopeShow } from './plan-read.js';

const ctx = (activeRoot: string): CommandContext => ({ activeRoot, warnings: [], format: 'json' });

const intent = { intent_ref: 'D12', quote_ref: 'msg:abc123' };

const outcomeArgs = { initiative: 'alpha', slug: 'faster-landing', statement: 'Landing is quick', measure: 'p50 minutes' };

const betArgs = {
  initiative: 'alpha',
  week: '2026-W47',
  outcome: 'alpha/faster-landing',
  task: ['alpha/AL-1'],
  metric: 'p50 minutes',
  direction: 'decrease' as const,
  baseline: 40,
  expected: 25,
  read_by: '2026-11-30',
};

/** An agent-visible `alpha` with its outcome in place, so bets can be proposed against it. */
async function seedAlpha(root: string): Promise<void> {
  writeAgentVisibleBrief(root, 'alpha');
  await planOutcomeAdd.run(outcomeArgs, ctx(root));
}

/** Writes a bet file directly, the way only a fixture can set a state other than proposed. */
async function writeBetFile(root: string, n: number, week: string, state: string, initiative = 'alpha'): Promise<void> {
  const dir = path.join(root, initiative, 'plan', 'bets');
  await fs.mkdir(dir, { recursive: true });
  const bet = { ...betArgs, initiative, outcome: `${initiative}/faster-landing`, id: `${initiative}/B${n}`, week, order: n };
  const { task, metric, direction, baseline, expected, read_by, ...rest } = bet;
  const record = { ...rest, tasks: task, prediction: { metric, direction, baseline, expected, read_by }, state };
  await fs.writeFile(path.join(dir, `B${n}.yml`), YAML.stringify(record));
}

describe('plan verbs round-trip', () => {
  it('outcome add writes one file the show and list read back, as a draft', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);

      const shown = await planOutcomeShow.run({ id: 'alpha/faster-landing' }, ctx(root));
      const listed = await planOutcomeList.run({ initiative: 'alpha' }, ctx(root));

      expect(shown).toMatchObject({ id: 'alpha/faster-landing', state: 'draft', measure: 'p50 minutes' });
      expect(listed).toEqual([shown]);
      await expect(fs.access(path.join(root, 'alpha/plan/outcomes/faster-landing.yml'))).resolves.toBeUndefined();
    });
  });

  it('bet add writes a proposed bet with the next id and order, and show reads it back', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);

      const first = await planBetAdd.run(betArgs, ctx(root));
      const second = await planBetAdd.run({ ...betArgs, task: undefined, selector: 'tag:landing' }, ctx(root));

      expect([first.id, first.order, first.state]).toEqual(['alpha/B1', 1, 'proposed']);
      expect([second.id, second.order]).toEqual(['alpha/B2', 2]);
      expect(await planBetShow.run({ id: 'alpha/B2' }, ctx(root))).toEqual(second);
      await expect(fs.access(path.join(root, 'alpha/plan/bets/B2.yml'))).resolves.toBeUndefined();
    });
  });

  it('freeze and out-of-scope add write numbered records that show reads back', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      const freezeArgs = { initiative: 'alpha', tag: 'console', reason: 'Settling', ...intent };

      const freeze = await planFreezeAdd.run({ ...freezeArgs, ends: 'measure:p50 minutes:decrease:20' }, ctx(root));
      const dated = await planFreezeAdd.run({ ...freezeArgs, ends: 'date:2026-12-01' }, ctx(root));
      const ruled = await planOutOfScopeAdd.run({ initiative: 'alpha', statement: 'No mobile app', date: '2026-11-12', ...intent }, ctx(root));

      expect(freeze.end_condition).toEqual({ kind: 'measure', metric: 'p50 minutes', direction: 'decrease', threshold: 20 });
      expect([freeze.id, dated.id, ruled.id]).toEqual(['alpha/F1', 'alpha/F2', 'alpha/X1']);
      expect(await planFreezeShow.run({ id: 'alpha/F2' }, ctx(root))).toEqual(dated);
      expect(await planOutOfScopeShow.run({ id: 'alpha/X1' }, ctx(root))).toEqual(ruled);
    });
  });

  it('refuses a freeze end condition in no known form, and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      const args = { initiative: 'alpha', tag: 'console', reason: 'Settling', ...intent };

      await expect(planFreezeAdd.run({ ...args, ends: 'soon' }, ctx(root))).rejects.toBeInstanceOf(UsageError);
      await expect(planFreezeAdd.run({ ...args, ends: 'date:later' }, ctx(root))).rejects.toBeInstanceOf(ValidationError);
      await expect(fs.readdir(path.join(root, 'alpha/plan/freezes'))).rejects.toThrow();
    });
  });

  it('show of an id with no record is not found', async () => {
    await withTempActiveRoot(async (root) => {
      await expect(planBetShow.run({ id: 'alpha/B9' }, ctx(root))).rejects.toBeInstanceOf(NotFoundError);
      await expect(planBetShow.run({ id: '../escape' }, ctx(root))).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});

describe('plan outcome add', () => {
  it('refuses when an outcome already exists for that slug, and leaves it unchanged', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);

      const again = planOutcomeAdd.run({ ...outcomeArgs, statement: 'Something else' }, ctx(root));

      await expect(again).rejects.toThrow(/Outcome already exists: alpha\/faster-landing/);
      const kept = await planOutcomeShow.run({ id: 'alpha/faster-landing' }, ctx(root));
      expect(kept.statement).toBe('Landing is quick');
    });
  });

  it('refuses a bet whose outcome is not in the plan', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');

      await expect(planBetAdd.run(betArgs, ctx(root))).rejects.toThrow('Unknown outcome id: alpha/faster-landing');
    });
  });
});

describe('plan bet list', () => {
  it('plan bet list --initiative <slug> --week <week> returns only selected bets for that week', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);
      await writeBetFile(root, 1, '2026-W47', 'selected');
      await writeBetFile(root, 2, '2026-W47', 'proposed');
      await writeBetFile(root, 3, '2026-W48', 'selected');
      await writeBetFile(root, 4, '2026-W47', 'selected');
      const env = { ACTIVE_ROOT: root };

      const res = await runCliInProcess(['--json', 'plan', 'bet', 'list', '--initiative', 'alpha', '--week', '2026-W47'], env);

      expect(res.status).toBe(0);
      const ids = parseJson(res.stdout, z.object({ data: z.array(z.object({ id: z.string() })) })).data.map((b) => b.id);
      expect(ids).toEqual(['alpha/B1', 'alpha/B4']);
    });
  });

  it('lists across initiatives without an owner-only one, which is still readable by name', async () => {
    await withTempActiveRoot(async (root) => {
      await writeBetFile(root, 1, '2026-W47', 'selected', 'alpha');
      writeAgentVisibleBrief(root, 'alpha');
      await writeBetFile(root, 1, '2026-W47', 'selected', 'private-notes');

      const across = await planBetList.run({ state: 'selected' }, ctx(root));
      const named = await planBetList.run({ state: 'selected', initiative: 'private-notes' }, ctx(root));

      expect(across.map((bet) => bet.id)).toEqual(['alpha/B1']);
      expect(named.map((bet) => bet.id)).toEqual(['private-notes/B1']);
    });
  });
});

describe('owner actions', () => {
  it('no CLI or RPC path selects a bet or edits an outcome', async () => {
    const names = registry.list().map((cmd) => cmd.name);
    const tools = listTools().map((tool) => tool.name);

    const planVerbs = names.filter((name) => name.startsWith('plan.'));
    expect(planVerbs.every((name) => /\.(add|show|list)$/.test(name))).toBe(true);
    expect(names).not.toContain('plan.bet.select');
    expect(tools.filter((tool) => /select|plan__outcome__edit/.test(tool))).toEqual([]);
    const cli = await runCliInProcess(['plan', 'bet', 'select', 'alpha/B1']);
    expect(cli.status).not.toBe(0);
  });

  // The console's owner ops (TP-5453 P3b) are the only writers of these fields; no surface here may take them.
  it('no CLI, RPC or MCP verb takes a bet state, an outcome edit or a freeze end', () => {
    const writers = registry.list().filter((cmd) => cmd.name.startsWith('plan.') && !/\.(show|list)$/.test(cmd.name));
    const tools = listTools().map((tool) => tool.name);

    const fields = writers.flatMap((cmd) => (cmd.args instanceof z.ZodObject ? Object.keys(cmd.args.shape) : []));
    expect(writers.map((cmd) => cmd.name).sort()).toEqual(['plan.bet.add', 'plan.freeze.add', 'plan.out-of-scope.add', 'plan.outcome.add']);
    expect(fields).not.toContain('state');
    expect(fields).not.toContain('ended_on');
    expect(tools.filter((tool) => tool.includes('plan__') && /select|edit|freeze__(set|end)/.test(tool))).toEqual([]);
  });

  it('plan freeze add --set-by owner is refused from the CLI and writes nothing', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      const argv = ['--json', 'plan', 'freeze', 'add', 'alpha', '--tag', 'console', '--reason', 'Settling', '--ends', 'owner', '--set-by', 'owner', '--intent-ref', 'D12', '--quote-ref', 'msg:abc123'];

      const res = await runCliInProcess(argv, { ACTIVE_ROOT: root });

      expect(res.status).not.toBe(0);
      expect(`${res.stdout}${res.stderr}`).toMatch(/set_by owner is refused here/);
      await expect(fs.readdir(path.join(root, 'alpha/plan/freezes'))).rejects.toThrow();
    });
  });

  it('plan.freeze.add over RPC refuses set_by owner, and records decider when none is claimed', async () => {
    await withTempActiveRoot(async (root) => {
      writeAgentVisibleBrief(root, 'alpha');
      const args = { initiative: 'alpha', tag: 'console', reason: 'Settling', ends: 'owner', ...intent };

      await expect(planFreezeAdd.run({ ...args, set_by: 'owner' }, ctx(root))).rejects.toBeInstanceOf(ValidationError);
      const freeze = await planFreezeAdd.run(args, ctx(root));

      expect(freeze).toMatchObject({ id: 'alpha/F1', set_by: 'decider' });
    });
  });

  it('a bet the owner-op path selects through the shared plan store is what plan bet list --week returns', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);
      const proposed = await planBetAdd.run(betArgs, ctx(root));
      await writePlanRecord(root, 'bet', { ...proposed, state: 'selected' });

      const res = await runCliInProcess(['--json', 'plan', 'bet', 'list', '--initiative', 'alpha', '--week', '2026-W47'], { ACTIVE_ROOT: root });

      expect(parseJson(res.stdout, z.object({ data: z.array(z.object({ id: z.string(), state: z.string() })) })).data).toEqual([{ ...proposed, state: 'selected' }].map(({ id, state }) => ({ id, state })));
      expect(await readPlanRecord(root, 'bet', proposed.id)).toMatchObject({ state: 'selected' });
    });
  });

  it('bet add ignores a state passed by the caller and writes proposed', async () => {
    await withTempActiveRoot(async (root) => {
      await seedAlpha(root);

      const bet = await planBetAdd.run({ ...betArgs, state: 'selected' } as typeof betArgs, ctx(root));

      expect(bet.state).toBe('proposed');
    });
  });
});
