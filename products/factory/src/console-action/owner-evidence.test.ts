import { describe, expect, it } from "vitest";
import { AFTER_OPEN, BEFORE_OPEN, H, MERGE_BASE, SKILL, WORKFLOW, evidence, evidenceStep, gateOn, putFile, reads, verdictText, weakened } from "../test-support/owner-evidence.js";
import { ownerEvidence } from "./owner-evidence.js";

describe("the owner-at-head evidence card", () => {
  it("heads a decorated weakened line before a canonical unchanged one with the stored reading, listing both lines", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const text = verdictText("**CI policy:** weakened secrets", "CI-policy: unchanged");

    const card = await ownerEvidence(gate, { host, port, readText: reads(text) });

    expect(card).toMatchObject({ status: "ready", head: H, mergeBase: MERGE_BASE, facts: ["ci-policy-weakened"] });
    expect(card.status === "ready" && card.sections).toEqual([
      {
        fact: "ci-policy-weakened",
        ciPolicy: weakened("secrets"),
        verdictLines: text.split("\n"),
        labelledLines: [
          { raw: "**CI policy:** weakened secrets", reading: weakened("secrets") },
          { raw: "CI-policy: unchanged", reading: { kind: "unchanged" } },
        ],
        files: [],
      },
    ]);
  });

  it("shows the verdict text with a hidden character as its code point, so a bidi mark cannot reorder what the owner reads", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("Synthetic rationale \u202Edesrever", "CI-policy: weakened secrets")) });

    expect(card.status === "ready" && card.sections.map((section) => "verdictLines" in section && section.verdictLines[0])).toEqual(["Synthetic rationale \\u{202E}desrever"]);
  });

  it("reads missing when the verdict text no longer reads as the stored CI-policy reading", async () => {
    const stored = evidence(weakened("permissions"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("does not read as the evidence's CI-policy reading") });
  });

  it("reads missing when the gate's marker names a fact the evidence does not hold, an unknown one included", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    const marked = { ...gate, prompt: gate.prompt.replace("their own head: ci-policy-weakened.", "their own head: ci-policy-weakened, bogus.") };

    const card = await ownerEvidence(marked, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", facts: ["ci-policy-weakened", "bogus"] });
  });

  it("shows the evidence the gate opened on, not a re-read that completed after it", async () => {
    const opened = evidence(weakened("secrets"));
    const reread = evidence(weakened("permissions"));
    const { host, port, gate } = await gateOn(opened, [evidenceStep(BEFORE_OPEN, opened, 0), evidenceStep(AFTER_OPEN, reread, 1)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card.status === "ready" && card.sections.map((section) => "ciPolicy" in section && section.ciPolicy)).toEqual([weakened("secrets")]);
  });

  it("shows a renamed workflow's old path as deleted, since the evidence lists both sides of the rename", async () => {
    const renamedTo = "docs/ci.yml";
    const stored = evidence(weakened("other"), [renamedTo, WORKFLOW]);
    const { host, fake, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)]);
    fake.compares.set(`main...${H}`, { mergeBaseSha: MERGE_BASE, files: [renamedTo] });
    putFile(fake, MERGE_BASE, WORKFLOW, "on: push\njobs: {}\n");
    putFile(fake, H, renamedTo, "on: push\njobs: {}\n");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened other")) });

    expect(card.status === "ready" && card.sections.map((section) => section.files)).toEqual([
      [{ path: WORKFLOW, rows: [{ side: "-", n: 1, text: "on: push\\u{A}" }, { side: "-", n: 2, text: "jobs: {}\\u{A}" }] }],
    ]);
  });

  it("shows a skill change's file exactly against the merge base", async () => {
    const stored = evidence(undefined, [SKILL]);
    const { host, fake, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "authority/MRG-AU");
    putFile(fake, H, SKILL, "# Synthetic skill\n");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: unchanged")) });

    expect(card).toMatchObject({ status: "ready", facts: ["skill-path"], sections: [{ fact: "skill-path", files: [{ path: SKILL, rows: [{ side: "+", n: 1, text: "# Synthetic skill\\u{A}" }] }] }] });
  });

  it("reads missing, with the terminal command, for a files-unread gate, whose evidence holds no file list to show", async () => {
    const stored = { ...evidence(), changedFilesUnread: "synthetic: the file list was cut short" };
    const { host, port, gate } = await gateOn(stored, [evidenceStep(BEFORE_OPEN, stored, 0)], "authority/MRG-AU");

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: unchanged")) });

    expect(card).toMatchObject({ status: "missing", facts: ["files-unread"], reason: expect.stringContaining("files-unread"), command: expect.stringContaining(`"headSha":"${H}"`) });
  });

  it("reads missing when no evidence step completed before the gate opened", async () => {
    const stored = evidence(weakened("secrets"));
    const { host, port, gate } = await gateOn(stored, [evidenceStep(AFTER_OPEN, stored, 0)]);

    const card = await ownerEvidence(gate, { host, port, readText: reads(verdictText("CI-policy: weakened secrets")) });

    expect(card).toMatchObject({ status: "missing", reason: expect.stringContaining("no well-formed merge evidence") });
  });
});
