import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { fixedProfile } from "./profile-fixtures.test-helpers.js";
import { EXPLAIN_REPO_DEFAULT_TYPE, loadProfiles, loadTypeProfiles, profileFor, UnknownProfileError } from "./profile-load.js";

function writeTypes(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "profiles-"));
  mkdirSync(join(dir, "types"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, "types", name), stringify(body));
  return dir;
}

describe("loadProfiles", () => {
  it("loads the four families plus the argument, and both audience packs", () => {
    const set = loadProfiles();

    expect([...set.profiles.keys()]).toEqual(["daily-overview", "paper-summary", "pr-overview", "repo-argument", "repo-tour"]);
    expect([...set.profiles.values()].map((profile) => profile.family).sort()).toEqual(["briefing", "review-paper", "review-pr", "review-repo", "review-repo"]);
    expect([...set.audiences.keys()]).toEqual(["owner-internal", "public-youtube"]);
  });

  it("makes the tour the explain-repo default, for the owner first", () => {
    const tour = profileFor(loadProfiles(), EXPLAIN_REPO_DEFAULT_TYPE);

    expect(tour.type).toBe("repo-tour");
    expect(tour.audience.default).toBe("owner-internal");
  });

  it("rejects an unknown profile, naming the known ones", () => {
    expect(() => profileFor(loadProfiles(), "repo-saga")).toThrow(UnknownProfileError);
    expect(() => profileFor(loadProfiles(), "repo-saga")).toThrow(/known: daily-overview, paper-summary/);
  });

  it("rejects a spend cap, since cost is tracked rather than capped per profile", () => {
    const dir = writeTypes({ "repo-tour.yaml": { ...fixedProfile(), budgetUsd: 3 } });

    expect(() => loadProfiles(dir)).toThrow(/types\/repo-tour\.yaml: .*budgetUsd/s);
  });

  it("rejects a required signature layer, which is a pilot hypothesis", () => {
    const dir = writeTypes({ "repo-tour.yaml": { ...fixedProfile(), layers: { ...fixedProfile().layers, signatureRequired: true } } });

    expect(() => loadProfiles(dir)).toThrow(/signatureRequired/);
  });

  it("rejects an audition of fewer than three spines", () => {
    const dir = writeTypes({ "repo-tour.yaml": { ...fixedProfile(), audition: { k: 2, storyboardOnly: true } } });

    expect(() => loadProfiles(dir)).toThrow(/audition/);
  });

  it("rejects a file whose name differs from its type", () => {
    const dir = writeTypes({ "tour.yaml": fixedProfile() });

    expect(() => loadProfiles(dir)).toThrow("types/tour.yaml: names repo-tour, so the file is repo-tour.yaml");
  });
});

/** The sound fixed profile as written by a profile that sets neither its own runtime nor, unless given, its audience kind. */
function unbandedProfile(kind?: "public" | "assigned"): Record<string, unknown> {
  const { runtime: _runtime, audience, ...rest } = fixedProfile();
  return { ...rest, audience: { default: audience.default, allow: audience.allow, ...(kind ? { kind } : {}) } };
}

describe("a profile's runtime band by audience", () => {
  it("runs a profile that names no audience kind as assigned, in the 600 s band", () => {
    const dir = writeTypes({ "repo-tour.yaml": unbandedProfile() });

    const profile = loadTypeProfiles(dir).get("repo-tour")!;

    expect(profile.audience.kind).toBe("assigned");
    expect(profile.runtime).toEqual({ targetS: 600, minS: 480, maxS: 720, splitAboveS: 900 });
  });

  it("caps a public profile with no band of its own at 360 s, splitting past it", () => {
    const dir = writeTypes({ "repo-tour.yaml": unbandedProfile("public") });

    const { runtime } = loadTypeProfiles(dir).get("repo-tour")!;

    expect(runtime).toEqual({ targetS: 240, minS: 120, maxS: 360, splitAboveS: 360 });
  });

  it("keeps a public profile's own band over the audience default", () => {
    const band = { targetS: 420, minS: 300, maxS: 480, splitAboveS: 600 };
    const dir = writeTypes({ "repo-tour.yaml": { ...unbandedProfile("public"), runtime: band } });

    const { runtime } = loadTypeProfiles(dir).get("repo-tour")!;

    expect(runtime).toEqual(band);
  });

  it("keeps the daily overview's own 180 s band, 120-240", () => {
    const daily = profileFor(loadProfiles(), "daily-overview");

    expect(daily.runtime).toEqual({ targetS: 180, minS: 120, maxS: 240, splitAboveS: 300 });
  });

  it("keeps the assigned repo tour at 600 s, 480-720, and holds the public argument under 360 s", () => {
    const set = loadProfiles();

    const [tour, argument] = [profileFor(set, "repo-tour"), profileFor(set, "repo-argument")];

    expect([tour.audience.kind, tour.runtime.targetS, tour.runtime.minS, tour.runtime.maxS]).toEqual(["assigned", 600, 480, 720]);
    expect([argument.audience.kind, argument.runtime.maxS <= 360]).toEqual(["public", true]);
  });

  it("rejects an audience kind other than public or assigned", () => {
    const dir = writeTypes({ "repo-tour.yaml": { ...fixedProfile(), audience: { ...fixedProfile().audience, kind: "internal" } } });

    expect(() => loadProfiles(dir)).toThrow(/types\/repo-tour\.yaml: .*kind/s);
  });
});
