import { textHallmarkRows } from "./lint-hallmarks.js";

const ADDED_HALLMARKS = ["hallmark:naming-refrain", "hallmark:label-first", "hallmark:teaser"];

const hallmarkHits = (spoken: string, id: string): number =>
  textHallmarkRows([{ id: "b", spoken }]).find((row) => row.id === id)?.value ?? 0;

/** A rewrite may keep a naming-refrain, label-first or teaser sentence it had, but not add one (TP-5721 hallmarks). */
export const hallmarkRejections = (before: string, after: string): { rule: "hallmark-added"; detail: string }[] =>
  ADDED_HALLMARKS.filter((id) => hallmarkHits(after, id) > hallmarkHits(before, id)).map((id) => ({
    rule: "hallmark-added" as const,
    detail: `the rewrite adds a ${id.replace("hallmark:", "")} sentence the original did not have; say it plainly`,
  }));
