// The synthetic review rounds in `fixtures/rounds`, for tests and the owner's browser check. Nothing there is copied from a real round;
// the PNGs under `ship-tile-r1` and `beacon-states-r1` are solid blocks with a stripe (and a dot), generated once by a throwaway script.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RoundsSource } from "./rounds.js";

export const FIXTURE_ROUNDS: RoundsSource = { dir: path.join(import.meta.dirname, "..", "fixtures", "rounds") };

export interface StagedRound {
  source: RoundsSource;
  /** The round's feedback.json, parsed; rejects until a submit has written it. */
  feedback: () => Promise<unknown>;
  remove: () => Promise<void>;
}

export const TILES_HEAD = "89abcdef0123456789abcdef0123456789abcdef";
export const PANELS_HEAD = "fedcba9876543210fedcba9876543210fedcba98";

const shipQuestion = (id: string, repo: string, pr: number, headSha: string) => ({
  id, kind: "pick-one", prompt: `Ship ${repo}#${pr} at ${headSha.slice(0, 12)}?`, options: ["Ship", "Don't ship"], required: true,
  page: `${repo}#${pr}`, signsOff: `${id}-baselines`, merge: { repo, pr, headSha, ship: ["Ship"] },
});
const part = (id: string, label: string) => ({ parts: [{ id, label, proposed: label.toLowerCase() }] });

/** `ship-tile-r1`'s images split across two PRs in one round (TP-3329): each PR its own group, sections and Ship question. */
export function twoPrRound(): Record<string, unknown> {
  const section = (id: string, title: string, rest: Record<string, unknown>) => ({ id, title, deciding: `What ${title.toLowerCase()} decides.`, context: "Synthetic.", ...rest });
  return {
    schema: "titan-review/round@2", unit: "tiles-and-panels", round: 1, storybookUrl: "http://localhost:6006", widths: [1280], recommendations: "after-answer",
    variants: [
      { key: "tile-light", image: "images/tile-light.png", label: "Tile, light" },
      { key: "tile-dark", image: "images/tile-dark.png", label: "Tile, dark" },
      { key: "panel-wide", image: "images/panel-wide.png", label: "Panel, wider" },
      { key: "badge-new", image: "images/badge-new.png", label: "Badge (new at head)" },
    ],
    sections: [
      section("tiles-changed", "Changed tiles", { changed: "The tile stripe moved up six pixels.", kind: "STATES", variantKeys: ["tile-light", "tile-dark"] }),
      section("tiles-side", "Side question", { changed: "The tile stripe colour is new.", questionIds: ["stripe-colour"], ...part("stripe-colour-part", "Teal stripe") }),
      section("tiles-ship", "Ship tiles", { changed: "Two regenerated tile baselines.", questionIds: ["ship-tiles"], ...part("ship-tiles-baselines", "Two tile baselines") }),
      section("panels-changed", "Changed panels", { changed: "The panel is wider and a badge is new.", kind: "STATES", variantKeys: ["panel-wide", "badge-new"] }),
      section("panels-ship", "Ship panels", { changed: "One wider panel, one new badge.", questionIds: ["ship-panels"], ...part("ship-panels-baselines", "Panel and badge baselines") }),
    ],
    questions: [
      { id: "stripe-colour", kind: "pick-one", prompt: "Keep the stripe colour?", options: ["Keep", "Change"], page: "example/tiles#1", signsOff: "stripe-colour-part" },
      shipQuestion("ship-tiles", "example/tiles", 1, TILES_HEAD),
      shipQuestion("ship-panels", "example/panels", 2, PANELS_HEAD),
    ],
    prGroups: [
      { pr: "example/tiles#1", headSha: TILES_HEAD, sectionIds: ["tiles-changed", "tiles-side", "tiles-ship"], title: "Move the tile stripe up", kind: "correctness", description: "Moves the stripe up six pixels so it clears the label." },
      { pr: "example/panels#2", headSha: PANELS_HEAD, sectionIds: ["panels-changed", "panels-ship"], title: "Widen the panel", kind: "feature", description: "Widens the panel and adds a badge for new items." },
    ],
  };
}

/** A temp rounds dir with fixture round `from` copied in as `id` under a test's own round.json, so a test can submit to it. */
export async function stagedRound(from: string, id: string, roundJson: unknown): Promise<StagedRound> {
  const root = await mkdtemp(path.join(tmpdir(), "staged-round-"));
  await cp(path.join(FIXTURE_ROUNDS.dir, from), path.join(root, id), { recursive: true });
  await writeFile(path.join(root, id, "round.json"), JSON.stringify(roundJson));
  return {
    source: { dir: root },
    feedback: async () => JSON.parse(await readFile(path.join(root, id, "feedback.json"), "utf8")) as unknown,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}
