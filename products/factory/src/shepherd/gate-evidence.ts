import type { Db, Migration } from "@titan-design/store-sqlite";
import { z } from "zod";

/** How a hold reason and an evidence record spell one external gate. */
export const GATE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/;

const ConclusionRow = z.object({ conclusion: z.enum(["success", "failure"]) });
export type GateConclusion = z.infer<typeof ConclusionRow>["conclusion"];

interface GateEvidenceInput {
  repo: string;
  head: string;
  gate: string;
  conclusion: GateConclusion;
  /** Who ran the gate: the factory workflow or host that read its result. */
  source: string;
}

const GATE_EVIDENCE_DDL = `
  CREATE TABLE shepherd_external_gate (
    name        TEXT PRIMARY KEY,
    declared_at TEXT NOT NULL
  );
  CREATE TABLE shepherd_gate_evidence (
    repo        TEXT NOT NULL,
    head        TEXT NOT NULL,
    gate        TEXT NOT NULL REFERENCES shepherd_external_gate (name),
    conclusion  TEXT NOT NULL CHECK (conclusion IN ('success', 'failure')),
    source      TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE INDEX shepherd_gate_evidence_head ON shepherd_gate_evidence (repo, head, gate);`;

/** Gates that run outside GitHub Actions, and what each concluded at one head; a `lan-gates` hold reads them. */
export function gateEvidenceMigration(version = 47): Migration {
  return { version, name: "factory:shepherd_gate_evidence", up: (db) => db.exec(GATE_EVIDENCE_DDL) };
}

class GateEvidenceRefused extends Error {
  override readonly name = "GateEvidenceRefused";
}

export interface GateEvidence {
  /** Adds a gate a hold may name; a repeat changes nothing. */
  declare(gate: string): void;
  known(gate: string): boolean;
  /** Appends one conclusion; refuses a gate never declared and a head that is not a full sha. */
  record(input: GateEvidenceInput): void;
  /** The newest conclusion for `gate` at exactly `head`; one at any other head is not read. */
  conclusionAt(repo: string, head: string, gate: string): GateConclusion | undefined;
}

export function gateEvidenceTable(db: Db, stamp: () => string): GateEvidence {
  const known = (gate: string) => db.prepare("SELECT 1 FROM shepherd_external_gate WHERE name = ?").get(gate) !== undefined;
  return {
    declare: (gate) => {
      if (!GATE_NAME.test(gate)) throw new GateEvidenceRefused(`"${gate}" is not a gate name: lower-case letters, digits, ".", "_" or "-"`);
      db.prepare("INSERT OR IGNORE INTO shepherd_external_gate (name, declared_at) VALUES (?, ?)").run(gate, stamp());
    },
    known,
    record: ({ repo, head, gate, conclusion, source }) => {
      if (!known(gate)) throw new GateEvidenceRefused(`"${gate}" is not a declared gate, so its evidence was not recorded`);
      if (!SHA.test(head)) throw new GateEvidenceRefused(`"${head}" is not a full head sha, so the evidence was not recorded`);
      const insert = "INSERT INTO shepherd_gate_evidence (repo, head, gate, conclusion, source, recorded_at) VALUES (?, ?, ?, ?, ?, ?)";
      db.prepare(insert).run(repo.toLowerCase(), head, gate, conclusion, source, stamp());
    },
    conclusionAt: (repo, head, gate) => {
      const select = "SELECT conclusion FROM shepherd_gate_evidence WHERE repo = ? AND head = ? AND gate = ? ORDER BY rowid DESC LIMIT 1";
      const row = ConclusionRow.safeParse(db.prepare(select).get(repo.toLowerCase(), head, gate));
      return row.success ? row.data.conclusion : undefined;
    },
  };
}
