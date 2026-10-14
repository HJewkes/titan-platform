import { describe, expect, it } from "vitest";
import { registeredOwners } from "./seat-tie.js";

const target = { repo: "octo/demo", pr: 4, head: "a".repeat(40) };
const THIS_PR = { repo: "Octo/Demo", pr: 4, implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" };
const OTHER_PR = { repo: "octo/demo", pr: 5, implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b" };
const BRANCH_ONLY = { repo: "octo/demo", pr: null, implementer: "tc-tp-6-c", branch: "agent-chat/tc-tp-6-c" };
const storeOf = (rows: readonly (typeof THIS_PR | typeof BRANCH_ONLY)[]) => ({
  get: () => ({ byPr: (repo: string, pr: number) => rows.find((row) => row.pr === pr && row.repo.toLowerCase() === repo.toLowerCase()), all: () => rows }),
});

describe("registeredOwners", () => {
  it("names this PR's owner and every other registration, labelled by its PR or else its branch", () => {
    expect(registeredOwners(storeOf([THIS_PR, OTHER_PR, BRANCH_ONLY]), target)).toEqual({
      owner: { implementer: "tc-tp-9-a", branch: "agent-chat/tc-tp-9-a" },
      others: [
        { implementer: "tc-tp-5-b", branch: "agent-chat/tc-tp-5-b", label: "octo/demo#5" },
        { implementer: "tc-tp-6-c", branch: "agent-chat/tc-tp-6-c", label: "octo/demo agent-chat/tc-tp-6-c" },
      ],
    });
  });

  it("gives nothing when the PR has no registration, so no reviewer can clear by another's", () => {
    expect(registeredOwners(storeOf([OTHER_PR]), target)).toEqual({});
  });

  it("gives nothing when the store cannot be read", () => {
    const unbound = {
      get: () => {
        throw new Error("not bound");
      },
    };

    expect(registeredOwners(unbound, target)).toEqual({});
  });
});
