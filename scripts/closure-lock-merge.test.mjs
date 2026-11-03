import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DRIVER, mergeLocks } from "./closure-lock-merge.mjs";
import { ATTESTATIONS_DIR, LOCK_PATH, judgeAddedRows, readBaseAttestations, readTreeAttestations } from "./step-closure-check.mjs";

const DRIVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "closure-lock-merge.mjs");
const lockRow = (closure) => ({ closure, schemaHash: "schema-1", bump: 0 });
const BASE_LOCK = { "ci-wait": lockRow("ci-wait-0"), merge: lockRow("merge-0") };

/** Three PRs off one base: two each attest a new ci-wait closure in their own file, the third moves merge's closure. */
const PRS = {
  11: { lock: { "ci-wait": lockRow("ci-wait-11") }, rows: [{ step: "ci-wait", closure: "ci-wait-11", pr: 11 }] },
  12: { lock: { "ci-wait": lockRow("ci-wait-12") }, rows: [{ step: "ci-wait", closure: "ci-wait-12", pr: 12 }] },
  13: { lock: { merge: lockRow("merge-13") }, rows: [] },
};

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A repo on `main` with the base lock and one earlier PR's file, the driver registered as `pnpm install` registers it. */
function baseRepo() {
  const root = mkdtempSync(join(tmpdir(), "closure-lock-merge-"));
  roots.push(root);
  const git = (args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const write = (path, value) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  git(["init", "-q", "-b", "main"]);
  git(["config", `merge.${DRIVER}.driver`, `node ${JSON.stringify(DRIVER_SCRIPT)} %O %A %B`]);
  write(".gitattributes", `${LOCK_PATH} merge=${DRIVER}\n`);
  write(LOCK_PATH, BASE_LOCK);
  write(`${ATTESTATIONS_DIR}/3.json`, [{ step: "merge", closure: "merge-0", pr: 3 }]);
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  return { root, git, write };
}

function openPrs({ git, write }) {
  for (const [pr, { lock, rows }] of Object.entries(PRS)) {
    git(["checkout", "-q", "-b", `pr-${pr}`, "main"]);
    write(LOCK_PATH, { ...BASE_LOCK, ...lock });
    if (rows.length > 0) write(`${ATTESTATIONS_DIR}/${pr}.json`, rows);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", `pr ${pr}`]);
  }
}

/** The rows the PR's merged-up tree adds over main, as the closure check judges them. */
function claimedAt(repo, pr) {
  const listDir = (dir) => readdirSync(join(repo.root, dir));
  const tree = readTreeAttestations(listDir, (path) => readFileSync(join(repo.root, path), "utf8"));
  return judgeAddedRows(readBaseAttestations(repo.git, "main"), tree.rows, pr);
}

/** Lands each PR in `order` the way a merge-main round does: main into the PR, then the PR into main. */
function landInOrder(repo, order) {
  const claims = {};
  for (const pr of order) {
    repo.git(["checkout", "-q", `pr-${pr}`]);
    repo.git(["merge", "-q", "--no-edit", "main"]);
    claims[pr] = claimedAt(repo, Number(pr));
    repo.git(["checkout", "-q", "main"]);
    repo.git(["merge", "-q", "--no-ff", "--no-edit", `pr-${pr}`]);
  }
  return claims;
}

const ORDERS = [
  ["11", "12", "13"],
  ["11", "13", "12"],
  ["12", "11", "13"],
  ["12", "13", "11"],
  ["13", "11", "12"],
  ["13", "12", "11"],
];

describe("three PRs that move closures land in any order", () => {
  it.each(ORDERS.map((order) => [order.join(" then "), order]))("%s: no merge conflicts, and each PR claims exactly its own rows", (_label, order) => {
    const repo = baseRepo();
    openPrs(repo);

    const claims = landInOrder(repo, order);

    for (const pr of order) expect(claims[pr]).toEqual({ failures: [], notices: PRS[pr].rows.map((row) => `attest required: ${row.step}@${row.closure.slice(0, 12)}`) });
    const landed = readBaseAttestations(repo.git, "main");
    expect(landed).toHaveLength(3);
    const lock = JSON.parse(readFileSync(join(repo.root, LOCK_PATH), "utf8"));
    expect(lock.merge.closure).toBe("merge-13");
  });
});

describe("mergeLocks", () => {
  it("takes each step from the side that moved it and keeps a step both moved from ours, naming it diverged", () => {
    const base = { a: lockRow("a0"), b: lockRow("b0"), c: lockRow("c0") };

    const merged = mergeLocks(base, { ...base, a: lockRow("a-ours"), c: lockRow("c-ours") }, { ...base, b: lockRow("b-theirs"), c: lockRow("c-theirs") });

    expect(merged).toEqual({ lock: { a: lockRow("a-ours"), b: lockRow("b-theirs"), c: lockRow("c-ours") }, diverged: ["c"] });
  });

  it("drops a step the other side removed and keeps one both sides added alike", () => {
    const base = { a: lockRow("a0"), gone: lockRow("g0") };
    const { gone: _gone, ...theirs } = base;

    const merged = mergeLocks(base, { ...base, added: lockRow("n") }, { ...theirs, added: lockRow("n") });

    expect(merged).toEqual({ lock: { a: lockRow("a0"), added: lockRow("n") }, diverged: [] });
  });
});

it("an unparseable side makes the driver exit non-zero, so git reports the conflict", () => {
  const root = mkdtempSync(join(tmpdir(), "closure-lock-merge-"));
  roots.push(root);
  for (const [name, text] of [["o", "{}"], ["a", "{"], ["b", "{}"]]) writeFileSync(join(root, name), text);

  const run = spawnSync(process.execPath, [DRIVER_SCRIPT, join(root, "o"), join(root, "a"), join(root, "b")]);

  expect(run.status).not.toBe(0);
});
