import { describe, expect, it } from "vitest";
import { cliRetriever, keyword } from "./digest-retrieval.js";
import type { ScoreCard } from "./score-card.js";

const CARD: ScoreCard = {
  actionable: 4,
  novelty: 3,
  evidence: 3,
  pain_points: ["load"],
  summary: "A synthetic talk.",
  techniques: [{ ts: "01:05", what: "Queue workers through a spool directory." }],
  caveat: "",
};

const envelope = (hits: unknown[]) => JSON.stringify({ data: { hits } });

describe("cli retriever", () => {
  it("queries corpus-query per technique and active-work once with --json, keeping only task hits", async () => {
    const seen: string[][] = [];
    const exec = async (file: string, args: string[]) => {
      seen.push([file, ...args]);
      if (file === "corpus-query") return "vidAAAAAAAA | p1-2 | passage\n";
      return envelope([{ class: "notes", ref: "note:x", title: "N" }, { class: "tasks", ref: "task:TP-100", title: "First task" }]);
    };

    const r = await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD);

    expect(r).toEqual({ priorDigests: ["vidAAAAAAAA | p1-2 | passage"], tasks: [{ id: "TP-100", title: "First task" }] });
    expect(seen[0]).toEqual(["corpus-query", "hits", "/corpus", "--phrase", "directory", "--window", "1"]);
    expect(seen[1]).toEqual(["active-work", "search", "directory", "--limit", "20", "--json"]);
  });

  it("keeps task hits when another hit has a null title", async () => {
    const exec = async (file: string) =>
      file === "corpus-query" ? "" : envelope([{ class: "notes", ref: "note:y", title: null }, { class: "tasks", ref: "task:TP-100", title: "First task" }]);

    const r = await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD);

    expect(r.tasks).toEqual([{ id: "TP-100", title: "First task" }]);
  });

  it("returns no tasks when active-work prints something that is not the envelope", async () => {
    const exec = async (file: string) => (file === "corpus-query" ? "" : "plain text output");

    expect((await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD)).tasks).toEqual([]);
  });

  it("degrades to empty retrieval when both CLIs fail", async () => {
    const exec = async () => {
      throw new Error("not installed");
    };

    expect(await cliRetriever({ exec, corpusRoot: "/corpus" })(CARD)).toEqual({ priorDigests: [], tasks: [] });
  });

  it("picks the longest non-stop word as the keyword", () => {
    expect(keyword("Use the spool directory")).toBe("directory");
    expect(keyword("a b")).toBeUndefined();
  });
});
