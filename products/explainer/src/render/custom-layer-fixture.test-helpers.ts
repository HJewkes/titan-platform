import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Synthetic: a hand-written layer for an invented parcel desk; no builder wrote it.

/** The cells the synthetic layer declares, and the box it draws over them on the 1920×1080 stage. */
export const SYNTHETIC_ANCHORS = ["B2:E5"];
const SYNTHETIC_BOX = { x: 320, y: 180, width: 1280, height: 720 };
export const SYNTHETIC_ELEMENT = "parcel-hold";

/** A custom layer as a builder would write one: a default-export component on the motion clock, allowlisted imports only. */
export const SYNTHETIC_LAYER = `import { useBeatTime } from "@titan-design/react-ui/motion";

export default function ParcelHold() {
  const { t } = useBeatTime();
  const style = {
    position: "absolute", left: ${SYNTHETIC_BOX.x}, top: ${SYNTHETIC_BOX.y}, width: ${SYNTHETIC_BOX.width}, height: ${SYNTHETIC_BOX.height},
    background: "#2f7d6a", color: "#fff", fontSize: 64, opacity: Math.min(1, t),
  } as const;
  return <div id="${SYNTHETIC_ELEMENT}" data-el="${SYNTHETIC_ELEMENT}" style={style}>Parcels waiting: {Math.round(t * 10)}</div>;
}
`;

/** A `custom-layers` tree in `dir`, as resolve stores one: `layers.json` plus the module files given. */
export function writeSyntheticTree(dir: string, beat: string, modules: Readonly<Record<string, string>> = { [`${beat}.tsx`]: SYNTHETIC_LAYER }): string {
  mkdirSync(dir, { recursive: true });
  const index = { schema: "explainer.custom-layers/v1", layers: [{ beat, module: `${beat}.tsx`, key: "k".repeat(64), anchors: SYNTHETIC_ANCHORS, elements: [SYNTHETIC_ELEMENT] }] };
  writeFileSync(path.join(dir, "layers.json"), `${JSON.stringify(index, null, 2)}\n`);
  for (const [name, text] of Object.entries(modules)) writeFileSync(path.join(dir, name), text);
  return dir;
}
