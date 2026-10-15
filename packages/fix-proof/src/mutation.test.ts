import { describe, expect, it } from "vitest";
import { parseFixProofConfig, type FixProofConfig } from "./config.js";
import { checkMutation, parseMutationSpec, type Mutation } from "./mutation.js";

const repoConfig = parseFixProofConfig(
  JSON.stringify({
    tests: ["{packages,products,apps}/*/src/**/*.test.{ts,tsx}"],
    carry: ["**/fixtures/**", "**/test-support/**", "**/*.test-helpers.ts"],
  }),
);
if (!repoConfig.ok) throw new Error(repoConfig.error);
const config: FixProofConfig = repoConfig.config;

const mutation = (overrides: Partial<Mutation> = {}): Mutation => ({
  name: "skip-resume",
  file: "products/factory/src/serve.ts",
  find: "resume(run)",
  replace: "void run",
  kills: ["serve restart > resumes the run"],
  ...overrides,
});

const spec = (...mutations: unknown[]) => JSON.stringify({ v: 1, mutations });

function refusal(text: string): string {
  const result = parseMutationSpec(text);
  if (result.ok) throw new Error("expected the spec to be refused");
  return result.error;
}

describe("parseMutationSpec", () => {
  it("accepts a spec of named mutations with their kills", () => {
    const result = parseMutationSpec(spec(mutation(), mutation({ name: "drop-deadline", find: "deadline", replace: "0" })));

    expect(result).toEqual({ ok: true, spec: { v: 1, mutations: [mutation(), mutation({ name: "drop-deadline", find: "deadline", replace: "0" })] } });
  });

  it("allows an empty replace, so a mutation can delete code", () => {
    expect(parseMutationSpec(spec(mutation({ replace: "" }))).ok).toBe(true);
  });

  it("refuses a mutation with no kills", () => {
    expect(refusal(spec(mutation({ kills: [] })))).toMatch(/kills must be a non-empty array/);
  });

  it("refuses a kills list that names a test twice", () => {
    expect(refusal(spec(mutation({ kills: ["a > b", "a > b"] })))).toMatch(/names a test twice/);
  });

  it("refuses an empty spec and one over five mutations", () => {
    const six = Array.from({ length: 6 }, (_, index) => mutation({ name: `m${index}` }));

    expect(refusal(spec())).toMatch(/1 to 5 mutations/);
    expect(refusal(spec(...six))).toMatch(/1 to 5 mutations/);
  });

  it("refuses a name over 80 characters and a find or replace over 400", () => {
    expect(refusal(spec(mutation({ name: "n".repeat(81) })))).toMatch(/name is over 80/);
    expect(refusal(spec(mutation({ find: "f".repeat(401) })))).toMatch(/find is over 400/);
    expect(refusal(spec(mutation({ replace: "r".repeat(401) })))).toMatch(/replace is over 400/);
  });

  it("refuses a mutation whose find and replace are the same", () => {
    expect(refusal(spec(mutation({ replace: "resume(run)" })))).toMatch(/find and replace are the same/);
  });

  it("refuses two mutations with one name", () => {
    expect(refusal(spec(mutation(), mutation({ find: "other" })))).toMatch(/skip-resume is used twice/);
  });

  it("refuses a file path that escapes the repo or is not normalized", () => {
    expect(refusal(spec(mutation({ file: "../outside.ts" })))).toMatch(/normalized repo-relative path/);
    expect(refusal(spec(mutation({ file: "./src/x.ts" })))).toMatch(/normalized repo-relative path/);
  });

  it("refuses unknown keys, another version and malformed JSON", () => {
    expect(refusal(JSON.stringify({ v: 1, mutations: [mutation()], note: "x" }))).toMatch(/unknown key note/);
    expect(refusal(spec({ ...mutation(), weight: 2 }))).toMatch(/unknown key weight/);
    expect(refusal(JSON.stringify({ v: 2, mutations: [mutation()] }))).toMatch(/v must be 1/);
    expect(refusal("{")).toMatch(/^mutation spec: /);
  });
});

describe("checkMutation", () => {
  const base = "export function restart(run) {\n  resume(run);\n}\n";

  it("accepts a find that occurs exactly once in a non-test file at the merge base", () => {
    expect(checkMutation(mutation(), base, config)).toEqual({ ok: true });
  });

  it("refuses a find that occurs twice in the base file", () => {
    const twice = `${base}${base}`;

    expect(checkMutation(mutation(), twice, config)).toEqual({
      ok: false,
      error: "mutation skip-resume: find occurs more than once in products/factory/src/serve.ts at the merge base",
    });
  });

  it("counts overlapping occurrences of the find", () => {
    expect(checkMutation(mutation({ find: "aa", replace: "b" }), "aaa", config).ok).toBe(false);
  });

  it("refuses a find that does not occur and a file missing at the merge base", () => {
    expect(checkMutation(mutation({ find: "absent" }), base, config)).toMatchObject({ ok: false, error: expect.stringMatching(/does not occur/) });
    expect(checkMutation(mutation(), null, config)).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist at the merge base/) });
  });

  it("refuses a target that is a test or a carried file", () => {
    const onTest = checkMutation(mutation({ file: "products/factory/src/serve.test.ts" }), base, config);
    const onCarry = checkMutation(mutation({ file: "products/factory/src/test-support/serve-child.ts" }), base, config);

    expect(onTest).toMatchObject({ ok: false, error: expect.stringMatching(/is a test$/) });
    expect(onCarry).toMatchObject({ ok: false, error: expect.stringMatching(/is a carried test-support file$/) });
  });

  it("refuses a target that is a harness path, a mutation spec or a changeset", () => {
    const targets = [".github/workflows/fix-proof.yml", "scripts/fix-proof-run.sh", "src/serve.test.mutations.json", ".changeset/z8.md"];

    targets.forEach((file) => expect(checkMutation(mutation({ file }), base, config).ok).toBe(false));
  });
});
