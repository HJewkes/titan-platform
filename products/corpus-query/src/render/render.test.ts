import { describe, expect, it } from "vitest";
import type { MergedRow } from "../merge/merge.js";
import { renderDiscord, renderMarkdown } from "./render.js";

function mrow(i: number, over: Partial<MergedRow> = {}): MergedRow {
  return {
    entity: `Cup ${i}`,
    subject: "Northgate",
    period: `Season ${Math.floor(i / 10)}`,
    periodInferred: false,
    detail: `3-1 v Town ${i} ${"x".repeat(60)}`,
    role: "manager",
    ref: `XX 1.${i}`,
    quote: "q",
    order: [0, 1, i],
    ...over,
  };
}

const rows = Array.from({ length: 80 }, (_, i) => mrow(i));
const rowLine = (r: MergedRow) => `• ||**${r.entity}** · ${r.detail} · ${r.ref}||`;

describe("renderDiscord", () => {
  it("renders the approved one-line shape under season headings with no blank lines", () => {
    const [first] = renderDiscord([mrow(1, { detail: "3-1 v Crewe", entity: "Shire Cup", ref: "PM 7.15" })], { header: "Honours" });

    expect(first).toBe("Honours\n**Season 0**\n• ||**Shire Cup** · 3-1 v Crewe · PM 7.15||");
  });

  it("keeps every message under 2000 characters and shows every row exactly once", () => {
    const messages = renderDiscord(rows, { header: "Honours" });

    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expect(m.length).toBeLessThan(2000);
    const lines = messages.flatMap((m) => m.split("\n"));
    for (const r of rows) expect(lines.filter((l) => l === rowLine(r))).toHaveLength(1);
  });

  it("splits only on row boundaries and repeats the season heading on a continuation", () => {
    const messages = renderDiscord(rows, { header: "Honours" });

    for (const m of messages) {
      const lines = m.split("\n");
      for (const l of lines) expect(l.startsWith("• ||") ? l.endsWith("||") : true).toBe(true);
      expect(lines.some((l) => l.startsWith("•"))).toBe(true);
    }
    for (const m of messages.slice(1)) expect(m.split("\n")[0]).toMatch(/^\*\*Season \d+\*\*$/);
  });

  it("defuses a spoiler terminator inside a field", () => {
    const [m] = renderDiscord([mrow(1, { detail: "a || b" })], { header: "H" });

    expect(m!.match(/\|\|/g)).toHaveLength(2);
  });

  it("refuses a single row too long for one message", () => {
    expect(() => renderDiscord([mrow(1, { detail: "y".repeat(2500) })], { header: "H" })).toThrow(RangeError);
  });
});

describe("renderMarkdown", () => {
  it("writes a numbered table with the evidence quote and escapes pipes", () => {
    const md = renderMarkdown([mrow(1, { detail: "a | b", quote: "we won" })]);

    expect(md).toContain("| # | Entity | Period | Subject | Role | Ref | Evidence |");
    expect(md).toContain("| 1 | Cup 1 | Season 0 | Northgate — a \\| b | manager | XX 1.1 | we won |");
  });

  it("marks an inferred period", () => {
    expect(renderMarkdown([mrow(1, { periodInferred: true })])).toContain("Season 0 (inferred)");
  });
});
