import { describe, expect, it } from "vitest";
import type { AncestryProbe } from "../build-ancestry.js";
import { UNKNOWN_BUILD_SHA } from "../build-info.js";
import { linkIncidents } from "./audit-incidents.js";

const [A, B, C, D] = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(40)];
const MISSING = "e".repeat(40);
const PARENT: Record<string, string | undefined> = { [A]: undefined, [B]: A, [C]: B, [D]: C };
const AT = "2026-10-06T17:00:00.000Z";

/** Answers ancestry over the linear history A <- B <- C <- D; a sha outside it is a missing object. */
const historyProbe: AncestryProbe = async (ancestor, descendant) => {
  if (!(ancestor in PARENT) || !(descendant in PARENT)) return { unknown: "fatal: not a valid object name" };
  for (let sha: string | undefined = descendant; sha !== undefined; sha = PARENT[sha]) if (sha === ancestor) return true;
  return false;
};

const incident = (target: string, from: string) => ({ at: AT, target, from });

describe("linkIncidents", () => {
  it("links an incident whose target is the merge", async () => {
    const atMerge = incident(B, A);

    const links = await linkIncidents([atMerge], [B], historyProbe);

    expect(links.get(B)).toEqual([atMerge]);
  });

  it("links an incident whose target descends from the merge and whose from does not", async () => {
    const ahead = incident(D, A);

    const links = await linkIncidents([ahead], [B], historyProbe);

    expect(links.get(B)).toEqual([ahead]);
  });

  it("does not link a later rollout whose from already contains the merge", async () => {
    const later = incident(D, C);

    const links = await linkIncidents([later], [B], historyProbe);

    expect(links.get(B)).toEqual([]);
  });

  it("maps the merge to unknown when the probe cannot answer", async () => {
    const unreadable = incident(MISSING, A);

    const links = await linkIncidents([incident(D, C), unreadable], [B], historyProbe);

    expect(links.get(B)).toBe("unknown");
  });

  it("links an incident whose from build is unknown to every merge its target contains", async () => {
    const fromUnknown = incident(C, UNKNOWN_BUILD_SHA);

    const links = await linkIncidents([fromUnknown], [B, C, D], historyProbe);

    expect([...links]).toEqual([
      [B, [fromUnknown]],
      [C, [fromUnknown]],
      [D, []],
    ]);
  });
});
