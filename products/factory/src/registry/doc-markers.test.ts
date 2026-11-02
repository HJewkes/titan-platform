import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_REVIEW_STEP_IDS } from "@titan-design/review-workflow";
import { describe, expect, it } from "vitest";
import { factoryWorkflows } from "../workflows.js";
import { lintDocMarkers, markedRows, type RecipeDoc } from "./doc-markers.js";
import { createRegistry } from "./registry.js";
import { factoryRegistry } from "./steps/index.js";
import { step } from "./steps/helpers.js";

const registry = createRegistry([
  step("sh-review", "dispatch", "AGENT", { class: "read" }),
  step("approve-merge", "assisted", "OWNER", { class: "read" }),
  step("snapshot", "seed", "software", { class: "read" }),
]);

const doc = (rows: string, stepIds = ["sh-review", "approve-merge", "snapshot"]): RecipeDoc => ({
  path: "demo.md",
  text: `# Demo\n\n## Steps\n\n| Step | Marker |\n| --- | --- |\n${rows}\n\n## After\n\nmentions \`approve-merge\` in prose.\n`,
  stepIds,
});

const SITE = new URL("../../../../site/guides/", import.meta.url);
const WORKFLOWS = (...names: string[]): string[] => factoryWorkflows.filter((workflow) => names.includes(workflow.name)).flatMap((workflow) => workflow.steps.map((declared) => declared.id));

describe("doc markers", () => {
  it("a doc marking an AGENT step OWNER fails", () => {
    const problems = lintDocMarkers([doc("| `sh-review` | OWNER |\n| `approve-merge` | OWNER |")], registry);

    expect(problems).toEqual(['demo.md: row "sh-review" is marked OWNER, but the registry says AGENT']);
  });

  it("an OWNER step missing from its recipe doc's table fails, and a mention elsewhere does not count", () => {
    const problems = lintDocMarkers([doc("| `sh-review` | AGENT |")], registry);

    expect(problems).toEqual(['demo.md: OWNER step "approve-merge" is missing from the Steps table']);
  });

  it("a row naming no registered step fails, and a software step needs no row", () => {
    const problems = lintDocMarkers([doc("| `sh-review` | AGENT |\n| `approve-merge` | OWNER |\n| `invented` | AGENT |")], registry);

    expect(problems).toEqual(['demo.md: row "invented" is not a registered step']);
    expect(markedRows(doc("| `snapshot` | |").text).size).toBe(0);
  });

  it("the factory recipe docs match the registry", () => {
    const docs: RecipeDoc[] = [
      { path: "factory.md", text: readFileSync(fileURLToPath(new URL("factory.md", SITE)), "utf8"), stepIds: WORKFLOWS("land-pr") },
      { path: "shepherd.md", text: readFileSync(fileURLToPath(new URL("shepherd.md", SITE)), "utf8"), stepIds: WORKFLOWS("shepherd-pr") },
    ];

    expect(lintDocMarkers(docs, factoryRegistry)).toEqual([]);
    expect(docs.every((recipe) => markedRows(recipe.text).size > 0)).toBe(true);
  });

  it("the review-workflow README marks exactly the recipe's agent steps", () => {
    const readme = readFileSync(fileURLToPath(new URL("../../../../packages/review-workflow/README.md", import.meta.url)), "utf8");
    const { dispatch, await: awaited, correct, lateRead, fixer } = DEFAULT_REVIEW_STEP_IDS;

    expect([...markedRows(readme)].sort()).toEqual([dispatch, awaited, correct, lateRead, fixer].sort().map((id) => [id, "AGENT"]));
  });
});
