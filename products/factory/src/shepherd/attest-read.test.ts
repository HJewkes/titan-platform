import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import type { ReviewerAgent } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import { describe, expect, it } from "vitest";
import { fakeLocator } from "../test-support/fakes.js";
import { attestAtHead, type AttestReaders } from "./attest-evidence.js";
import { ATTESTATIONS_DIR, LEGACY_ATTESTATIONS_PATH, attestationsFileOf, briefClaimsAt, readClaims } from "./attest-read.js";
import { mergeEvidence, noFreezeStoreUntilTp523, type MergeEvidenceInput } from "./merge-facts.js";
import type { Registration, ShepherdStore, ShepherdStoreRef } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("attest-read-head");
const closure = (seed: string) => fakeSha(`closure-${seed}`) + fakeSha(`closure-${seed}-tail`).slice(0, 24);
const CI_WAIT = { step: "ci-wait", closure: closure("ci-wait"), pr: 1 };
const MERGE_STEP = { step: "merge", closure: closure("merge"), pr: 1 };

const agent = (name: string, spawnedBy: string | null): ReviewerAgent => ({ name, agentId: `agent-${name}`, sessionId: `session-${name}`, presence: "live", spawnedBy, predecessor: null });
/** Shaped like the broker's `agent ls --include-retired`: Shepherd spawns as "human", which has no row of its own. */
const roster = [agent("impl-a", "human"), agent("rev-1", "human"), agent("adv-1", "human"), agent("fix-1", "impl-a"), agent("rev-2", "ghost")];
const identity = (name: string) => ({ agentId: `agent-${name}`, sessionId: `session-${name}` });

type Files = Record<number, unknown>;
/** One PR's rows as an array or raw text, or several PR files by number. */
type Side = unknown[] | string | Files;

/** Sets each PR's `<pr>.json` at `ref`, as JSON unless it is already a string. */
function setFiles(fake: FakeGitHub, ref: string, files: Files): void {
  for (const [pr, rows] of Object.entries(files)) {
    const content = typeof rows === "string" ? rows : JSON.stringify(rows);
    fake.files.set(`${ref}:${attestationsFileOf(Number(pr))}`, { content, blobSha: fakeSha(`${pr}:${content}`) });
  }
}

/** The base and head as PR files: an array is PR 1's own file, an object names each file by its PR. */
function world(base: Side | undefined, head: Side): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, mergeSha: fakeSha("attest-test-merge") });
  fake.setRuns(HEAD, [successRun("validate", 1)]);
  fake.prFiles.set(1, [{ path: attestationsFileOf(1), status: "added" }]);
  const asFiles = (side: Side): Files => (Array.isArray(side) || typeof side === "string" ? { 1: side } : side);
  if (base !== undefined) setFiles(fake, "main", asFiles(base));
  setFiles(fake, HEAD, asFiles(head));
  return fake;
}

function readers(holdReason: string | null = null): AttestReaders {
  const registration = partialFake<Registration>({ runId: "run-1", implementer: "impl-a", holdReason });
  const store = partialFake<ShepherdStore>({ byRun: () => registration, authorsOf: () => [] });
  return { store: partialFake<ShepherdStoreRef>({ get: () => store }), roster: async () => roster };
}

const input = (reviewer: string, attests: string[]): MergeEvidenceInput => ({
  runId: "run-1",
  repo: REPO,
  pr: 1,
  head: HEAD,
  verdict: { value: "MERGE", head: HEAD, locator: fakeLocator({ sourceId: "transcript-1", selector: { kind: "subrecord-text" } }) },
  resolver: identity(reviewer),
  dispatchedReviewer: identity(reviewer),
  seatGrants: ["merge-on-green-approve"],
  attest: { attests },
});

const token = (row: { step: string; closure: string }) => `${row.step}@${row.closure.slice(0, 12)}`;

async function evidence(fake: FakeGitHub, request: MergeEvidenceInput, holdReason?: string) {
  const port = githubPort(fake.wire);
  return mergeEvidence(port, request, noFreezeStoreUntilTp523, { kind: "correctness" }, undefined, { attest: (i, baseRef) => attestAtHead(port, readers(holdReason), i, baseRef) });
}

describe("readClaims", () => {
  it("rows are read at the base ref and the head, and only new or changed rows are claimed", async () => {
    const changed = { ...MERGE_STEP, closure: closure("merge-changed") };
    const fake = world([CI_WAIT, MERGE_STEP], [CI_WAIT, changed, { step: "land", closure: closure("land"), pr: 1 }]);

    const read = await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ claimed: [changed, { step: "land", closure: closure("land"), pr: 1 }] });
  });

  it("the rows are the union of every PR's file, so a row another PR's file carries at the base is not claimed", async () => {
    const other = { step: "ci-wait", closure: closure("other"), pr: 2 };
    const fake = world({ 2: [other] }, { 1: [MERGE_STEP], 2: [other] });

    const read = await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ claimed: [MERGE_STEP] });
  });

  it("a head file with the base file's blob is not read again", async () => {
    const other = [{ step: "ci-wait", closure: closure("other"), pr: 2 }];
    const fake = world({ 2: other }, { 1: [MERGE_STEP], 2: other });

    await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(fake.calls.filter((call) => call === "getContent")).toHaveLength(2);
  });

  it("a base from before the directory reads its legacy file, so a migration claims nothing it moved", async () => {
    const fake = world(undefined, { 1: [CI_WAIT], 2: [{ ...MERGE_STEP, pr: 2 }] });
    fake.files.set(`main:${LEGACY_ATTESTATIONS_PATH}`, { content: JSON.stringify([CI_WAIT, { ...MERGE_STEP, pr: 2 }]), blobSha: "legacy" });

    const read = await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ claimed: [] });
  });

  it("a malformed head file reads unread, never as claiming nothing", async () => {
    const read = await readClaims(githubPort(world(undefined, "[{").wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ unread: `${ATTESTATIONS_DIR} is unreadable: malformed` });
  });

  it("a malformed file of another PR reads unread, though this PR's own file parses", async () => {
    const read = await readClaims(githubPort(world([], { 1: [CI_WAIT], 2: [{ step: "ci-wait" }] }).wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ unread: `${ATTESTATIONS_DIR} is unreadable: malformed` });
  });

  it("a file in the directory no PR could have written reads unread", async () => {
    const fake = world([], [CI_WAIT]);
    fake.files.set(`${HEAD}:${ATTESTATIONS_DIR}/notes.json`, { content: "[]", blobSha: "stray" });

    const read = await readClaims(githubPort(fake.wire), { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ unread: `${ATTESTATIONS_DIR} is unreadable: malformed` });
  });

  it("a directory listing that cannot be read reads unread with its HTTP status", async () => {
    const port = githubPort(world([], [CI_WAIT]).wire);
    const failing = { ...port, listFiles: async () => Promise.reject(Object.assign(new Error("server error"), { status: 502 })) };

    const read = await readClaims(failing, { repo: REPO, base: "main", head: HEAD });

    expect(read).toEqual({ unread: `${ATTESTATIONS_DIR} is unreadable: HTTP 502` });
  });
});

describe("briefClaimsAt", () => {
  it("asks the reviewer about each row the head claims against the PR's base", async () => {
    const claims = await briefClaimsAt(githubPort(world([CI_WAIT], [CI_WAIT, MERGE_STEP]).wire), { repo: REPO, pr: 1, head: HEAD });

    expect(claims).toEqual({ attestClaims: [{ step: "merge", closure: MERGE_STEP.closure }] });
  });

  it("lists the claimed step's closure files this PR changed, and none it left alone", async () => {
    const fake = world([], [CI_WAIT]);
    fake.prFiles.set(1, [{ path: attestationsFileOf(1), status: "added" }, { path: "src/ci-wait.ts", status: "modified" }, { path: "src/unrelated.ts", status: "modified" }]);
    const members = (step: string) => (step === "ci-wait" ? ["src/ci-wait.ts", "src/helper.ts"] : undefined);

    const claims = await briefClaimsAt(githubPort(fake.wire), { repo: REPO, pr: 1, head: HEAD }, members);

    expect(claims).toEqual({ attestClaims: [{ step: "ci-wait", closure: CI_WAIT.closure, changedFiles: ["src/ci-wait.ts"] }] });
  });

  it("reads a ci-wait claim's closure from the registry when no reader is given", async () => {
    const fake = world([], [CI_WAIT]);
    fake.prFiles.set(1, [{ path: "products/factory/src/workflows/land-ci-wait.ts", status: "modified" }]);

    const claims = await briefClaimsAt(githubPort(fake.wire), { repo: REPO, pr: 1, head: HEAD });

    expect(claims.attestClaims?.[0]?.changedFiles).toEqual(["products/factory/src/workflows/land-ci-wait.ts"]);
  });

  it("asks nothing when the head claims no row", async () => {
    const claims = await briefClaimsAt(githubPort(world([CI_WAIT], [CI_WAIT]).wire), { repo: REPO, pr: 1, head: HEAD }, () => ["src/ci-wait.ts"]);

    expect(claims).toEqual({});
  });
});

describe("the evidence record's attestations", () => {
  it("names the independent reviewer that met a row and why the row it left out is unmet", async () => {
    const result = await evidence(world([], [CI_WAIT, MERGE_STEP]), input("rev-1", [token(CI_WAIT)]));

    expect(result.record.attested).toEqual([{ step: "ci-wait", closure: CI_WAIT.closure, meeters: [{ name: "rev-1", agentId: "agent-rev-1", shape: "correctness" }] }]);
    expect(result.record.attestUnmet).toEqual([{ step: "merge", why: "no-meeter" }]);
  });

  it("records the implementer's own Attests line as unmet: meeter-is-author", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("impl-a", [token(CI_WAIT)]));

    expect(result.record).toMatchObject({ attested: [], attestUnmet: [{ step: "ci-wait", why: "meeter-is-author" }] });
  });

  it("records a fixer the implementer spawned as unmet: meeter-is-author", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("fix-1", [token(CI_WAIT)]));

    expect(result.record).toMatchObject({ attested: [], attestUnmet: [{ step: "ci-wait", why: "meeter-is-author" }] });
  });

  it("records a reviewer whose spawner is absent from the roster as unmet: meeter-is-author", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("rev-2", [token(CI_WAIT)]));

    expect(result.record).toMatchObject({ attested: [], attestUnmet: [{ step: "ci-wait", why: "meeter-is-author" }] });
  });

  it("on a g10-adversary hold the correctness line alone is unmet: adversary-missing", async () => {
    const result = await evidence(world([], [CI_WAIT]), input("rev-1", [token(CI_WAIT)]), "g10-adversary: authority path");

    expect(result.record.attestUnmet).toEqual([{ step: "ci-wait", why: "adversary-missing" }]);
  });
});
