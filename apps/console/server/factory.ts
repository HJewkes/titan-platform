import { z } from "zod";
import { ownerItemSchema, type OwnerItem } from "@titan-design/owner-queue";
import { liveSource } from "@titan-design/rpc-client";
import { failure, unexpectedShape } from "./active-work.js";
import { timedFetch, type UpstreamObserver } from "./perf/timed-fetch.js";

/** Items stay `unknown` here so one item that fails `ownerItemSchema` costs a gap line, not the whole list. */
const needsList = z.object({ items: z.array(z.unknown()), gaps: z.array(z.string()), fyiCount: z.number().int().nonnegative().optional() });

interface FactoryNeedsList {
  items: OwnerItem[];
  /** The factory's own dead-source lines, then one line per item that failed the schema. */
  gaps: string[];
  /** The fyi items the factory left out and only counted; absent from a factory older than the `fyi: count` option, which lists them. */
  fyiCount?: number;
}

interface FactoryNeeds {
  /** Rejects with an error that carries a sysexits `code` when the factory is down, refuses, or answers another shape. */
  list(): Promise<FactoryNeedsList>;
}

const READ_TIMEOUT_MS = 10_000;

/** Calls titan-factory's `needs.list` on loopback. It needs no token, only the client header `liveSource` sends. */
export function factoryNeeds(port: number, timeoutMs: number = READ_TIMEOUT_MS, recorder?: UpstreamObserver): FactoryNeeds {
  const source = liveSource({
    origin: `http://127.0.0.1:${port}`,
    fetch: timedFetch("factory", recorder, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) })),
  });
  return {
    async list() {
      // fyi items outnumber the asks by far and the inbox only counts them, so they never cross the wire (TP-4757).
      const envelope = await source.call("needs.list", { fyi: "count" });
      if (!envelope.ok) throw failure(`factory needs.list: ${envelope.error}`, envelope.code);
      const parsed = needsList.safeParse(envelope.data);
      if (!parsed.success) throw unexpectedShape("factory needs.list");
      const { fyiCount } = parsed.data;
      return { ...splitValid(parsed.data.items, parsed.data.gaps), ...(fyiCount !== undefined && { fyiCount }) };
    },
  };
}

function splitValid(raw: readonly unknown[], upstreamGaps: readonly string[]): FactoryNeedsList {
  const items: OwnerItem[] = [];
  const gaps = [...upstreamGaps];
  raw.forEach((candidate, index) => {
    const parsed = ownerItemSchema.safeParse(candidate);
    if (parsed.success) items.push(parsed.data);
    else gaps.push(`factory item ${itemLabel(candidate, index)}: invalid`);
  });
  return { items, gaps };
}

/** The item's id when it has one; otherwise its position, so the gap still points somewhere. */
function itemLabel(candidate: unknown, index: number): string {
  const id = typeof candidate === "object" && candidate !== null ? (candidate as { id?: unknown }).id : undefined;
  return typeof id === "string" && id !== "" ? id : `#${index}`;
}
