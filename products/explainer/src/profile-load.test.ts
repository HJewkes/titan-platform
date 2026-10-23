import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";
import { fixedProfile } from "./profile-fixtures.test-helpers.js";
import { EXPLAIN_REPO_DEFAULT_TYPE, loadProfiles, profileFor, UnknownProfileError } from "./profile-load.js";

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
