import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { RoundSchema as NpmRoundSchema } from "@titan-design/review-schema";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";
import { RoundSchema as VendoredRoundSchema } from "./review-schema-0.3/schema.js";
import { BLIND_AB_REFUSED, RoundSchema } from "./round-schema.js";

const jsonObject = z.record(z.string(), z.unknown());
const jsonObjects = z.array(jsonObject);
type Json = z.infer<typeof jsonObject>;

const fixture = (id: string): Json => jsonObject.parse(JSON.parse(readFileSync(path.join(FIXTURE_ROUNDS.dir, id, "round.json"), "utf8")));
const td920 = (): Json => fixture("td920-packet-r1");

function issuesOf(json: unknown): string[] {
  const result = RoundSchema.safeParse(json);
  if (result.success) throw new Error("expected the round to be refused");
  return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
}

function blindAbRound(): Json {
  const round = td920();
  const takes = [
    { engine: "engine-alpha", src: "audio/line-1-a.wav" },
    { engine: "engine-beta", src: "audio/line-1-b.wav" },
  ];
  const listen = { id: "listen", kind: "blind-ab", prompt: "Which take reads the line better?", pairs: [{ id: "line-1", transcript: "Welcome back.", takes }] };
  const questions = jsonObjects.parse(round.questions);
  const sections = jsonObjects.parse(round.sections);
  return {
    ...round,
    questions: [...questions, listen],
    sections: sections.map((section) => (section.id === "side" ? { ...section, questionIds: ["bundle", "listen"] } : section)),
  };
}

describe("the console's round schema", () => {
  it("accepts a round@2 CI packet round that only review-schema 0.3 knows", () => {
    const result = RoundSchema.safeParse(td920());

    expect(result.success).toBe(true);
    expect(result.data?.variants[0]).toMatchObject({ baseImage: "before/img-001.png", change: "changed" });
  });

  it.each(["kiln-schedule-r1", "kiln-schedule-r2", "lantern-cards-r1", "orbit-retry-r1", "ship-tile-r1"])(
    "reads the 0.1 round %s to the same manifest as review-schema 0.1 does",
    (id) => {
      expect(RoundSchema.parse(fixture(id))).toEqual(NpmRoundSchema.parse(fixture(id)));
    },
  );

  it("refuses a variant key the schema does not know, naming it", () => {
    const round = td920();
    const [first, ...rest] = jsonObjects.parse(round.variants);

    expect(issuesOf({ ...round, variants: [{ ...first, foo: 1 }, ...rest] }).join("\n")).toContain('"foo"');
  });

  it("refuses a merge-bound Ship question that is not a ship decision", () => {
    const round = td920();
    const questions = jsonObjects.parse(round.questions).map((question) => (question.id === "ship" ? { ...question, decision: "iterate" } : question));

    expect(issuesOf({ ...round, questions })).toContain("questions: question ship: a merge-bound question's decision is ship, not iterate");
  });

  it("refuses a round@1 manifest with the review contract's own reason", () => {
    expect(issuesOf(fixture("legacy-r1"))[0]).toMatch(/^schema: titan-review\/round@1 predates the review contract/);
  });

  it("refuses a blind-ab round that review-schema 0.3 accepts, so no engine reaches the page", () => {
    const round = blindAbRound();

    expect(VendoredRoundSchema.safeParse(round).success).toBe(true);
    expect(issuesOf(round)).toEqual([`questions: ${BLIND_AB_REFUSED}`]);
  });
});
