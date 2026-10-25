import { describe, expect, it } from "vitest";
import { resolvedFor, soloScript } from "../template-fill/fill-fixtures.test-helpers.js";
import { sha256 } from "../workflow/artifacts.js";
import { leadLineBeats } from "./qa-lead-lines.js";

/** An in-memory store over named JSON artifacts. */
function input(named: Record<string, unknown>) {
  const texts = Object.entries(named).map(([name, value]) => [name, JSON.stringify(value)] as const);
  const bySha = new Map(texts.map(([, text]) => [sha256(text), text]));
  const artifacts = Object.fromEntries(texts.map(([name, text]) => [name, sha256(text)]));
  return { artifacts, store: { readText: (sha: string) => bySha.get(sha)! } };
}

function inProcess(visual: Record<string, unknown>) {
  const script = soloScript(visual);
  return input({ script, resolved: { schema: "explainer.resolved/v1", profile: script.profile, beats: resolvedFor(script).beats, budgets: [] } });
}

describe("qa lead-line beats", () => {
  it("reads qaLeadLine off a bridged render's visual", () => {
    const bridged = input({ visual: { beats: [{ id: "b1-verdict", qaLeadLine: true }, { id: "b2-list" }] } });

    expect([...leadLineBeats(bridged)]).toEqual(["b1-verdict"]);
  });

  it("takes an in-process verdict card's lead line from the template fill's hints", () => {
    const verdict = inProcess({ beat: "verdict-card", labels: ["Ship it: lanes hold", "Scans clear in minutes"] });

    expect([...leadLineBeats(verdict)]).toEqual(["s1"]);
  });

  it("exempts no beat the fill drew as a plain list", () => {
    const list = inProcess({ beat: "list", labels: ["tick Two lanes"] });

    expect([...leadLineBeats(list)]).toEqual([]);
  });
});
