import { Typography } from "@titan-design/react-ui";
import { useBeatEnvelope } from "@titan-design/react-ui/motion";
import { z } from "zod";

export const TitleSlots = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

export function TitleBeat({ slots }: { slots: z.infer<typeof TitleSlots> }) {
  const { inP, outP } = useBeatEnvelope({ inS: 0.3, outS: 0.3 });
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 24, opacity: inP * (1 - outP) }}>
      <Typography variant="h1">{slots.title}</Typography>
      {slots.subtitle ? <Typography variant="h3" color="secondary">{slots.subtitle}</Typography> : null}
    </div>
  );
}
