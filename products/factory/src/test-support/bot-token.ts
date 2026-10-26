import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@titan-design/store-sqlite";
import { BOT_FINGERPRINT_FILE, publishFingerprint, tokenFingerprint } from "../bot-token-fingerprint.js";
import type { ScanPlace, ScanSources } from "../bot-token-scan.js";

// Built at runtime from a sentinel, so no token-shaped literal sits in the source.
export const PLANTED = `ghp_${"SYNTHETICplanted".padEnd(36, "0")}`;
const DECOY = `ghp_${"SYNTHETICdecoy".padEnd(36, "1")}`;
export const UID = process.getuid?.() ?? 0;

export interface ScanFixture {
  fingerprintFile: string;
  stateDir: string;
  sources: ScanSources;
}

export function writeIn(dir: string, name: string, text: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text);
  return file;
}

function storeRow(file: string, text: string): void {
  const db = openDatabase(file);
  db.exec("CREATE TABLE IF NOT EXISTS step_output (id INTEGER PRIMARY KEY, body TEXT, blob BLOB)");
  db.prepare("INSERT INTO step_output (body, blob) VALUES (?, ?)").run(`{"out":"${text}"}`, Buffer.from(`raw ${text}`));
  db.close();
}

/** Every place holds a decoy token-shaped string, so a clean scan proves the match is by fingerprint, not by shape. */
export function cleanFixture(root: string, token: string = PLANTED): ScanFixture {
  const stateDir = join(root, "state");
  publishFingerprint(stateDir, tokenFingerprint(token));
  const sources: ScanSources = { procRoot: join(root, "proc"), uid: UID, briefs: [join(root, "briefs")], logs: [join(root, "logs")], transcripts: [join(root, "transcripts")], store: join(root, "factory.sqlite3") };
  writeIn(join(sources.procRoot, "4242"), "environ", `PATH=/usr/bin\0GH_TOKEN=${DECOY}\0`);
  writeIn(join(sources.briefs[0]!, "a1"), "plan.json", JSON.stringify({ brief: `use ${DECOY}` }));
  writeIn(sources.logs[0]!, "serve.err.log", `token ${DECOY} refused\n`);
  writeIn(join(sources.transcripts[0]!, "project"), "s1.jsonl", `${JSON.stringify({ text: DECOY })}\n`);
  storeRow(sources.store!, DECOY);
  return { fingerprintFile: join(stateDir, BOT_FINGERPRINT_FILE), stateDir, sources };
}

const FILE_PLACES = { briefs: ["a2", "plan.json"], logs: ["nested", "agent.log"], transcripts: ["project", "s2.jsonl"] } as const;

/** Plants the token in one place and returns where the scan must name it. */
export function plant({ sources }: ScanFixture, place: ScanPlace, token: string = PLANTED): string {
  if (place === "env") {
    writeIn(join(sources.procRoot, "4343"), "environ", `LANG=C\0BOT=${token}\0`);
    return "pid 4343";
  }
  if (place === "store") {
    storeRow(sources.store!, token);
    return "table step_output";
  }
  const [dir, name] = FILE_PLACES[place];
  return writeIn(join(sources[place][0]!, dir), name, `{"text":"see ${token} here"}\n`);
}
