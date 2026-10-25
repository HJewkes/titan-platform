import { Typography } from "@titan-design/react-ui";
import { useBeatEnvelope } from "@titan-design/react-ui/motion";
import type { z } from "zod";
import type { BEAT_SLOTS } from "../../beat-slots.js";

export function HookBeat({ slots }: { slots: z.infer<(typeof BEAT_SLOTS)["hook"]> }) {
  const { inP, outP } = useBeatEnvelope({ inS: 0.3, outS: 0.3 });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: inP * (1 - outP) }}>
      <Typography variant="h1">{slots.line}</Typography>
      {slots.cards.map((card) => (
        <Typography key={card.id} variant="h3" color="secondary">{card.text}</Typography>
      ))}
    </div>
  );
}
