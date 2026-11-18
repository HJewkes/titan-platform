import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { roundQueueItems } from "./approval-items.js";
import { FEEDBACK_ROUND_ID, stagedFeedbackRound } from "./round-feedback.test-helpers.js";
import { roundNudges } from "./round-nudge.js";
import { getRound, listRounds, readQueueRounds, type RoundsSource } from "./rounds.js";
import { submitPipeline } from "./rounds-submit.js";

const WEEK_LATER = Date.parse("2099-01-01T00:00:00.000Z");

let source: RoundsSource;
let remove: () => Promise<void>;

beforeEach(async () => {
  ({ source, remove } = await stagedFeedbackRound());
});

afterEach(async () => {
  await remove();
});

async function shownSha(): Promise<string> {
  const shown = await getRound(source, FEEDBACK_ROUND_ID);
  if (!shown.valid) throw new Error(shown.reason);
  return shown.manifestSha256;
}

describe("an open post-merge feedback sheet (TP-5458)", () => {
  it("is listed as feedback, neither a Ship nor a design round", async () => {
    const { rounds } = await listRounds(source);

    expect(rounds).toEqual([expect.objectContaining({ id: FEEDBACK_ROUND_ID, status: "open", feedback: true, ship: false, design: false })]);
  });

  it("asks the inbox nothing, however long it stays open", async () => {
    const { rounds } = await readQueueRounds(source);

    const nudges = await roundNudges(source.dir, rounds, WEEK_LATER);
    const items = roundQueueItems(rounds);

    expect(nudges).toEqual([]);
    expect(items.open).toEqual([]);
  });

  it("counts a submit with every notes box blank as answered", async () => {
    const result = await submitPipeline(source)({ id: FEEDBACK_ROUND_ID, manifestSha256: await shownSha(), general: "", answers: [] });
    const after = await getRound(source, FEEDBACK_ROUND_ID);

    expect(result.status).toBe("submitted");
    expect(after.status).toBe("sent");
  });
});
