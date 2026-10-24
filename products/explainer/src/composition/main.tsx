import { mountComposition, stageElement } from "./mount.js";
import { fetchTimeline, timelineUrl } from "./timeline.js";

// Left unhandled on purpose: an unhandled rejection is a page error, and a page error fails the capture.
void mountComposition(stageElement(), fetchTimeline(timelineUrl(location.href)));
