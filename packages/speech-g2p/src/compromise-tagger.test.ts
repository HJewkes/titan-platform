import { describe, expect, it } from "vitest";
import { compromiseTagger } from "./compromise-tagger.js";
import type { RawToken } from "./types.js";

/** Splits on spaces and peels off clitics and edge punctuation the way spaCy would, for synthetic sentences. */
function tokenize(text: string): RawToken[] {
  const out: RawToken[] = [];
  const re = /\S+/g;
  for (const m of text.matchAll(re)) {
    let rest = m[0];
    let idx = m.index;
    const pieces: string[] = [];
    const trail = /[.,?!]$/.exec(rest);
    if (trail) rest = rest.slice(0, -1);
    const lower = rest.toLowerCase();
    if (lower === "cannot") pieces.push(rest.slice(0, 3), rest.slice(3));
    else if (lower.endsWith("n't"))
      pieces.push(rest.slice(0, -3), rest.slice(-3));
    else pieces.push(rest);
    if (trail) pieces.push(trail[0]);
    for (const [k, text] of pieces.entries()) {
      const end = idx + text.length;
      const last = k === pieces.length - 1;
      out.push({ text, idx, whitespace: last ? " " : "" });
      idx = end;
    }
  }
  return out;
}

function tags(text: string): Record<string, string | undefined> {
  const toks = tokenize(text);
  const penn = compromiseTagger().tag(text, toks);
  return Object.fromEntries(toks.map((t, i) => [t.text, penn[i]]));
}

describe("compromiseTagger", () => {
  it("tags a verb after a modal and a negation as the base form", () => {
    expect(tags("It cannot read a file.").read).toBe("VB");
  });

  it("looks back past n't and an adverb to the do-form", () => {
    expect(tags("We didn't really read it.").read).toBe("VB");
  });

  it("tags used before to as past tense", () => {
    expect(tags("We used to ship weekly.").used).toBe("VBD");
  });

  it("maps punctuation and the infinitive marker", () => {
    const t = tags("We want to go, now.");
    expect(t.to).toBe("TO");
    expect(t[","]).toBe(",");
    expect(t["."]).toBe(".");
  });

  it("returns one tag per token", () => {
    const text = "The cats sleep.";
    expect(compromiseTagger().tag(text, tokenize(text))).toHaveLength(4);
  });
});
