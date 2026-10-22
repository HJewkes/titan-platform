import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { RoundSchema } from "./review-schema-0.3/schema.js";
import { hasUnboundMergeOffer, mergeBindingProblems } from "./round-merge-binding.js";

const jsonObject = z.record(z.string(), z.unknown());
const jsonObjects = z.array(jsonObject);
type Json = z.infer<typeof jsonObject>;

const td920 = (): Json => jsonObject.parse(JSON.parse(readFileSync(path.join(FIXTURE_ROUNDS.dir, "td920-packet-r1", "round.json"), "utf8")));

/** td920 with one question's fields replaced, read by the vendored schema so only the binding check is under test. */
function questionsWith(id: string, fields: Json) {
  const round = td920();
  const questions = jsonObjects.parse(round.questions).map((question) => (question.id === id ? { ...question, ...fields } : question));
  return RoundSchema.parse({ ...round, questions }).questions;
}

describe("a merge offer's binding", () => {
  it("is a problem when a pick-one offers \"Merge #N\" with no merge binding", () => {
    const questions = questionsWith("bundle", { options: ["Accept", "Merge #42 at this head"] });

    expect(mergeBindingProblems(questions)).toEqual([
      'question bundle: option "Merge #42 at this head" offers a merge, so it needs a merge binding {repo, pr, headSha, ship}',
    ]);
    expect(hasUnboundMergeOffer(questions)).toBe(true);
  });

  it("is a problem when a signsOff names a PR at a head with no merge binding", () => {
    const questions = questionsWith("bundle", { signsOff: "the bundle growth of #42 at a1a1a1a" });

    expect(mergeBindingProblems(questions)).toEqual([
      'question bundle: signsOff "#42 at a1a1a1a" offers a merge, so it needs a merge binding {repo, pr, headSha, ship}',
    ]);
  });

  it("is a problem when the binding is at a head other than the one its signsOff names", () => {
    const questions = questionsWith("ship", { signsOff: "the 3 baseline changes of #42 at b2b2b2b" });

    expect(mergeBindingProblems(questions)).toEqual([
      `question ship: signsOff "#42 at b2b2b2b" names head b2b2b2b but its merge binding is at ${"a1".repeat(20)}`,
    ]);
    expect(hasUnboundMergeOffer(questions)).toBe(false);
  });

  it("is a problem when the binding is for a PR other than the one its signsOff names", () => {
    const questions = questionsWith("ship", { signsOff: "the 3 baseline changes of #43 at a1a1a1a" });

    expect(mergeBindingProblems(questions)).toEqual(['question ship: signsOff "#43 at a1a1a1a" names #43 but its merge binding is #42']);
  });

  it("is no problem when the binding's pr and head agree with its signsOff", () => {
    const questions = questionsWith("ship", { signsOff: "the 3 baseline changes of #42 at a1a1a1a" });

    expect(mergeBindingProblems(questions)).toEqual([]);
    expect(hasUnboundMergeOffer(questions)).toBe(false);
  });
});
