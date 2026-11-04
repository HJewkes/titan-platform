import { readFileSync } from "node:fs";
import { z } from "zod";
import type { OccupancyInput } from "./occupancy-table.js";

const Box = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const FixtureSchema = z.object({
  stage: z.object({ width: z.number(), height: z.number() }),
  layouts: z.array(z.object({ beat: z.string(), layer: z.enum(["template", "custom"]).optional(), anchors: z.array(z.string()).optional() })),
  marks: z.array(z.object({ beat: z.string(), t: z.number(), elements: z.array(z.object({ id: z.string(), box: Box })) })),
  pixels: z.array(z.object({ beat: z.string(), t: z.number(), coverage: z.array(z.array(z.number())) })),
});

/** The synthetic render in fixtures/anchors: a template beat, a declared and an undeclared custom layer, a sparse card. */
export function marksFixture(): OccupancyInput {
  return FixtureSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/anchors/marks.json", import.meta.url), "utf8")));
}
