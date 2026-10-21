import type { JudgeCall, JudgeHarness, JudgeReply } from "./eval-harness.js";
import type { ScriptV1 } from "./script-schema.js";
import { tour, type BeatSpec } from "./voice-flow-fixtures.test-helpers.js";

interface Rewrite {
  before: string;
  after: string;
  labels?: string[];
}

// An invented parcel desk, written choppy and crowded, with the joined line a compliant rewrite returns for each beat.
export const BEATS: Record<string, [chapter: string, rewrite: Rewrite]> = {
  h1: ["ch1", {
    before: "The desk refuses ghost labels. A courier asks for a label. The desk looks for the parcel row. It waits for the ledger. Then it prints.",
    after: "The desk refuses ghost labels. When a courier asks for a label, the desk looks for the parcel row and waits for the ledger before it prints.",
  }],
  h2: ["ch1", {
    before: "The desk held 12 parcels today. It sent 3 back to the dock. The rest went out on time. Each had a ledger row.",
    after: "The desk held 12 parcels today. It sent parcels back to the dock, and the rest went out on time because each had a ledger row.",
    labels: ["3 sent back"],
  }],
  h3: ["ch1", {
    before: "It checks the scan, the row and the label. Nothing is skipped. The courier never sees a guess. The check is fast.",
    after: "It checks the scan and the row before the label, so nothing is skipped and the courier never sees a guess. The check is fast.",
  }],
  w1: ["ch2", {
    before: "The scanner app sends 40 scans a minute. The desk server takes 2 seconds for each. It queues the rest. Nothing is lost.",
    after: "Nothing is lost. The scanner app sends 40 scans a minute to the desk server, which takes a moment for each and queues the rest.",
    labels: ["2 seconds a scan"],
  }],
  w2: ["ch2", {
    before: "The ledger keeps a row per parcel. The row names the dock. It names the courier too. The desk reads both.",
    after: "The desk reads both. The ledger keeps a row per parcel, and that row names the dock and the courier that will carry it.",
  }],
  w4: ["ch2", {
    before: "The ledger answers in 9 milliseconds. It holds 50 rows per dock. The desk trusts that answer. It never caches it.",
    after: "The desk trusts that answer. The ledger answers in 9 milliseconds though it holds rows per dock, and the desk never caches it.",
    labels: ["50 rows per dock"],
  }],
  k1: ["ch3", {
    before: "A row can be fresh, stale or missing. The desk reads its state. It prints only on fresh. It holds the rest.",
    after: "It holds the rest. A row can be fresh or stale or missing, and the desk reads that state and prints only when it is fresh.",
  }],
  k2: ["ch3", {
    before: "The desk retries 3 times. It waits 4 seconds between tries. Then it gives up. The courier gets a refusal.",
    after: "Then it gives up. The desk retries 3 times and waits between tries, and after that the courier at the counter gets a clear refusal.",
    labels: ["4 seconds between tries"],
  }],
  k3: ["ch3", {
    before: "A refusal is not an error. The parcel may be late. The scan may come later. The desk can wait.",
    after: "The desk can wait. A refusal is not an error, because the parcel may be late and its scan may still come later in the day.",
  }],
  c1: ["ch4", {
    before: "So the desk checks 70 scans a day. It refuses 6 of them. Every refusal is a ghost label. None of them print.",
    after: "None of them print. So the desk checks 70 scans a day, and every refusal it makes is a ghost label that never reaches the courier.",
    labels: ["6 refused a day"],
  }],
  c2: ["ch4", {
    before: "It reads the scan, checks the row and prints the label. That order matters. The courier trusts it. So does the dock.",
    after: "That order matters. It reads the scan and checks the row before it prints the label, so the courier and the dock can trust it.",
  }],
  c3: ["ch4", {
    before: "Check the row first, then print. The desk did it 8 times this hour. It caught 2 ghost labels. None reached a courier.",
    after: "Check the row first, then print. The desk did that 8 times this hour and caught a couple of ghost labels before any reached a courier.",
    labels: ["2 ghost labels caught"],
  }],
};

export const REWRITES = new Map(Object.entries(BEATS).map(([id, [, rewrite]]) => [id, rewrite]));

export function choppy(extra: Record<string, Record<string, unknown>> = {}): ScriptV1 {
  return tour(Object.entries(BEATS).map(([id, [chapter, { before }]]): BeatSpec => [id, chapter, "WHAT", before, { fact_ids: [`F-${id}`], ...extra[id] }]));
}

type ReplyBeat = { id: string; spoken: string; labels_added: string[] };
export type Rewriter = (id: string, prompt: string) => ReplyBeat | undefined;

export const compliant: Rewriter = (id) => {
  const rewrite = REWRITES.get(id)!;
  return { id, spoken: rewrite.after, labels_added: rewrite.labels ?? [] };
};

export const promptBeatIds = (prompt: string): string[] => [...prompt.matchAll(/^## (\S+)$/gm)].map((m) => m[1]!);

/** A model stand-in: answers each beat a prompt lists through `rewriter`, at a fixed price per call. */
export function fakeRewriter(rewriter: Rewriter = compliant, fail: (prompt: string) => string | undefined = () => undefined) {
  const prompts: string[] = [];
  const harness: JudgeHarness = async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    prompts.push(prompt);
    const reason = fail(prompt);
    if (reason) return { ok: false, reason, usd: 0.002, tokensIn: 50, tokensOut: 0 };
    const beats = promptBeatIds(prompt).flatMap((id) => rewriter(id, prompt) ?? []);
    return { ok: true, output: schema.parse({ beats }), usd: 0.01, tokensIn: 400, tokensOut: 120 };
  };
  return { harness, prompts };
}
