import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execGit, type GitExec } from "@titan-design/github";
import { gitIn, seedRepoWithOrigin } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { carryProbeSource, diffPinSource, markerMirrors, treeOfSource } from "./git-sources.js";

const ITEM = { repo: "Owner/Name", pr: 7 };

let root: string;
let author: string;
let seat: string;
let git: (...args: string[]) => string;
let calls: string[][];
const exec: GitExec = (args, options) => {
  calls.push([...args]);
  return execGit(args, options);
};
const count = (verb: string): number => calls.filter((args) => args.includes(verb)).length;

function numbered(edits: Record<number, string> = {}): string {
  return Array.from({ length: 20 }, (_, i) => edits[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";
}

/** Commits `content` as a.txt on `from` and publishes it as `branch` on origin, so the mirror can fetch it. */
function publish(branch: string, from: string, content: string): string {
  git("checkout", "-q", "-B", branch, from);
  fs.writeFileSync(path.join(author, "a.txt"), content);
  git("commit", "-q", "-a", "--allow-empty", "-m", branch);
  git("push", "-q", "--force", "origin", `HEAD:refs/heads/${branch}`);
  return git("rev-parse", "HEAD");
}

const sources = (now: () => number = Date.now) => {
  const mirrors = markerMirrors(path.join(root, "state"), () => seat, { exec });
  const diffPin = diffPinSource(mirrors, { exec, now });
  return { mirrors, diffPin, probe: carryProbeSource(mirrors, diffPin, { exec }) };
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-sources-")));
  author = path.join(root, "author");
  seedRepoWithOrigin(author, path.join(root, "origin.git"), { "a.txt": numbered() });
  git = gitIn(author);
  seat = path.join(root, "seat");
  gitIn(root)("clone", "-q", path.join(root, "origin.git"), seat);
  calls = [];
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it("the mirror is created once and the seat clone's refs are untouched", async () => {
  const seatRefs = gitIn(seat)("for-each-ref");
  const tip = publish("main", "main", numbered({ 5: "main" }));
  const head = publish("topic", "main", numbered({ 5: "main", 12: "topic" }));
  const { mirrors, diffPin } = sources();

  const mirror = await mirrors("Owner/Name");
  const pin = await diffPin(ITEM, head);
  const again = await markerMirrors(path.join(root, "state"), () => seat, { exec })("owner/name");

  expect(again).toBe(mirror);
  expect(mirror).toBe(path.join(root, "state", "marker-git", "owner__name.git"));
  expect(count("clone")).toBe(1);
  expect(pin).toMatchObject({ kind: "exact", head, main: tip, base: tip });
  expect(await treeOfSource(() => Promise.resolve([mirror]), { exec })(tip)).toBe(git("rev-parse", `${tip}^{tree}`));
  expect(gitIn(seat)("for-each-ref")).toBe(seatRefs);
});

it("a whitespace-only follow-up head probes as core-different and whitespace-blind-equal", async () => {
  const seed = git("rev-parse", "main");
  const reviewed = publish("reviewed", seed, numbered({ 3: "topic" }));
  const head = publish("topic", reviewed, numbered({ 3: "topic", 15: "line 15  " }));
  // Turns a.txt binary for any diff not run under HARDENED_GIT_ENV, and --binary then prints its bytes, spaces and all.
  fs.writeFileSync(path.join(root, "hostile.attributes"), "a.txt -diff\n");
  fs.writeFileSync(path.join(root, "hostile.gitconfig"), `[core]\n\tattributesFile = ${path.join(root, "hostile.attributes")}\n`);
  vi.stubEnv("GIT_CONFIG_GLOBAL", path.join(root, "hostile.gitconfig"));

  const probe = await sources().probe(ITEM, reviewed, head);

  expect(probe.reviewed.kind === "exact" && probe.current.kind === "exact" && probe.reviewed.core !== probe.current.core).toBe(true);
  expect(probe).toMatchObject({ wsBlindCoreEqual: true, headIsMerge: false, mergeUp: { ok: false } });
});

it("a hand-resolved conflict merge of main probes as a merge whose merge-up proof fails", async () => {
  const seed = git("rev-parse", "main");
  const reviewed = publish("topic", seed, numbered({ 10: "topic" }));
  const tip = publish("main", seed, numbered({ 10: "main" }));
  git("checkout", "-q", "topic");
  expect(() => git("merge", "-q", "--no-ff", "--no-commit", tip)).toThrow();
  fs.writeFileSync(path.join(author, "a.txt"), numbered({ 10: "topic and main" }));
  git("commit", "-q", "-a", "--no-edit");
  git("push", "-q", "origin", "HEAD:refs/heads/topic");
  const merged = git("rev-parse", "HEAD");

  const probe = await sources().probe(ITEM, reviewed, merged);

  expect(git("rev-list", "--parents", "-n", "1", merged).split(" ")).toHaveLength(3);
  expect(probe).toMatchObject({ headIsMerge: true, mergeUp: { ok: false, reason: expect.stringMatching(/conflicts with merged parent/) } });
});

it("two diff-pin reads of one head inside the cache window fetch once", async () => {
  const seed = git("rev-parse", "main");
  const head = publish("topic", seed, numbered({ 4: "topic" }));
  const other = publish("other", seed, numbered({ 6: "other" }));
  let now = 0;
  const { diffPin } = sources(() => now);

  const first = await diffPin(ITEM, head);
  const fetches = count("fetch");
  now = 59_000;
  const second = await diffPin(ITEM, head);
  const inWindow = count("fetch");
  const otherPin = await diffPin(ITEM, other);
  now = 61_000;
  await diffPin(ITEM, head);

  expect(second).toEqual(first);
  expect(inWindow).toBe(fetches);
  expect(otherPin).toMatchObject({ head: other });
  expect(count("fetch")).toBeGreaterThan(inWindow + 1);
});
