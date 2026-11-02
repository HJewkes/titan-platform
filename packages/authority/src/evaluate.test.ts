import { describe, expect, it } from "vitest";
import type { AuthorityRequest } from "./evaluate.js";
import { canResolve, evaluate } from "./evaluate.js";
import { DEFAULT_TABLE } from "./table.js";
import type { ActionClass, ActorClass } from "./vocabulary.js";
import { ACTION_CLASSES, ACTOR_CLASSES } from "./vocabulary.js";

// Hand-written on purpose: a row silently flipped in table.json must fail here, not be regenerated.
const DENY_RULE_IDS = [
  "MRG-WK", "MRG-HD",
  "REL-OR", "REL-WK", "REL-HD",
  "SEC-OR", "SEC-CO", "SEC-WK", "SEC-HD",
  "PUB-OR", "PUB-CO", "PUB-WK", "PUB-HD", "PUB-AU",
  "EXT-CO", "EXT-WK", "EXT-HD",
  "HW-OR", "HW-WK", "HW-HD", "HW-AU",
  "DSR-OR", "DSR-CO", "DSR-WK", "DSR-HD", "DSR-AU",
  "DSL-OR",
  "DSX-OR", "DSX-CO", "DSX-WK", "DSX-HD", "DSX-AU",
  "SPN-WK", "SPN-HD",
  "SPD-OR",
  "CFG-OR", "CFG-CO", "CFG-WK", "CFG-HD", "CFG-AU",
  "HV-CO", "HV-WK", "HV-HD", "HV-AU",
  "MRG-DC", "REL-DC", "SEC-DC", "UNT-DC", "PUB-DC", "EXT-DC", "HW-DC", "HWS-DC",
  "DSR-DC", "DSL-DC", "RET-DC", "DSX-DC", "SPN-DC", "SPD-DC", "CFG-DC", "HV-DC",
  "ANS-OT", "ANS-OR", "ANS-CO", "ANS-WK", "ANS-HD", "ANS-AU", "ANS-DC",
  "PRC-CO", "PRC-WK", "PRC-HD", "PRC-AU", "PRC-DC",
  "DPR-CO", "DPR-WK", "DPR-HD", "DPR-AU", "DPR-DC",
  "FLC-CO", "FLC-WK", "FLC-HD", "FLC-AU", "FLC-DC",
];

const ACTION_CODES: Record<string, ActionClass> = {
  MRG: "merge", REL: "release", SEC: "secret-read", UNT: "untrusted-ingest", PUB: "private-to-public", EXT: "private-egress",
  HW: "hardware-actuate", HWS: "hardware-stop", DSR: "destructive-remote", DSL: "destructive-local", RET: "agent-retire", DSX: "destructive-foreign",
  SPN: "spawn", SPD: "spend-over-cap", CFG: "authority-config", HV: "human-verb", ANS: "answer-question",
  PRC: "pr-close", DPR: "deploy-resume", FLC: "fleet-config",
};
const ACTOR_CODES: Record<string, ActorClass> = {
  OT: "owner-terminal", OR: "owner-remote", CO: "coordinator", WK: "worker", HD: "headless", AU: "automation", DC: "decider",
};

function request(action: ActionClass, actor: ActorClass, tainted = false): AuthorityRequest {
  return { action, actor: { class: actor, id: `${actor}-1` }, tainted, subject: {} };
}

function requestFor(ruleId: string): AuthorityRequest {
  const [actionCode = "", actorCode = ""] = ruleId.split("-");
  const action = ACTION_CODES[actionCode];
  const actor = ACTOR_CODES[actorCode];
  if (action === undefined || actor === undefined) throw new Error(`unknown rule id ${ruleId}`);
  return request(action, actor);
}

describe("the approved table", () => {
  it("holds 54 allow, 9 gate and 82 deny rows", () => {
    const count = (verdict: string) => DEFAULT_TABLE.rules.filter((rule) => rule.verdict === verdict).length;
    expect({ allow: count("allow"), gate: count("gate"), deny: count("deny") }).toEqual({ allow: 54, gate: 9, deny: 82 });
  });

  // Kills: retire-agent riding destructive-local's DSL-OR deny, or RET-OR flipped to gate or deny.
  it("lets the owner retire an agent from the console while other local destruction stays denied there", () => {
    expect(evaluate(DEFAULT_TABLE, request("agent-retire", "owner-remote"))).toEqual({ verdict: "allow", ruleId: "RET-OR" });
    expect(evaluate(DEFAULT_TABLE, request("destructive-local", "owner-remote"))).toMatchObject({ verdict: "deny", ruleId: "DSL-OR" });
  });

  // Kills: a RET row for any actor but owner-remote drifting from the destructive-local policy it replaced.
  it("gives every other actor the same retire policy destructive-local gave it", () => {
    const shape = (id: string) => {
      const { verdict, condition, evidence } = DEFAULT_TABLE.rules.find((rule) => rule.id === id)!;
      return { verdict, condition, evidence };
    };
    for (const actor of ["OT", "CO", "WK", "HD", "AU", "DC"]) expect(shape(`RET-${actor}`)).toEqual(shape(`DSL-${actor}`));
  });

  it("denies exactly the hand-listed rows", () => {
    const denied = DEFAULT_TABLE.rules.filter((rule) => rule.verdict === "deny").map((rule) => rule.id);
    expect(denied.sort()).toEqual([...DENY_RULE_IDS].sort());
  });

  it.each(DENY_RULE_IDS)("refuses %s", (ruleId) => {
    expect(evaluate(DEFAULT_TABLE, requestFor(ruleId))).toMatchObject({ verdict: "deny", ruleId });
  });

  it("lets every actor but the decider stop hardware and lets no rule stop a run for spend", () => {
    for (const actor of ACTOR_CLASSES.filter((candidate) => candidate !== "decider")) expect(evaluate(DEFAULT_TABLE, request("hardware-stop", actor)).verdict).toBe("allow");
    for (const actor of ["coordinator", "worker", "headless", "automation"] as const) {
      expect(evaluate(DEFAULT_TABLE, request("spend-over-cap", actor)).verdict).toBe("allow");
    }
  });
});

describe("the console owner-op rows", () => {
  const OWNER_OP_ACTIONS = ["pr-close", "deploy-resume", "fleet-config"] as const;
  const SEATS = ["coordinator", "worker", "headless", "automation", "decider"] as const;

  it.each(OWNER_OP_ACTIONS)("gates %s by owner-remote on the owner-remote tap alone", (action) => {
    expect(evaluate(DEFAULT_TABLE, request(action, "owner-remote"))).toMatchObject({ verdict: "gate", resolvers: ["owner-remote"] });
  });

  it.each(OWNER_OP_ACTIONS)("allows %s by the owner at a terminal", (action) => {
    expect(evaluate(DEFAULT_TABLE, request(action, "owner-terminal")).verdict).toBe("allow");
  });

  it.each(OWNER_OP_ACTIONS)("refuses %s to every seat, tainted or not", (action) => {
    const verdicts = SEATS.flatMap((actor) => [false, true].map((tainted) => evaluate(DEFAULT_TABLE, request(action, actor, tainted)).verdict));
    expect(verdicts).toEqual(Array(SEATS.length * 2).fill("deny"));
  });

  it("never lets a seat resolve an owner-op gate", () => {
    for (const ruleId of ["PRC-OR", "DPR-OR", "FLC-OR"]) {
      expect(canResolve(DEFAULT_TABLE, ruleId, { class: "owner-remote", tainted: false })).toBe(true);
      for (const actor of SEATS) expect(canResolve(DEFAULT_TABLE, ruleId, { class: actor, tainted: false })).toBe(false);
    }
  });
});

describe("evaluate", () => {
  it("denies an action no rule names, with no rule id", () => {
    const unknown = request("merge", "owner-terminal");
    Reflect.set(unknown, "action", "teleport");
    expect(evaluate(DEFAULT_TABLE, unknown)).toMatchObject({ verdict: "deny", ruleId: null });
  });

  it("gates a coordinator merge on the owner at a terminal or remote", () => {
    expect(evaluate(DEFAULT_TABLE, request("merge", "coordinator"))).toMatchObject({
      verdict: "gate", ruleId: "MRG-CO", resolvers: ["owner-terminal", "owner-remote"],
    });
  });

  it("escalates a tainted coordinator's spawn to a gate only the owner at a terminal resolves", () => {
    expect(evaluate(DEFAULT_TABLE, request("spawn", "coordinator"))).toEqual({ verdict: "allow", ruleId: "SPN-CO" });
    expect(evaluate(DEFAULT_TABLE, request("spawn", "coordinator", true))).toMatchObject({
      verdict: "gate", ruleId: "SPN-CO", resolvers: ["owner-terminal"],
    });
  });

  it("changes no verdict for taint except a coordinator's spawn", () => {
    const changed = ACTION_CLASSES.flatMap((action) =>
      ACTOR_CLASSES.filter((actor) => evaluate(DEFAULT_TABLE, request(action, actor)).verdict !== evaluate(DEFAULT_TABLE, request(action, actor, true)).verdict)
        .map((actor) => `${action} by ${actor}`),
    );
    expect(changed).toEqual(["spawn by coordinator"]);
  });

  it("returns the same decision for the same input", () => {
    const input = request("release", "coordinator");
    expect(evaluate(DEFAULT_TABLE, input)).toEqual(evaluate(DEFAULT_TABLE, input));
  });
});

describe("canResolve", () => {
  it("lets a listed owner class resolve a gate", () => {
    expect(canResolve(DEFAULT_TABLE, "MRG-CO", { class: "owner-remote", tainted: false })).toBe(true);
    expect(canResolve(DEFAULT_TABLE, "MRG-CO", { class: "owner-terminal", tainted: false })).toBe(true);
  });

  it("refuses an owner class the rule does not list", () => {
    expect(canResolve(DEFAULT_TABLE, "REL-CO", { class: "owner-remote", tainted: false })).toBe(false);
  });

  it.each(["coordinator", "worker", "headless", "automation"] as const)("never lets a %s resolve", (actor) => {
    expect(canResolve(DEFAULT_TABLE, "MRG-CO", { class: actor, tainted: false })).toBe(false);
  });

  it("never lets a tainted session resolve", () => {
    expect(canResolve(DEFAULT_TABLE, "MRG-CO", { class: "owner-terminal", tainted: true })).toBe(false);
  });

  it("limits a taint-escalated spawn gate to the owner at a terminal", () => {
    expect(canResolve(DEFAULT_TABLE, "SPN-CO", { class: "owner-terminal", tainted: false })).toBe(true);
    expect(canResolve(DEFAULT_TABLE, "SPN-CO", { class: "owner-remote", tainted: false })).toBe(false);
  });

  it("refuses a deny rule and an unknown rule id", () => {
    expect(canResolve(DEFAULT_TABLE, "MRG-WK", { class: "owner-terminal", tainted: false })).toBe(false);
    expect(canResolve(DEFAULT_TABLE, "NOPE-OT", { class: "owner-terminal", tainted: false })).toBe(false);
  });
});

describe("evaluate with a malformed actor", () => {
  const malformed: Array<[string, unknown]> = [
    ["a missing actor", undefined],
    ["a null actor", null],
    ["a non-object actor", "worker"],
    ["an actor with no class", { id: "a1" }],
    ["an actor with a null class", { class: null, id: "a1" }],
    ["an actor with an unknown class", { class: "root", id: "a1" }],
    ["an actor whose class names an inherited property", { class: "constructor", id: "a1" }],
  ];

  it.each(malformed)("denies %s instead of throwing", (_name, actor) => {
    const malformed = request("merge", "owner-terminal");
    Reflect.set(malformed, "actor", actor);
    const decision = evaluate(DEFAULT_TABLE, malformed);
    expect(decision.verdict).toBe("deny");
  });
});

describe("evaluate with a polluted Object.prototype.class", () => {
  it("denies an actor that does not own a class instead of reading the inherited one", () => {
    Object.defineProperty(Object.prototype, "class", { value: "owner-terminal", configurable: true });
    try {
      const polluted = request("merge", "owner-terminal");
      Reflect.set(polluted, "actor", { id: "a1" });
      expect(evaluate(DEFAULT_TABLE, polluted)).toMatchObject({ verdict: "deny", ruleId: null });
    } finally {
      delete (Object.prototype as { class?: unknown }).class;
    }
  });
});
