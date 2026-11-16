import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../errors.js';
import { coerceDates } from '../utils/coerce-dates.js';
import { atomicWrite } from '../utils/fs-atomic.js';
import { parseFrontmatter } from '../utils/gray-matter-io.js';
import { readYaml, writeYaml } from '../utils/yaml-io.js';

/*
 * Sheets sit at <aw>/<initiative>/plan/sheets/<week>.md. The answer to a sheet sits beside it as <week>.decisions.yml,
 * so an unanswered sheet is one with no decisions file.
 */

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'must be YYYY-MM-DD' });
const DefaultSchema = z.object({ bet: z.string(), action: z.enum(['select', 'hold', 'stop']) });

const SheetFrontSchema = z.object({
  schema: z.literal('titan-weekly-sheet/v1'),
  initiative: z.string(),
  week: z.string(),
  next_week: z.string(),
  deadline: isoDay,
  defaults: z.array(DefaultSchema),
  flags: z.array(z.object({ bet: z.string(), problem: z.string() })),
});

export type SheetFront = z.infer<typeof SheetFrontSchema>;

export const SheetDecisionsSchema = z.object({
  initiative: z.string(),
  week: z.string(),
  /** The sheet passed its deadline unanswered, so its defaults stand as the decisions. */
  decided_by: z.literal('default'),
  decided_on: isoDay,
  decisions: z.array(DefaultSchema),
});

export type SheetDecisions = z.infer<typeof SheetDecisionsSchema>;

function sheetsDir(activeRoot: string, initiative: string): string {
  return path.join(activeRoot, initiative, 'plan', 'sheets');
}

export function sheetPath(activeRoot: string, initiative: string, week: string): string {
  return path.join(sheetsDir(activeRoot, initiative), `${week}.md`);
}

function decisionsPath(activeRoot: string, initiative: string, week: string): string {
  return path.join(sheetsDir(activeRoot, initiative), `${week}.decisions.yml`);
}

function isMissing(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

export async function writeSheet(activeRoot: string, initiative: string, week: string, markdown: string): Promise<string> {
  const file = sheetPath(activeRoot, initiative, week);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await atomicWrite(file, markdown);
  return file;
}

/** The newest week with a sheet, or null when the initiative has none. */
export async function latestSheetWeek(activeRoot: string, initiative: string): Promise<string | null> {
  const names = await fs.readdir(sheetsDir(activeRoot, initiative)).catch((err: unknown) => {
    if (isMissing(err)) return [];
    throw err;
  });
  const weeks = names.filter((name) => /^\d{4}-W\d{2}\.md$/.test(name)).map((name) => name.slice(0, -3));
  return weeks.sort().at(-1) ?? null;
}

/** The sheet's markdown and parsed front matter, or null when no sheet exists for the week. */
export async function readSheet(activeRoot: string, initiative: string, week: string): Promise<{ markdown: string; front: SheetFront } | null> {
  let markdown: string;
  try {
    markdown = await fs.readFile(sheetPath(activeRoot, initiative, week), 'utf8');
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const front = SheetFrontSchema.safeParse(coerceDates(parseFrontmatter(markdown).data));
  if (!front.success) throw new ValidationError(`Invalid weekly sheet ${initiative} ${week}: ${front.error.message}`);
  return { markdown, front: front.data };
}

export async function readSheetDecisions(activeRoot: string, initiative: string, week: string): Promise<SheetDecisions | null> {
  try {
    return await readYaml(decisionsPath(activeRoot, initiative, week), SheetDecisionsSchema);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

export async function writeSheetDecisions(activeRoot: string, decisions: SheetDecisions): Promise<void> {
  await writeYaml(decisionsPath(activeRoot, decisions.initiative, decisions.week), decisions, SheetDecisionsSchema);
}
