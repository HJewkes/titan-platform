import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { reclassMarkMigration, shepherdEventMigration } from "./events.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold, g10HoldAt } from "./registration-hold.js";
import { VERSION_PACKAGES_BRANCH } from "./release-diff.js";
import { holdSlotsMigration } from "./store-migrations.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

/** TP-6767: a changesets Version Packages PR whose diff is version-only is not held for the touch classes its paths fall under. */
const REPO = "octo/demo";
const HEAD = fakeSha("version-packages-head");
const BASE = fakeSha("base");
const SECURITY_HOLD = "g10-adversary: security touch";
const RELEASE_APP = "titan-release[bot]";
const GUARD = { name: "@demo/tool-guard", version: "1.1.0", scripts: { build: "tsc" }, dependencies: { zod: "^4.0.0" } };

const RELEASE_FILES: PrFile[] = [
  { path: "packages/tool-guard/package.json", status: "modified", additions: 1, deletions: 1 },
  { path: "packages/tool-guard/CHANGELOG.md", status: "modified", additions: 6, deletions: 0 },
  { path: ".changeset/brave-otters.md", status: "removed", additions: 0, deletions: 5 },
  { path: "CAPABILITIES.md", status: "modified", additions: 1, deletions: 1 },
];

function manifest(fake: FakeGitHub, base: object, head: object): void {
  fake.files.set(`${BASE}:packages/tool-guard/package.json`, { content: JSON.stringify(base), blobSha: "guard-base" });
  fake.files.set(`${HEAD}:packages/tool-guard/package.json`, { content: JSON.stringify(head), blobSha: "guard-head" });
}

interface ReleaseRig {
  files?: PrFile[];
  branch?: string;
  head?: object;
  /** Who GitHub's activity list says pushed changesets' branch to the head. */
  pusher?: string;
}

function pushedBy(fake: FakeGitHub, actor: string): void {
  fake.refActivity.set(VERSION_PACKAGES_BRANCH, [{ before: BASE, after: HEAD, ref: `refs/heads/${VERSION_PACKAGES_BRANCH}`, activityType: "push", actor }]);
}

function releaseRig({ files = RELEASE_FILES, branch = VERSION_PACKAGES_BRANCH, head = { ...GUARD, version: "1.2.0" }, pusher = RELEASE_APP }: ReleaseRig = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), reclassMarkMigration(25)]);
  const store = new ShepherdStore(db);
  const fake = fakeGitHub({ repo: REPO });
  const { number: pr } = fake.addPr({ headSha: HEAD, headRef: branch, headRepo: REPO });
  fake.prFiles.set(pr, files);
  manifest(fake, GUARD, head);
  pushedBy(fake, pusher);
  store.register({ repo: REPO, pr, branch, runId: "run-1", task: "demo/version-packages", implementer: "changesets", policy: OWNER_GATE_POLICY });
  return { fake, port: githubPort(fake.wire), store };
}

describe("a changesets Version Packages PR at registration (TP-6767)", () => {
  it("is not held when it changes only versions, changelogs, consumed changesets and the catalog, even under a security path", async () => {
    const r = releaseRig();

    const reason = await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP });

    expect(reason).toBeUndefined();
    expect(r.store.byRun("run-1")?.held).toBe(false);
    expect(r.store.eventsOf("run-1")).toEqual([]);
  });

  it.each([
    ["a source file under the security path", { path: "packages/tool-guard/src/deny-rules.ts", status: "modified" }],
    ["a file no release writes", { path: "README.md", status: "modified" }],
    ["an added changeset", { path: ".changeset/new-one.md", status: "added" }],
  ])("is held for its security touch when the diff also changes %s", async (_case, extra) => {
    const r = releaseRig({ files: [...RELEASE_FILES, extra] });

    const reason = await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP });

    expect(reason).toBe(SECURITY_HOLD);
    expect(r.store.byRun("run-1")).toMatchObject({ held: true, holdReason: SECURITY_HOLD });
  });

  it.each([
    ["a script", { ...GUARD, version: "1.2.0", scripts: { build: "tsc", postinstall: "node x.js" } }],
    ["a third-party dependency range", { ...GUARD, version: "1.2.0", dependencies: { zod: "^5.0.0" } }],
  ])("is held when a manifest changes %s beside its version", async (_case, head) => {
    const r = releaseRig({ head });

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when a manifest cannot be parsed at the head", async () => {
    const r = releaseRig();
    r.fake.files.set(`${HEAD}:packages/tool-guard/package.json`, { content: "{ not json", blobSha: "bad" });

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when the same version-only diff comes from any other branch", async () => {
    const r = releaseRig({ branch: "agent-chat/someone" });

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when the registered branch is changesets' but the PR's head is not", async () => {
    const r = releaseRig();
    r.fake.pr(1).headRef = "agent-chat/someone";

    expect(await g10HoldAt(r.port, { repo: REPO, pr: 1, branch: VERSION_PACKAGES_BRANCH, releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when the PR's head moved off the head whose files were classed", async () => {
    const r = releaseRig();

    expect(await g10HoldAt(r.port, { repo: REPO, pr: 1, branch: VERSION_PACKAGES_BRANCH, head: fakeSha("older-head"), releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when another account pushed the same version-only head to changesets' branch", async () => {
    const r = releaseRig({ pusher: "titan-agents[bot]" });

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });

  it("is held when no release App login is configured", async () => {
    const r = releaseRig();

    expect(await applyRegistrationHold(r.port, r.store, "run-1")).toBe(SECURITY_HOLD);
  });

  it("is held when the branch's push activity cannot be read", async () => {
    const r = releaseRig();
    r.fake.readFaults.listRefActivity = [new Error("activity unavailable")];

    expect(await applyRegistrationHold(r.port, r.store, "run-1", { releaseAppLogin: RELEASE_APP })).toBe(SECURITY_HOLD);
  });
});
