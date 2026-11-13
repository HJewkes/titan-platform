import { describe, expect, it } from "vitest";
import { attestTokens } from "./attest.js";

const HEAD = "c".repeat(40);
const block = `Verdict: MERGE\nPR: octo/demo#7\nHead: ${HEAD}\n`;
const CI_WAIT = `ci-wait@${"a".repeat(12)}`;
const MERGE_STEP = `merge@${"b".repeat(12)}`;

describe("attestTokens", () => {
  it("a bolded Attests heading is read", () => {
    expect(attestTokens(`Checked.\n**Attests:** ${CI_WAIT}, ${MERGE_STEP}\n\n${block}`)).toEqual([CI_WAIT, MERGE_STEP]);
  });

  it.each([
    ["a bulleted lower-case heading", `- attests: ${CI_WAIT}, ${MERGE_STEP}`],
    ["a full-width colon and backticked tokens", `Attests\uff1a \`${CI_WAIT}\`, \`${MERGE_STEP}\``],
  ])("an Attests heading written as %s is read", (_shape, line) => {
    expect(attestTokens(`Checked.\n${line}\n\n${block}`)).toEqual([CI_WAIT, MERGE_STEP]);
  });

  it("a code name that only starts with the label is no Attests line", () => {
    expect(attestTokens(`Checked.\nattests-reader: ${CI_WAIT}\n\n${block}`)).toEqual([]);
  });
});
