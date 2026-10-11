import { describe, expect, it } from "vitest";
import { HARD_STOP_CLASSES } from "./charter-policy.js";
import { HARD_STOPS, hardStopsIn } from "./hard-stops.js";

describe("HARD_STOPS", () => {
  it("has exactly one pattern for each of the twelve classes", () => {
    const names = HARD_STOPS.map((stop) => stop.name);

    expect([...names].sort()).toEqual([...HARD_STOP_CLASSES].sort());
  });

  it("holds no global pattern, so repeated tests never skip a match", () => {
    expect(HARD_STOPS.filter((stop) => stop.pattern.global || stop.pattern.sticky)).toEqual([]);
  });
});

describe("hardStopsIn: one fixture done_when per class", () => {
  it.each([
    ["ruleset-write", "Apply the repo ruleset to main"],
    ["tag-move", "Cut a release tag for 2.0"],
    ["npm-publish", "Merge the Version Packages PR"],
    ["broker-restart", "Restart the broker after the fix lands"],
    ["launchd-install", "Run burndown install on the host"],
    ["dotfiles-merge", "merge the dotfiles PR"],
    ["config-edit", "Add the rule to settings.json"],
    ["force-push", "force-push the rebased branch"],
    ["deploy", "wrangler deploy to production"],
    ["spend-money", "Purchase the domain"],
    ["third-party-message", "email the vendor"],
    ["personal-data", "read the lab results"],
  ])("%s matches %j", (name, doneWhen) => {
    expect(hardStopsIn(doneWhen)).toContain(name);
  });
});

// The scorer's existing stop-short cases, against the same charter subset: identical hits,
// except that "merge the dotfiles" now has the pattern it lacked.
describe("hardStopsIn: the burndown scorer's cases", () => {
  const charterStops = ["deploy", "config-edit", "broker-restart", "dotfiles-merge"];

  it.each([
    ["a deploy", "Deploy the worker.", ["deploy"]],
    ["two stops in pattern order", "Edit CLAUDE.md, then deploy.", ["deploy", "config-edit"]],
    ["a restart window", "ships in a restart window", ["broker-restart"]],
    ["a stop the charter does not list", "npm publish the package", []],
    ["a stop that now has a pattern", "merge the dotfiles", ["dotfiles-merge"]],
    ["a word-boundary miss", "redeployment notes", []],
    ["no done_when", null, []],
  ])("%s", (_scenario, doneWhen, expected) => {
    expect(hardStopsIn(doneWhen, charterStops)).toEqual(expected);
  });
});

// Every action the burndown eligibility check reserves for a person is still a hard stop.
describe("hardStopsIn: the eligibility check's human-only actions", () => {
  it.each([
    ["shipped in a planned restart window", "broker-restart"],
    ["the worker deployed", "deploy"],
    ["launchd install of the tick", "launchd-install"],
    ["git reset --hard origin/main", "force-push"],
    ["edit ~/.agent-chat/config.json", "config-edit"],
    ["pay for the plan", "spend-money"],
  ])("%j is %s", (doneWhen, name) => {
    expect(hardStopsIn(doneWhen)).toContain(name);
  });
});

describe("hardStopsIn: near misses", () => {
  it.each([
    ["open a PR against the dotfiles repo"],
    ["fix the error message text"],
    ["add a health check endpoint"],
    ["document the publish flow"],
  ])("%j matches nothing", (doneWhen) => {
    expect(hardStopsIn(doneWhen)).toEqual([]);
  });

  it("reports no class outside `among`, even on a match", () => {
    expect(hardStopsIn("email the vendor", [])).toEqual([]);
  });
});
