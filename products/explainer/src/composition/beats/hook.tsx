import { Typography } from "@titan-design/react-ui";
import { useBeatEnvelope } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import { rise } from "./stage/entrance.js";
import { HOOK_ENVELOPE_S } from "./stage/video-timing.js";
import type { BEAT_SLOTS } from "../../beat-slots.js";

export function HookBeat({ slots }: { slots: z.infer<(typeof BEAT_SLOTS)["hook"]> }) {
  const { inP, outP } = useBeatEnvelope({ inS: HOOK_ENVELOPE_S, outS: HOOK_ENVELOPE_S });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, ...rise(inP * (1 - outP), 24) }}>
      <Typography variant="h1">{slots.line}</Typography>
      {slots.cards.map((card) => (
        <Typography key={card.id} variant="h3" color="secondary">{card.text}</Typography>
      ))}
    </div>
  );
}
