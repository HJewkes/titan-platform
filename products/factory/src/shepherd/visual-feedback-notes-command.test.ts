import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemLockPorts } from "../deploy-lock.js";
import type { DeliveryExec } from "./visual-delivery.js";
import { sweepWithLedger } from "./visual-feedback-notes-command.js";

const UNIT = "vf-sample-1a2b3c-2026-W45";
const DIR = `${UNIT}-r1`;
const KEYS = [`${DIR}#0`, `${DIR}#1`];
const manifest = {
  kind: "feedback",
  unit: UNIT,
  round: 1,
  questions: [{ id: "notes-pr-7" }, { id: "notes-pr-9" }],
  sections: [{ id: "pr-7" }, { id: "pr-9" }],
  prGroups: [
    { pr: "sample/repo#7", sectionIds: ["pr-7"] },
    { pr: "sample/repo#9", sectionIds: ["pr-9"] },
  ],
};

let root: string;
let roundsDir: string;
let stateDir: string;

async function putRound(): Promise<void> {
  const dir = join(roundsDir, DIR);
  const roundText = JSON.stringify(manifest);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "round.json"), roundText);
  const answers = [{ questionId: "notes-pr-7", text: "Tighten the badge" }, { questionId: "notes-pr-9", text: "Dark mode border" }];
  const sha = createHash("sha256").update(roundText).digest("hex");
  await writeFile(join(dir, "feedback.json"), JSON.stringify({ unit: UNIT, round: 1, manifestSha256: sha, submittedAt: "2026-11-10T00:00:00.000Z", answers }));
}

/** A fake `active-work task add` that records each title; `gate` holds every call until it resolves. */
function activeWork(gate: Promise<void> = Promise.resolve(), status = 0) {
  const added: string[] = [];
  const exec: DeliveryExec = async (argv) => {
    await gate;
    if (status === 0) added.push(argv[argv.indexOf("--title") + 1]!);
    return { status, stdout: "", stderr: status === 0 ? "" : "boom" };
  };
  return { exec, added };
}

const sweep = (exec: DeliveryExec) => sweepWithLedger({ roundsDir, stateDir, exec, lock: systemLockPorts() }, "fallback-init");
const ledger = async (): Promise<unknown> => JSON.parse(await readFile(join(stateDir, "visual-feedback-notes.json"), "utf8"));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "notes-ledger-"));
  roundsDir = join(root, "rounds");
  stateDir = join(root, "state");
  await putRound();
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("the feedback notes sweep on its ledger", () => {
  it("files each note once when two sweeps run at the same time", async () => {
    let open = (): void => undefined;
    const { exec, added } = activeWork(new Promise((resolve) => (open = resolve)));

    const first = sweep(exec);
    const second = sweep(exec);
    open();
    const settled = await Promise.allSettled([first, second]);
    await sweep(exec);

    expect(added.sort()).toEqual(["Dark mode border", "Tighten the badge"]);
    expect(settled.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  });

  it("files a note exactly once when the ledger write fails", async () => {
    await mkdir(join(stateDir, "visual-feedback-notes.json.tmp"), { recursive: true });
    const { exec, added } = activeWork();

    const broken = await sweep(exec);
    await rm(join(stateDir, "visual-feedback-notes.json.tmp"), { recursive: true });
    await sweep(exec);
    await sweep(exec);

    expect(broken.failed.map((entry) => entry.key)).toEqual(KEYS);
    expect(added.sort()).toEqual(["Dark mode border", "Tighten the badge"]);
  });

  it("leaves a note whose task add failed to the next sweep", async () => {
    const failing = activeWork(Promise.resolve(), 1);
    const working = activeWork();

    const first = await sweep(failing.exec);
    await sweep(working.exec);

    expect(first.failed.map((entry) => entry.key)).toEqual(KEYS);
    expect(working.added).toHaveLength(2);
    expect(await ledger()).toEqual(KEYS);
  });

  it("takes the next sweep's lock after a sweep ends", async () => {
    const { exec } = activeWork();

    await sweep(exec);
    const again = await sweep(exec);

    expect(again).toMatchObject({ filed: [], skipped: 2 });
  });
});
