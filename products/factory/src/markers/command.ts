import { dirname, join } from "node:path";
import type { Command } from "commander";
import { openDatabase } from "@titan-design/store-sqlite";
import type { Verbs } from "../cli-types.js";
import { EXIT } from "../exit-codes.js";
import { parsePrRef } from "../registry.js";
import { factoryRegistry } from "../registry/steps/index.js";
import { explainFact } from "./why.js";

/** `markers why`: read-only. With no git or tree source here, diff and landed facts read as unpinnable (D-M2-08 folds this into `why`). */
export function registerMarkers(program: Command, { io, dbPath, setExit }: Pick<Verbs, "io" | "dbPath" | "setExit">): void {
  program
    .command("markers")
    .description("The M1b marker shadow (off by default; the run record stays authoritative)")
    .command("why <ref> <fact>")
    .description("Explain a fact's marker verdict for owner/repo#N: its inputs, drift, and newest rows")
    .action(async (ref: string, fact: string) => {
      const item = parsePrRef(ref);
      const path = dbPath();
      const db = openDatabase(path, { readonly: true });
      try {
        const blobs = { blobDir: join(dirname(path), "marker-blobs") };
        const lines = await explainFact({ registry: factoryRegistry, sources: { db }, now: new Date().toISOString(), blobs }, { item, fact });
        io.stdout(`${lines.join("\n")}\n`);
        setExit(EXIT.OK);
      } finally {
        db.close();
      }
    });
}
