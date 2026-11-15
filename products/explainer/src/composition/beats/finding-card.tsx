import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";
import type { BeatViewProps } from "../registry.js";
import { ListFrame, type ListItem, type ListMark } from "./ListBeat.js";

type Slots = z.infer<(typeof BEAT_SLOTS)["finding-card"]>;
type Finding = Slots["findings"][number];

const MARKS: Record<Finding["severity"], ListMark> = { high: "problem", medium: "risk", low: "neutral" };

const chipOf = ({ status, round }: Finding): string => (round === undefined ? status : `${status} · round ${round}`);

/** finding-card: each finding a row marked by its severity, its status and round as the chip, under the chapter label. */
export function FindingCardBeat({ slots, reveal, chapter }: BeatViewProps<Slots>) {
  const items: ListItem[] = slots.findings.map((finding) => ({
    id: finding.id,
    text: finding.title,
    mark: MARKS[finding.severity],
    ref: chipOf(finding),
    atS: reveal(finding.id) ?? 0,
  }));
  return <ListFrame heading={chapter ?? ""} items={items} />;
}
