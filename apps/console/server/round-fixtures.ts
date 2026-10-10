// The synthetic review rounds in `fixtures/rounds`, for tests and the owner's browser check. Nothing there is copied from a real round.
import path from "node:path";
import type { RoundsSource } from "./rounds.js";

export const FIXTURE_ROUNDS: RoundsSource = { dir: path.join(import.meta.dirname, "..", "fixtures", "rounds") };
