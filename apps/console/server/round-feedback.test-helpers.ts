import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoundsSource } from "./rounds.js";

// Synthetic: the shape `titan-factory shepherd visual-week-feedback` files (TP-5409), two merged PRs of one week.
const REPO = "example-org/example-design";
export const FEEDBACK_ROUND_ID = "vf-example-design-0a1b2c-2026-W45-r1";

interface MergedFixture {
  pr: number;
  merge: string;
  head: string;
  paths: string[];
  tier?: string;
  task?: string;
}

const MERGED: readonly MergedFixture[] = [
  { pr: 41, merge: "1".repeat(40), head: "a".repeat(40), paths: ["src/button/button.css", "src/button/button.stories.tsx"], tier: "T2", task: "EX-101" },
  { pr: 44, merge: "2".repeat(40), head: "b".repeat(40), paths: ["src/tokens/color.json", "src/card/card.css", "src/card/card-header.css"] },
];

function sectionOf({ pr, merge, head, paths, tier, task }: MergedFixture) {
  const tierText = tier === undefined ? "" : ` Measured visual tier ${tier}, a label only.`;
  const taskText = task === undefined ? "" : ` Task ${task}.`;
  return {
    id: `pr-${pr}`,
    title: `${REPO}#${pr}`,
    deciding: "Nothing to decide: this already merged.",
    changed: `${paths.length} visual path(s) changed: ${paths.join(", ")}.`,
    context: `Merged 2026-11-04 as ${merge.slice(0, 12)} from head ${head.slice(0, 12)}.${tierText}${taskText}`,
    questionIds: [`notes-pr-${pr}`],
  };
}

/** The round.json a weekly sheet carries, every value synthetic. */
function feedbackManifest(): Record<string, unknown> {
  return {
    schema: "titan-review/round@2",
    kind: "feedback",
    unit: "vf-example-design-0a1b2c-2026-W45",
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    context: `Visual feedback for ${REPO}, ISO week 2026-W45: 2 merged PR(s) with visual changes. Nothing here blocks or undoes a merge.`,
    widths: [1280],
    variants: [],
    recommendations: "after-answer",
    sections: MERGED.map(sectionOf),
    questions: MERGED.map(({ pr }) => ({ id: `notes-pr-${pr}`, kind: "text", prompt: `Notes or ideas for a later iteration of ${REPO}#${pr} (optional)` })),
    prGroups: MERGED.map(({ pr, head, paths, task }) => ({ pr: `${REPO}#${pr}`, headSha: head, sectionIds: [`pr-${pr}`], ...(task !== undefined && { task: { id: task } }), files: paths.map((file) => ({ path: file })) })),
  };
}

/** A rounds dir holding only the sheet, removed by the returned `remove`. */
export async function stagedFeedbackRound(): Promise<{ source: RoundsSource; remove: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "console-feedback-sheet-"));
  await mkdir(path.join(dir, FEEDBACK_ROUND_ID));
  await writeFile(path.join(dir, FEEDBACK_ROUND_ID, "round.json"), JSON.stringify(feedbackManifest()));
  return { source: { dir }, remove: () => rm(dir, { recursive: true, force: true }) };
}
