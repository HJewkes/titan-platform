import { describe, expect, it } from "vitest";
import { fakeGitHub, fakeSha } from "./fake.js";
import { PR_FILES_CAP, githubPort } from "./port.js";
import { formatPrContext, prContext } from "./pr-context.js";

function setup() {
  const fake = fakeGitHub();
  const head = fakeSha("head");
  const pr = fake.addPr({ headSha: head });
  return { fake, head, pr, port: githubPort(fake.wire) };
}

describe("titan-gh pr-context", () => {
  it("prints the title, base, head, changed files and body", async () => {
    const { fake, head, pr, port } = setup();
    fake.squashSources.set(pr.number, { title: "Add the widget", body: "Adds the widget.", commits: [] });
    fake.prFiles.set(pr.number, [
      { path: "src/widget.ts", status: "added", additions: 10, deletions: 0 },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
    ]);

    const text = formatPrContext(await prContext(port, "o/r", pr.number));

    expect(text).toBe(
      ["o/r#1 Add the widget", "base: main", `head: ${head}`, "files (2):", "  added src/widget.ts +10 -0", "  renamed src/old.ts -> src/new.ts", "", "Adds the widget."].join("\n"),
    );
  });

  it("says so when the PR has no body", async () => {
    const { fake, pr, port } = setup();
    fake.squashSources.set(pr.number, { title: "Empty", body: "", commits: [] });

    const text = formatPrContext(await prContext(port, "o/r", pr.number));

    expect(text.endsWith("files (0):\n\n(no body)")).toBe(true);
  });

  it("lists no files and gives the count when the list is past GitHub's cap", async () => {
    const { fake, pr, port } = setup();
    fake.prFiles.set(pr.number, Array.from({ length: PR_FILES_CAP + 1 }, (_, i) => ({ path: `f${i}.ts`, status: "added" })));

    const context = await prContext(port, "o/r", pr.number);

    expect(context).toMatchObject({ files: [], truncated: { changedFiles: PR_FILES_CAP + 1 } });
    expect(formatPrContext(context)).toContain(`files: ${PR_FILES_CAP + 1} changed, past GitHub's ${PR_FILES_CAP}-file list cap, so none are listed`);
  });
});
