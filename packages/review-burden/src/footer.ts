export type Door = "one-way" | "two-way";

export const FOOTER_MARKER = "<!-- merge-danger:v1 -->";

/** The author's declared merge-danger footer; a key is absent when its line is missing or empty. */
export interface Footer {
  door?: Door;
  blastRadius?: string;
  rollback?: string;
  contract?: string;
  /** True only when all four keys are present and the door is `one-way` or `two-way`. */
  present: boolean;
}

type FooterKey = "door" | "blastRadius" | "rollback" | "contract";

const KEYS: Record<string, FooterKey> = {
  door: "door",
  "blast radius": "blastRadius",
  rollback: "rollback",
  contract: "contract",
};

const KEY_LINE = /^\s*(?:[-*]\s+)?(door|blast radius|rollback|contract)\s*:\s*(.*)$/i;

/** Reads the four keys after the last marker, so an edited body's newest footer counts; the first non-empty line per key wins. */
export function parseFooter(body: string): Footer {
  const start = body.lastIndexOf(FOOTER_MARKER);
  if (start < 0) return { present: false };
  const values = readKeys(body.slice(start + FOOTER_MARKER.length));
  const door = parseDoor(values.door);
  const footer: Footer = { present: false };
  if (door) footer.door = door;
  if (values.blastRadius) footer.blastRadius = values.blastRadius;
  if (values.rollback) footer.rollback = values.rollback;
  if (values.contract) footer.contract = values.contract;
  footer.present = Boolean(door && footer.blastRadius && footer.rollback && footer.contract);
  return footer;
}

function readKeys(block: string): Partial<Record<FooterKey, string>> {
  const values: Partial<Record<FooterKey, string>> = {};
  for (const line of block.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line);
    if (!match) continue;
    const key = KEYS[(match[1] ?? "").toLowerCase()];
    const value = (match[2] ?? "").trim();
    if (key && values[key] === undefined && value) values[key] = value;
  }
  return values;
}

function parseDoor(value: string | undefined): Door | undefined {
  const door = value?.replace(/[`*_]/g, "").trim().toLowerCase();
  return door === "one-way" || door === "two-way" ? door : undefined;
}

/** True when the footer names a contract; `none`, in any case, means it does not. */
export function hasContract(footer: Footer): boolean {
  const contract = footer.contract?.replace(/[`*_]/g, "").trim().toLowerCase();
  return contract !== undefined && contract !== "none";
}
