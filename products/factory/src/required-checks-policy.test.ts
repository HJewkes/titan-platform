import { FakeHttpError, fakeGitHub, githubPort, type FakeGitHub } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { checksDrift, readChecksPolicy, type ChecksDrift, type ChecksPolicyRead } from "./required-checks-policy.js";

const REPO = "octo/demo";
const PATH = ".github/required-checks.json";

function worldWith(content: string | null): FakeGitHub {
  const fake = fakeGitHub({ repo: REPO });
  if (content !== null) fake.files.set(`main:${PATH}`, { content, blobSha: "blob-1" });
  return fake;
}

const read = (fake: FakeGitHub) => readChecksPolicy(githubPort(fake.wire), REPO, "main");
const policy = (branches: unknown, extra: object = {}) => JSON.stringify({ version: 1, branches, ...extra });

describe("readChecksPolicy", () => {
  it("reads the contexts listed for the base branch", async () => {
    const fake = worldWith(policy({ main: { contexts: ["validate", "dag-check"] } }));

    expect(await read(fake)).toEqual({ readable: true, contexts: ["validate", "dag-check"] });
  });

  it("reads unreadable, naming the path, when the file is absent at the base ref", async () => {
    const fake = worldWith(null);

    const result: ChecksPolicyRead = await read(fake);

    expect(result.readable).toBe(false);
    expect(!result.readable && result.reason).toContain(PATH);
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["an unknown top-level key", policy({ main: { contexts: ["validate"] } }, { strict: true })],
    ["an unknown branch key", policy({ main: { contexts: ["validate"], strict: true } })],
    ["a wrong version", JSON.stringify({ version: 2, branches: { main: { contexts: ["validate"] } } })],
    ["a branch the file does not list", policy({ develop: { contexts: ["validate"] } })],
    ["an empty branch map", policy({})],
    ["an empty contexts list", policy({ main: { contexts: [] } })],
    ["an empty-string context", policy({ main: { contexts: [""] } })],
    ["a whitespace-only context", policy({ main: { contexts: ["  "] } })],
    ["a blank context beside a real one", policy({ main: { contexts: ["validate", " "] } })],
    ["a non-string context", policy({ main: { contexts: [1] } })],
    ["a branch entry with no contexts key", policy({ main: {} })],
  ])("reads unreadable for %s", async (_name, content) => {
    const fake = worldWith(content);

    expect((await read(fake)).readable).toBe(false);
  });

  it("reads unreadable with the HTTP status only when getFile fails", async () => {
    const fake = worldWith(null);
    fake.wire.getContent = async () => {
      throw new FakeHttpError(502, "secret-token-in-body");
    };

    const result: ChecksPolicyRead = await read(fake);

    expect(result).toEqual({ readable: false, reason: `required-checks policy ${PATH} of ${REPO}@main is unreadable: HTTP 502` });
  });
});

describe("checksDrift", () => {
  it("reports a check the policy lists but the live list lacks as missing", () => {
    expect(checksDrift(["validate", "dag-check"], ["validate"])).toEqual({ missing: ["dag-check"], extra: [] });
  });

  it("reports a live check the policy does not list as extra", () => {
    expect(checksDrift(["validate"], ["validate", "lint"])).toEqual({ missing: [], extra: ["lint"] });
  });

  it("does not count duplicates in the live list as drift", () => {
    const live = ["validate", "dag-check", "egress-scan", "hub-compose", "validate", "dag-check"];

    expect(checksDrift(["validate", "dag-check", "egress-scan", "hub-compose"], live)).toEqual({ missing: [], extra: [] });
  });

  it("does not count duplicates in the expected list as drift or repeat a missing check", () => {
    expect(checksDrift(["validate", "validate", "dag-check", "dag-check"], ["validate"])).toEqual({ missing: ["dag-check"], extra: [] });
  });

  it("returns no drift for equal sets", () => {
    const drift: ChecksDrift = checksDrift(["b", "a"], ["a", "b"]);

    expect(drift).toEqual({ missing: [], extra: [] });
  });
});
