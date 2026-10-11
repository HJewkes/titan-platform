import { z } from "zod";
import { deliverableId, isoDate, isoDateOrNull } from "./task.js";

export const DELIVERABLE_STATUSES = ["planned", "active", "shipped", "dropped"] as const;

/** One deliverable, stored at `<deliverablesDir>/<id>.yml`. */
export const DeliverableSchema = z
  .object({
    id: deliverableId,
    title: z.string().min(1),
    done_when: z.string().min(1),
    target: isoDateOrNull,
    status: z.enum(DELIVERABLE_STATUSES),
    owner_seat: z.string().min(1),
    // Retrieval only: nothing selects, orders or lints on a deliverable's tags.
    tags: z.array(z.string()),
    created: isoDate,
    updated: isoDate,
    shipped_at: isoDateOrNull,
  })
  .refine((d) => (d.status === "shipped") === (d.shipped_at !== null), {
    message: "shipped_at is set exactly when status is shipped",
    path: ["shipped_at"],
  });

export type Deliverable = z.infer<typeof DeliverableSchema>;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** One file read from the deliverables directory: its basename and its parsed YAML. */
export interface DeliverableEntry {
  file: string;
  parsed: unknown;
}

export function deliverablesDir(activeRoot: string): string {
  return `${activeRoot.replace(/\/+$/, "")}/titan-platform/deliverables`;
}

export function deliverablePath(activeRoot: string, id: string): string {
  return `${deliverablesDir(activeRoot)}/${deliverableId.parse(id)}.yml`;
}

const parseEntry = ({ file, parsed }: DeliverableEntry): Deliverable => {
  const result = DeliverableSchema.safeParse(parsed);
  if (!result.success) throw new Error(`${file}: ${result.error.issues.map((i) => i.message).join("; ")}`);
  const expected = `${result.data.id}.yml`;
  if (file !== expected) throw new Error(`${file}: holds id ${result.data.id}, so the file must be ${expected}`);
  return result.data;
};

/**
 * Validates the `.yml` files of the deliverables directory, which the host has read and parsed.
 * A missing directory is an empty registry, so the host passes `[]` and gets `[]` back. Each
 * file must be named after the id it holds, which also makes ids unique. Throws on the first
 * bad file, naming it.
 */
export function parseDeliverableRegistry(entries: readonly DeliverableEntry[]): Deliverable[] {
  return entries.map(parseEntry);
}
