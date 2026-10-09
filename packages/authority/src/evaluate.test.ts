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
  "DSR-DC", "DSL-DC", "DSX-DC", "SPN-DC", "SPD-DC", "CFG-DC", "HV-DC",
  "ANS-OT", "ANS-OR", "ANS-CO", "ANS-WK", "ANS-HD", "ANS-AU", "ANS-DC",
];

const ACTION_CODES: Record<string, ActionClass> = {
  MRG: "merge", REL: "release", SEC: "secret-read", UNT: "untrusted-ingest", PUB: "private-to-public", EXT: "private-egress",
  HW: "hardware-actuate", HWS: "hardware-stop", DSR: "destructive-remote", DSL: "destructive-local", DSX: "destructive-foreign",
  SPN: "spawn", SPD: "spend-over-cap", CFG: "authority-config", HV: "human-verb", ANS: "answer-question",
};
const ACTOR_CODES: Record<string, ActorClass> = {
  OT: "owner-terminal", OR: "owner-remote", CO: "coordinator", WK: "worker", HD: "headless", AU: "automation", DC: "decider",
};

function request(action: ActionClass, actor: ActorClass, tainted = false): AuthorityRequest {
  return { action, actor: { class: actor, id: `${actor}-1` }, tainted, subject: {} };
}

function requestFor(ruleId: string): AuthorityRequest {
  const [actionCode = "", actorCode = ""] = ruleId.split("-");
  return request(ACTION_CODES[actionCode] as ActionClass, ACTOR_CODES[actorCode] as ActorClass);
}

describe("the approved table", () => {
  it("holds 44 allow, 6 gate and 66 deny rows", () => {
    const count = (verdict: string) => DEFAULT_TABLE.rules.filter((rule) => rule.verdict === verdict).length;
    expect({ allow: count("allow"), gate: count("gate"), deny: count("deny") }).toEqual({ allow: 44, gate: 6, deny: 66 });
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

describe("evaluate", () => {
  it("denies an action no rule names, with no rule id", () => {
    const unknown = request("teleport" as ActionClass, "owner-terminal");
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
    const request = { action: "merge", actor, tainted: false, subject: {} } as unknown as AuthorityRequest;
    const decision = evaluate(DEFAULT_TABLE, request);
    expect(decision.verdict).toBe("deny");
  });
});

describe("evaluate with a polluted Object.prototype.class", () => {
  it("denies an actor that does not own a class instead of reading the inherited one", () => {
    Object.defineProperty(Object.prototype, "class", { value: "owner-terminal", configurable: true });
    try {
      const polluted = { action: "merge", actor: { id: "a1" }, tainted: false, subject: {} } as unknown as AuthorityRequest;
      expect(evaluate(DEFAULT_TABLE, polluted)).toMatchObject({ verdict: "deny", ruleId: null });
    } finally {
      delete (Object.prototype as { class?: unknown }).class;
    }
  });
});
