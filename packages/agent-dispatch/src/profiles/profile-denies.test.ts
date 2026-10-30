import { describe, expect, it } from "vitest";

import { parseProfile, type AgentProfile } from "./index.js";

/**
 * Ported from agent-chat. Its launch-plan assertions, its built-in profile rows and its rows over
 * the repo's shipped profile files are not here: they return with `/launch` and the built-ins.
 */

const INBOX = "Bash(agent-chat inbox:*)";
const APPROVE = "Bash(agent-chat approve:*)";
const ENDORSE = "Bash(agent-chat endorse:*)";
const ASK = "Bash(agent-chat ask:*)";
const DEBUG_SEND = "Bash(agent-chat debug send:*)";
const BURNDOWN = "Bash(agent-chat burndown:*)";
const SEATS = "Bash(agent-chat seats:*)";

const valid = { model: "sonnet", allowedTools: ["Read", "Bash"], isolation: "none", surface: "headless" };

function parsed(body: Record<string, unknown>): AgentProfile {
  const profile = parseProfile("fixture", { ...valid, ...body });
  if ("error" in profile) throw new Error(profile.error);
  return profile;
}

describe("the `denies` key of a profile file (CC-558)", () => {
  // Mutation caught: ignoring the key, which is how a reviewer profile kept Monitor and ScheduleWakeup.
  it("denies its tools, after the ones disallowedTools names", () => {
    const profile = parsed({ disallowedTools: ["Write"], denies: ["Monitor", "ScheduleWakeup"] });

    expect(profile.disallowedTools).toEqual(["Write", "Monitor", "ScheduleWakeup"]);
    expect(profile).not.toHaveProperty("warnings");
  });

  it("stands alone in a file with no disallowedTools, and repeats nothing", () => {
    expect(parsed({ denies: ["Monitor"] }).disallowedTools).toEqual(["Monitor"]);
    expect(parsed({ disallowedTools: ["Monitor"], denies: ["Monitor"] }).disallowedTools).toEqual(["Monitor"]);
  });

  it("refuses a value that is not a list of tools rather than dropping it", () => {
    expect(parseProfile("bad", { ...valid, denies: "Monitor" })).toHaveProperty("error");
    expect(parseProfile("bad", { ...valid, denies: [1] })).toHaveProperty("error");
  });

  it("leaves a file that denies nothing with no deny list", () => {
    expect(parsed({})).not.toHaveProperty("disallowedTools");
    expect(parsed({ disallowedTools: [] }).disallowedTools).toEqual([]);
  });
});

describe("the inbox deny on a profile file (CC-558)", () => {
  // Mutation caught: trusting the file, which leaves `inbox --batch --answers` open to a profile that denies approve.
  it.each([
    ["a coordinator that denies the human verbs", { role: "coordinator", disallowedTools: [APPROVE, ENDORSE] }],
    ["a worker that denies only approve", { disallowedTools: ["Write", APPROVE] }],
    ["a worker that denies only endorse", { disallowedTools: [ENDORSE] }],
    ["a file that names approve under the alias", { denies: [APPROVE] }],
  ])("adds it to %s, and says so", (_shape, body) => {
    const profile = parsed(body);

    expect(profile.disallowedTools?.filter((tool) => tool === INBOX)).toEqual([INBOX]);
    expect(profile.warnings).toContainEqual(expect.stringMatching(/fixture\.json.*agent-chat inbox/));
  });

  it("adds nothing to a file that already denies it", () => {
    const profile = parsed({ disallowedTools: [APPROVE, INBOX, ASK] });

    expect(profile.disallowedTools).toEqual([APPROVE, INBOX, ASK]);
    expect(profile).not.toHaveProperty("warnings");
  });

  it("keeps inbox for a profile that allows it by name", () => {
    const profile = parsed({ allowedTools: ["Read", INBOX], disallowedTools: [APPROVE, ENDORSE, ASK] });

    expect(profile.disallowedTools).toEqual([APPROVE, ENDORSE, ASK]);
    expect(profile).not.toHaveProperty("warnings");
  });

  it("leaves a file that denies neither verb alone", () => {
    expect(parsed({ disallowedTools: ["Bash"] }).disallowedTools).toEqual(["Bash"]);
  });
});

describe("the ask deny (CC-169)", () => {
  // Mutation caught: no derived deny, which left every user profile file able to ask.
  it.each([
    ["a worker that denies approve", { disallowedTools: ["Write", APPROVE] }],
    ["a file that names approve under the alias", { denies: [APPROVE] }],
  ])("adds it to %s, and says so", (_shape, body) => {
    const profile = parsed(body);

    expect(profile.disallowedTools?.filter((tool) => tool === ASK)).toEqual([ASK]);
    expect(profile.warnings).toContainEqual(expect.stringMatching(/fixture\.json.*agent-chat ask/));
  });

  it("keeps ask for a profile that allows it by name", () => {
    const profile = parsed({ allowedTools: ["Read", ASK], disallowedTools: [APPROVE, INBOX] });

    expect(profile.disallowedTools).toEqual([APPROVE, INBOX]);
    expect(profile).not.toHaveProperty("warnings");
  });

  it("leaves a file that does not deny approve alone", () => {
    expect(parsed({ disallowedTools: [ENDORSE, INBOX] }).disallowedTools).toEqual([ENDORSE, INBOX]);
  });
});

describe("the teleport deny (CC-951)", () => {
  const SEND = "Bash(agent-chat send:*)";
  const TELEPORT = "Bash(agent-chat teleport:*)";

  // Mutation caught: no derived deny, which left every installed profile file able to run `teleport request` as the human.
  it("adds it to a file that denies send, and says so", () => {
    const profile = parsed({ disallowedTools: ["Write", SEND] });

    expect(profile.disallowedTools?.filter((tool) => tool === TELEPORT)).toEqual([TELEPORT]);
    expect(profile.warnings).toContainEqual(expect.stringMatching(/fixture\.json.*agent-chat teleport/));
  });

  it("leaves a file that denies neither send nor teleport unchanged", () => {
    const profile = parsed({ disallowedTools: ["Write"] });

    expect(profile.disallowedTools).toEqual(["Write"]);
    expect(profile).not.toHaveProperty("warnings");
  });

  it("keeps teleport for a file that allows it by name", () => {
    const profile = parsed({
      allowedTools: ["Read", TELEPORT],
      disallowedTools: [SEND, DEBUG_SEND, BURNDOWN, SEATS],
    });

    expect(profile.disallowedTools).toEqual([SEND, DEBUG_SEND, BURNDOWN, SEATS]);
  });
});

describe("the debug send deny (CC-1083)", () => {
  const SEND = "Bash(agent-chat send:*)";
  const TELEPORT = "Bash(agent-chat teleport:*)";

  // Mutation caught: no derived deny, which left every installed profile able to speak as the human.
  it("adds it to a file that denies send, and says so", () => {
    const profile = parsed({ disallowedTools: [SEND] });

    expect(profile.disallowedTools?.filter((tool) => tool === DEBUG_SEND)).toEqual([DEBUG_SEND]);
    expect(profile.warnings).toContainEqual(expect.stringMatching(/fixture\.json.*agent-chat debug send/));
  });

  // Mutation caught: dropping the allowed-by-name escape for this rule, which overrides a file's explicit grant.
  it("keeps debug send for a file that allows it by name", () => {
    const profile = parsed({
      allowedTools: ["Read", DEBUG_SEND],
      disallowedTools: [SEND, TELEPORT, BURNDOWN, SEATS],
    });

    expect(profile.disallowedTools).toEqual([SEND, TELEPORT, BURNDOWN, SEATS]);
    expect(profile).not.toHaveProperty("warnings");
  });

  // Mutation caught: widening the pattern to `debug:*`, which takes the read-only diagnostics away too.
  it("leaves debug ps and history open", () => {
    const profile = parsed({ disallowedTools: [SEND] });

    expect(profile.disallowedTools).not.toContain("Bash(agent-chat debug:*)");
    expect(profile.disallowedTools?.filter((tool) => tool.startsWith("Bash(agent-chat debug"))).toEqual([DEBUG_SEND]);
  });

  it("leaves a file that does not deny send alone", () => {
    expect(parsed({ disallowedTools: ["Write"] }).disallowedTools).toEqual(["Write"]);
  });
});

describe("the burndown and seats denies (CC-1138)", () => {
  const SEND = "Bash(agent-chat send:*)";

  // Mutation caught: dropping either rule from DERIVED_DENIES, which leaves installed files without it.
  it("adds both to a file that denies only send, with one warning each", () => {
    const profile = parsed({ disallowedTools: [SEND] });

    expect(profile.disallowedTools?.filter((tool) => tool === BURNDOWN || tool === SEATS)).toEqual([BURNDOWN, SEATS]);
    expect(profile.warnings?.filter((w) => w.includes("agent-chat burndown"))).toHaveLength(1);
    expect(profile.warnings?.filter((w) => w.includes("agent-chat seats"))).toHaveLength(1);
  });

  // Mutation caught: dropping the role check, which takes `seats status` and seat ticks from every coordinator.
  it.each([
    ["a coordinator", "coordinator", []],
    ["a worker", "worker", [BURNDOWN, SEATS]],
    ["a file with no role", undefined, [BURNDOWN, SEATS]],
  ])("derives them for %s that denies send only when it is a worker", (_shape, role, expected) => {
    const profile = parsed({ ...(role === undefined ? {} : { role }), disallowedTools: [SEND] });

    expect(profile.disallowedTools?.filter((tool) => tool === BURNDOWN || tool === SEATS)).toEqual(expected);
  });

  // Mutation caught: dropping the prefix escape in `needs`, which takes `burndown release` from a triager-shaped file.
  it("keeps a file that allows burndown release and status those allows", () => {
    const triager = parsed({
      allowedTools: ["Read", "Bash(agent-chat burndown release:*)", "Bash(agent-chat burndown status:*)"],
      disallowedTools: ["Edit", SEND, DEBUG_SEND, APPROVE, ASK, "Bash(agent-chat teleport:*)", SEATS],
    });

    expect(triager.allowedTools).toContain("Bash(agent-chat burndown release:*)");
    expect(triager.disallowedTools).not.toContain(BURNDOWN);
    expect(triager.disallowedTools).toContain(SEATS);
  });

  it("leaves a file that does not deny send alone", () => {
    expect(parsed({ disallowedTools: ["Write"] }).disallowedTools).toEqual(["Write"]);
  });
});
