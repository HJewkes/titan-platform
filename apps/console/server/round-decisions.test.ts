import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { roundItemId } from "@titan-design/owner-queue";
import { roundDecisions } from "./round-decisions.js";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { parseManifest } from "./rounds.js";

const ROUND = "td920-packet-r1";
const OPENED_AT = "2026-10-01T00:00:00.000Z";
const SUBMITTED_AT = "2026-10-02T00:00:00.000Z";

async function strictManifest() {
  const parsed = parseManifest(await readFile(path.join(FIXTURE_ROUNDS.dir, ROUND, "round.json")));
  if (!parsed.ok) throw new Error(`the ${ROUND} fixture is not a valid round: ${parsed.reason}`);
  return parsed.manifest;
}

describe("roundDecisions", () => {
  it("reads prompt, options and recommendation off a strict manifest, and approves a merge-bound Ship", async () => {
    const answers = [
      { questionId: "bundle", pick: "Accept" },
      { questionId: "ship", pick: "Ship" },
    ];

    const decisions = roundDecisions({ roundId: ROUND, manifest: await strictManifest(), answers, openedAt: OPENED_AT, submittedAt: SUBMITTED_AT });

    expect(decisions.map(({ questionId, item, answer }) => ({ questionId, item, answer }))).toEqual([
      {
        questionId: "bundle",
        item: expect.objectContaining({
          id: roundItemId(ROUND, "bundle"),
          kind: "decide",
          summary: "ITERATION: Accept the bundle growth?",
          options: [
            { id: "Accept", label: "Accept" },
            { id: "Shrink first", label: "Shrink first" },
          ],
          recommended: { optionId: "Accept", by: "fixture-agent" },
          openedAt: OPENED_AT,
        }),
        answer: expect.objectContaining({ optionId: "Accept", at: SUBMITTED_AT }),
      },
      {
        questionId: "ship",
        item: expect.objectContaining({ kind: "approve", summary: "SHIP: Ship acme/widgets#42 at a1a1a1a1a1a1?" }),
        answer: expect.objectContaining({ optionId: "Ship" }),
      },
    ]);
  });
});
