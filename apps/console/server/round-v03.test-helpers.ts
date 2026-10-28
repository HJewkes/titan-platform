import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const BACKLOG_REPO = "acme/widgets";
export const BACKLOG_PRS = [11, 12] as const;
export const pinnedHead = (pr: number): string => String(pr % 10).repeat(40);

const shipQuestion = (pr: number) => ({
  id: `ship-${pr}`,
  kind: "pick-one",
  prompt: `SHIP: Ship ${BACKLOG_REPO}#${pr}?`,
  options: ["Ship", "Don't ship"],
  required: true,
  page: `${BACKLOG_REPO}#${pr}`,
  decision: "ship",
  signsOff: `the change of ${BACKLOG_REPO}#${pr}`,
  topics: [`ask:${BACKLOG_REPO}#${pr}/ship`],
  recommendation: { answer: "Ship", rationale: "Green at this head.", confidence: 0.8, by: "fixture-agent", weakPoint: "No frame shows the hover state." },
  merge: { repo: BACKLOG_REPO, pr, headSha: pinnedHead(pr), ship: ["Ship"] },
});

const shipSection = (pr: number) => ({
  id: `ship-${pr}`,
  title: `Ship ${BACKLOG_REPO}#${pr}`,
  deciding: "Whether this PR merges at this head.",
  changed: "One component changed.",
  context: "Built from a synthetic backlog.",
  kind: "STATES",
  questionIds: [`ship-${pr}`],
  variantKeys: [`frame-${pr}`],
});

/**
 * A synthetic backlog Ship round in review-schema 0.3 only (`decision`, `topics`, `weakPoint`, `variantUnit`, `prGroups`):
 * one merge-bound question per PR, each pinned to `pinnedHead(pr)`, so 0.1 refuses it and the vendored reader accepts it.
 */
export function backlogRound(): Record<string, unknown> {
  return {
    schema: "titan-review/round@2",
    unit: "backlog-ship",
    round: 2,
    storybookUrl: "http://127.0.0.1:6006",
    widths: [1280],
    recommendations: "after-answer",
    variants: BACKLOG_PRS.map((pr) => ({ key: `frame-${pr}`, storyId: `widgets-card--pr-${pr}`, label: `Card in #${pr}`, variantUnit: `card-${pr}` })),
    sections: BACKLOG_PRS.map(shipSection),
    questions: BACKLOG_PRS.map(shipQuestion),
    prGroups: BACKLOG_PRS.map((pr) => ({ pr: `${BACKLOG_REPO}#${pr}`, headSha: pinnedHead(pr), sectionIds: [`ship-${pr}`] })),
  };
}

/** A temp rounds dir holding `round` as `<id>/round.json`; the caller removes `dir` when done. */
export async function roundsDirWith(id: string, round: Record<string, unknown>): Promise<{ dir: string; remove: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "console-rounds-03-"));
  await mkdir(path.join(dir, id));
  await writeFile(path.join(dir, id, "round.json"), JSON.stringify(round));
  return { dir, remove: () => rm(dir, { recursive: true, force: true }) };
}
