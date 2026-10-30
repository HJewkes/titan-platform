import type { L0Result } from "../eval-l0.js";
import type { LedgerStamp, Stamped } from "../ledger-stamp.js";
import type { ScriptV1 } from "../script-schema.js";

/** A settled script and the rows it fails. */
export interface Measured {
  stamped: Stamped;
  rows: L0Result[];
}

interface Splicing {
  failing: (script: ScriptV1) => L0Result[];
  settle: (script: ScriptV1) => Stamped;
  /** Whether `after` makes progress over `before`: the same rule that keeps a whole reply. */
  better: (after: readonly L0Result[], before: readonly L0Result[]) => boolean;
}

/** `into` with its chapter `chapter` beats swapped for `from`'s, placed where the first of them stood. */
function swapChapter(into: ScriptV1, from: ScriptV1, chapter: string): ScriptV1 | undefined {
  const at = into.beats.findIndex((beat) => beat.chapter === chapter);
  const incoming = from.beats.filter((beat) => beat.chapter === chapter);
  if (at < 0 || incoming.length === 0) return undefined;
  const rest = into.beats.filter((beat) => beat.chapter !== chapter);
  const before = into.beats.slice(0, at).filter((beat) => beat.chapter !== chapter).length;
  return { ...into, beats: [...rest.slice(0, before), ...incoming, ...rest.slice(before)] };
}

const sameChapter = (a: ScriptV1, b: ScriptV1, chapter: string): boolean =>
  JSON.stringify(a.beats.filter((beat) => beat.chapter === chapter)) === JSON.stringify(b.beats.filter((beat) => beat.chapter === chapter));

/** Every stamp whose beat the spliced script still has, once each: the kept script's, the reply's and the re-settle's. */
function stampsOf(script: ScriptV1, ...lists: readonly (readonly LedgerStamp[])[]): LedgerStamp[] {
  const beats = new Set(script.beats.map((beat) => beat.id));
  const seen = new Set<string>();
  return lists.flat().filter((stamp) => {
    const key = `${stamp.beat} ${stamp.term}`;
    if (!beats.has(stamp.beat) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function trySplice(kept: Measured, reply: Measured, chapter: string, splicing: Splicing): Measured | undefined {
  const swapped = swapChapter(kept.stamped.script, reply.stamped.script, chapter);
  if (!swapped || sameChapter(swapped, kept.stamped.script, chapter)) return undefined;
  const settled = splicing.settle(swapped);
  const rows = splicing.failing(settled.script);
  if (!splicing.better(rows, kept.rows)) return undefined;
  return { stamped: { script: settled.script, stamps: stampsOf(settled.script, kept.stamped.stamps, reply.stamped.stamps, settled.stamps) }, rows };
}

/**
 * A rejected repair reply can still fix some chapters while it breaks others. In reply order, then the kept
 * script's chapter order, each chapter of a reply other than the kept one is swapped in, settled and kept when it
 * makes progress, so the good chapters of a rejected round are not thrown away. `kept` is a model reply, so every
 * beat is still one the model wrote, and the gates decide.
 */
export function spliceChapters(kept: Measured, replies: readonly (Measured & { kind: string })[], splicing: Splicing): { kept: Measured; spliced: string[] } {
  let current = kept;
  const spliced: string[] = [];
  for (const reply of replies.filter((each) => each.stamped !== kept.stamped)) {
    for (const { id } of current.stamped.script.chapters) {
      if (current.rows.length === 0) return { kept: current, spliced };
      const next = trySplice(current, reply, id, splicing);
      if (next) [current, spliced[spliced.length]] = [next, `${id} from ${reply.kind}`];
    }
  }
  return { kept: current, spliced };
}
