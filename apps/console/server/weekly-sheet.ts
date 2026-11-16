import { z } from "zod";
import { EXIT } from "@titan-design/registry";
import { failure, type ActiveWork } from "./active-work.js";
import { readCommand } from "./owner-guard.js";
import { keepsSlug, type WorkOptions } from "./work.js";

const sheet = z.object({
  week: z.string(),
  nextWeek: z.string(),
  deadline: z.string(),
  markdown: z.string(),
  flags: z.array(z.object({ bet: z.string(), problem: z.string() })),
  /** Null while the sheet is unanswered; once its deadline passes, `plan sheet apply-defaults` records the defaults here. */
  decidedOn: z.string().nullable(),
});

const weeklySheetResult = z.object({ slug: z.string(), sheet: sheet.nullable() });

function hasCode(error: unknown, code: number): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

/** An initiative's newest weekly sheet (TP-5453 P16), or null when it has none yet. Read only: showing a sheet decides nothing. */
export async function readWeeklySheet(activeWork: ActiveWork, slug: string, options: WorkOptions = {}): Promise<z.infer<typeof weeklySheetResult>> {
  if (!(await keepsSlug(activeWork, options))(slug)) throw failure(`No initiative ${slug}`, EXIT.NOINPUT);
  try {
    const answer = await activeWork.read("plan.sheet.show", { initiative: slug });
    const { week, next_week: nextWeek, deadline, markdown, flags, decisions } = answer;
    return { slug, sheet: { week, nextWeek, deadline, markdown, flags, decidedOn: decisions?.decided_on ?? null } };
  } catch (error) {
    if (hasCode(error, EXIT.NOINPUT)) return { slug, sheet: null };
    throw error;
  }
}

export function weeklySheetCommands(activeWork: ActiveWork, options: WorkOptions = {}) {
  return {
    "work.sheet": readCommand({
      name: "work.sheet",
      description: "An initiative's newest weekly sheet: statement, moved, not moved, proposed bets and stops, with its flags",
      args: z.object({ slug: z.string().min(1) }),
      result: weeklySheetResult,
      run: ({ slug }) => readWeeklySheet(activeWork, slug, options),
    }),
  };
}
