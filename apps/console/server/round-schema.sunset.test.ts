import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RoundSchema } from "@titan-design/review-schema";
import { FIXTURE_ROUNDS } from "./round-fixtures.js";

const DELETE_THE_COPY =
  "review-schema >= 0.3 is installed: delete server/review-schema-0.3/, point round-schema.ts at the package, " +
  "bump owner-queue to it, drop the owner-queue gap in approval-items.ts and delete this test (TP-3232)";

describe("the vendored review-schema 0.3 sunset", () => {
  it("fails once the installed review-schema reads a round only 0.3 knows", () => {
    const round: unknown = JSON.parse(readFileSync(path.join(FIXTURE_ROUNDS.dir, "td920-packet-r1", "round.json"), "utf8"));

    expect(RoundSchema.safeParse(round).success, DELETE_THE_COPY).toBe(false);
  });
});
