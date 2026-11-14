import { createServer, type Server } from "node:http";
import type { DecisionTask } from "../needs/active-work-source.js";

/** Synthetic: `alpha` is shown to agents, `private-plans` is withheld from them. */
export const SHOWN_SLUG = "alpha";
export const WITHHELD_SLUG = "private-plans";

export const withheldTask: DecisionTask = { slug: WITHHELD_SLUG, id: "PP-7", title: "Choose the private storage plan", status: "open", tags: ["needs-decision"], created: "2026-03-09", updated: "2026-03-09" };
export const shownTask: DecisionTask = { slug: SHOWN_SLUG, id: "AL-1", title: "Choose the alpha retry budget", status: "open", tags: ["needs-decision"], created: "2026-03-09", updated: "2026-03-09" };

const INVENTORY = {
  initiatives: [
    { slug: SHOWN_SLUG, human_only: false, withheld_from_agents: false },
    { slug: WITHHELD_SLUG, human_only: false, withheld_from_agents: true },
  ],
  human_only_known: true,
};

export interface NeedsDaemon {
  port: number;
  close: () => Promise<void>;
}

/** A loopback active-work daemon answering the two reads a needs view makes: `task.list` and `inventory`. */
export async function needsDaemon(tasks: readonly DecisionTask[] = [withheldTask, shownTask]): Promise<NeedsDaemon> {
  const server: Server = createServer((req, res) => {
    const data = req.url?.endsWith("/task.list") ? { tasks } : INVENTORY;
    req.resume();
    req.on("end", () => res.setHeader("content-type", "application/json").end(JSON.stringify({ ok: true, data })));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the fake active-work daemon has no port");
  return { port: address.port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
