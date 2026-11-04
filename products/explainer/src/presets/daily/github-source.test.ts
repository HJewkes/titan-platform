import { describe, expect, it } from "vitest";
import { fakeGh, REPO } from "./daily-fakes.test-helpers.js";
import { prOutcome, prPackages, pullRequestItems } from "./github-source.js";

const URL = "https://github.com/acme/widgets/pull/";
const merged = {
  number: 7,
  title: "Add the widget cache",
  url: `${URL}7`,
  createdAt: "2030-01-02T09:00:00Z",
  mergedAt: "2030-01-02T12:00:00Z",
  headRefName: "agent-chat/ab-widget-cache",
  body: "## Summary\n\nAdds a cache to the widget loader. Misses fall through.\n\n## Test plan\n\n- ran it",
  files: [{ path: "packages/cache/src/index.ts" }, { path: "packages/cache/src/lru.ts" }, { path: ".changeset/cache.md" }],
  additions: 30,
  deletions: 4,
};
const opened = { ...merged, mergedAt: null };

const rows = { "created:2030-01-02": [merged, opened], "merged:2030-01-02": [merged] };

describe("pullRequestItems", () => {
  it("keeps one merged item with its outcome, packages and size when the PR also opened that day", async () => {
    const { items } = await pullRequestItems(fakeGh(rows), [REPO], "2030-01-02");

    expect(items.map((item) => item.id)).toEqual([`pr/${REPO}#7/merged`]);
    expect(items[0]).toMatchObject({
      branch: "agent-chat/ab-widget-cache",
      outcome: "Adds a cache to the widget loader.",
      packages: ["packages/cache"],
      size: 34,
      priority: "P1",
    });
  });

  it("keeps an opened PR that has not merged", async () => {
    const open = { ...opened, number: 8, url: `${URL}8` };

    const { items } = await pullRequestItems(fakeGh({ "created:2030-01-02": [open] }), [REPO], "2030-01-02");

    expect(items.map((item) => item.id)).toEqual([`pr/${REPO}#8/opened`]);
    expect(items[0]?.outcome).toBeUndefined();
  });

  it("asks gh for the fields the merged item needs", async () => {
    const gh = fakeGh(rows);

    await pullRequestItems(gh, [REPO], "2030-01-02");

    expect(gh.calls[0]?.[gh.calls[0].indexOf("--json") + 1]).toBe("number,title,url,createdAt,mergedAt,headRefName,body,files,additions,deletions");
  });
});

describe("prOutcome", () => {
  it("skips headings, comments and list items to the first prose sentence", () => {
    expect(prOutcome("<!-- note -->\n# Title\n- item\n\nFixes the loader. Then more.", "T")).toBe("Fixes the loader.");
  });

  it("falls back to the title when the body has no prose or the sentence runs long", () => {
    expect(prOutcome("## Only a heading", "The title")).toBe("The title");
    expect(prOutcome(`${"word ".repeat(60)}end.`, "The title")).toBe("The title");
    expect(prOutcome(null, "The title")).toBe("The title");
  });
});

describe("prPackages", () => {
  it("names the top two path segments once each and leaves changesets out", () => {
    expect(prPackages([{ path: "packages/b/x.ts" }, { path: "packages/a/y.ts" }, { path: "packages/a/z.ts" }, { path: ".changeset/c.md" }, { path: "README.md" }])).toEqual(["README.md", "packages/a", "packages/b"]);
  });
});
