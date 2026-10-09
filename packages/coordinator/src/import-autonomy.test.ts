import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkCoordinatorConfig } from "./coordinator-config.js";
import { importAutonomyTree, renderSeatBook } from "./import-autonomy.js";
import type { CharterPolicy } from "./charter-policy.js";
import type { SeatConfig } from "./seat-config.js";

function frontmatter<T>(file: string): T {
  const text = readFileSync(
    new URL(`./fixtures/autonomy-tree/${file}`, import.meta.url),
    "utf8"
  );
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${file} has no front matter`);
  return JSON.parse(match[1] as string) as T;
}

const charter = frontmatter<CharterPolicy>("charter.md");
const seats = [
  frontmatter<SeatConfig>("seat-a.md"),
  frontmatter<SeatConfig>("seat-b.md"),
];
const limits = {
  version: 1 as const,
  pools: {
    "pool-a": {
      config_dir: "/home/user/cfg/pool-a",
      ceiling_five_hour: 90,
      reserve_seven_day: 20,
    },
    "pool-b": {
      config_dir: "/home/user/cfg/pool-b",
      ceiling_five_hour: 90,
      reserve_seven_day: 20,
    },
    "pool-c": {
      config_dir: "/home/user/cfg/pool-c",
      ceiling_five_hour: 90,
      reserve_seven_day: 20,
    },
  },
};

describe("importAutonomyTree", () => {
  it("imports the example tree to a document that passes the coordinator check", () => {
    const result = checkCoordinatorConfig(
      importAutonomyTree(charter, seats, limits)
    );

    expect(result).toMatchObject({ ok: true });
  });

  it("renders the imported document back to the seat files with config_dir restored from the pool", () => {
    const document = checkCoordinatorConfig(
      importAutonomyTree(charter, seats, limits)
    );

    expect(document.ok && renderSeatBook(document.config)).toEqual(seats);
  });

  it("keeps a repo that two seats list differently as two repos", () => {
    const { repos } = importAutonomyTree(charter, seats, limits);

    expect(
      Object.values(repos).filter((repo) => repo.path === "~/work/repo-1")
    ).toHaveLength(2);
  });

  it("takes the owner seat and policy from the charter", () => {
    const { owner, policy } = importAutonomyTree(charter, seats, limits);

    expect([owner.seat, policy.hard_stops]).toEqual([
      charter.owner_seat,
      charter.hard_stops,
    ]);
  });

  it("leaves config_dir off the imported seats", () => {
    const document = importAutonomyTree(charter, seats, limits);

    expect(
      Object.values(document.seats).some((seat) => "config_dir" in seat)
    ).toBe(false);
  });
});
