import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlannerInput } from "./config.js";
import { buildDigest, digestPreamble, type DigestPiece } from "./digest.js";
import { readInput } from "./inputs.js";

const PROMPT = "Propose one cause fix for the stale owner gates: why they wait, not a ping.";
const alarmInput = (file: string): PlannerInput => ({ name: "owner-gate-alarm", file, suffix: "", selfWritten: false, dropSections: [], digest: true, optional: true, prompt: PROMPT });
const noRun = async () => ({ code: 0, stdout: "", stderr: "" });

describe("planner alarm input", () => {
  it("the planner review input includes owner-gate-alarm.md and its cause-fix prompt line", () => {
    const pieces: DigestPiece[] = [{ input: alarmInput("/x/owner-gate-alarm.md"), text: "Owner gates stale: 1 over 72h\n\n- acme/widgets#12 148h\n" }];

    expect(buildDigest(pieces, 1000)).toContain("## owner-gate-alarm\n\nOwner gates stale: 1 over 72h");
    expect(digestPreamble("/x/digest.md", 1000, pieces)).toContain(PROMPT);
  });

  it("an absent optional alarm file adds neither a digest section nor the prompt line", async () => {
    const input = alarmInput(join(mkdtempSync(join(tmpdir(), "planner-alarm-")), "owner-gate-alarm.md"));
    const pieces: DigestPiece[] = [{ input, text: await readInput(input, noRun) }];

    expect(pieces[0]!.text).toBe("");
    expect(buildDigest(pieces, 1000)).not.toContain("owner-gate-alarm");
    expect(digestPreamble("/x/digest.md", 1000, pieces)).not.toContain(PROMPT);
  });

  it("a present alarm file is read as text", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "planner-alarm-")), "owner-gate-alarm.md");
    writeFileSync(file, "alarm\n");

    expect(await readInput(alarmInput(file), noRun)).toBe("alarm\n");
  });
});
