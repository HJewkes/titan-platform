import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileRound } from "./round-file.js";
import { FEEDBACK_MERGE_REFUSED, RoundSchema } from "./round-schema.js";

// Synthetic: the shape `titan-factory shepherd visual-week-feedback` builds (TP-5409).
const REPO = "example-org/example-design";
const HEAD = "a".repeat(40);
const ASKER = { seat: "shepherd", initiative: null };

function feedbackRound(): Record<string, unknown> {
  return {
    schema: "titan-review/round@2",
    kind: "feedback",
    unit: "vf-example-design-0a1b2c-2026-W45",
    round: 1,
    storybookUrl: "http://127.0.0.1:6006",
    context: `Visual feedback for ${REPO}, ISO week 2026-W45: 1 merged PR(s) with visual changes.`,
    widths: [1280],
    variants: [],
    recommendations: "after-answer",
    sections: [{ id: "pr-7", title: `${REPO}#7`, deciding: "Nothing to decide: this already merged.", changed: "1 visual path(s) changed: src/button.css.", context: "Merged 2026-11-04.", questionIds: ["notes-pr-7"] }],
    questions: [{ id: "notes-pr-7", kind: "text", prompt: `Notes or ideas for a later iteration of ${REPO}#7 (optional)` }],
    prGroups: [{ pr: `${REPO}#7`, headSha: HEAD, sectionIds: ["pr-7"], files: [{ path: "src/button.css" }] }],
  };
}

function withShip(round: Record<string, unknown>): Record<string, unknown> {
  const ship = { id: "ship-7", kind: "pick-one", prompt: `Ship ${REPO}#7 at ${HEAD.slice(0, 12)}?`, options: ["Ship", "Don't ship"], required: true, signsOff: "button", page: `${REPO}#7`, merge: { repo: REPO, pr: 7, headSha: HEAD, ship: ["Ship"] } };
  const [section] = round.sections as { questionIds: string[] }[];
  return { ...round, questions: [...(round.questions as unknown[]), ship], sections: [{ ...section, parts: [{ id: "button", label: "Button", current: "a", proposed: "b" }], questionIds: [...section!.questionIds, "ship-7"] }] };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "console-round-feedback-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("a feedback round", () => {
  it("parses with its kind kept on the manifest", () => {
    const parsed = RoundSchema.safeParse(feedbackRound());

    expect(parsed.success).toBe(true);
    expect(parsed.data?.kind).toBe("feedback");
  });

  it("is refused when a question binds a merge", () => {
    const parsed = RoundSchema.safeParse(withShip(feedbackRound()));

    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([`question ship-7: ${FEEDBACK_MERGE_REFUSED}`]);
  });

  it("refuses a round kind the console does not know", () => {
    expect(RoundSchema.safeParse({ ...feedbackRound(), kind: "gate" }).success).toBe(false);
  });

  it("files through decisions file, and filing the same bytes again creates nothing", async () => {
    const body = JSON.stringify(feedbackRound());
    const roundsDir = path.join(root, "rounds");

    const first = await fileRound({ body, roundsDir, asker: ASKER });
    const again = await fileRound({ body, roundsDir, asker: ASKER });

    expect(first).toMatchObject({ id: "vf-example-design-0a1b2c-2026-W45-r1", created: true });
    expect(again).toMatchObject({ id: first.id, created: false });
  });
});
