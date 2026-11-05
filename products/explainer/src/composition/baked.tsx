// The fixture imported at build time: the reference the runtime-loaded page must match byte for byte (R-a).
import fixture from "./fixtures/fixture.timeline.json" with { type: "json" };
import { mountComposition, stageElement } from "./mount.js";
import { parseTimeline } from "./timeline.js";

void mountComposition(stageElement(), Promise.resolve(parseTimeline(fixture)));
