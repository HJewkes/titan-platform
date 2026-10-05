import type {
  Consumers,
  ContextDossier,
  FileDossier,
  SymbolDossier,
} from "./graph-context-build.js";

/**
 * Human/agent-readable markdown projection of a {@link ContextDossier} (C-74).
 * The JSON form is the RAG-store record; this is the same facts rendered for a
 * reader (or an agent that prefers prose). Deterministic — no LLM.
 */
export function renderContextMarkdown(d: ContextDossier): string {
  const span = d.target.span ? `:${d.target.span.startLine}-${d.target.span.endLine}` : "";
  const lines = [
    `# ${d.target.kind === "symbol" ? d.target.name : d.target.path}`,
    "",
    `- **kind**: ${d.target.kind}`,
    `- **path**: \`${d.target.path}${span}\``,
    `- **snapshot**: ${d.provenance.ref} (${d.provenance.commitHash ?? "—"}) @ ${d.provenance.takenAt}`,
    "",
  ];
  if (d.symbol) lines.push(...renderSymbol(d.symbol));
  if (d.file) lines.push(...renderFile(d.file));
  if (d.notes.length) lines.push("## Notes", ...d.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

function renderSymbol(s: SymbolDossier): string[] {
  const out = [
    "## Symbol",
    `- **exported**: ${s.exported}`,
    `- **signature**: ${s.signature ? `\`${s.signature}\`` : "— (not indexed)"}`,
    `- **purpose**: ${s.purpose ?? "—"}`,
    `- **complexity**: cognitive ${s.complexity.cognitive ?? "—"}, cyclomatic ${s.complexity.cyclomatic ?? "—"}`,
    `- **utilization**: ${s.utilization}`,
    `- **blast radius**: ${round(s.blastRadius)}`,
    ...renderConsumers(s.consumers),
  ];
  if (s.coupledWith.length) {
    out.push("### Co-imported with");
    for (const c of s.coupledWith) out.push(`- ${c.name} (\`${c.fileId}\`) ×${c.coImports}`);
    out.push("");
  }
  return out;
}

function renderFile(f: FileDossier): string[] {
  const m = f.metrics;
  const own = f.ownership
    ? `${f.ownership.primaryOwner} (bus factor ${f.ownership.busFactor}, ${f.ownership.authorCount} authors)`
    : "—";
  const out = [
    "## File",
    `- **loc**: ${m.loc ?? "—"} · **cognitive** ${m.cognitiveMax ?? "—"} · **cyclomatic** ${m.cyclomaticMax ?? "—"}`,
    `- **fan-in/out**: ${m.fanIn ?? "—"} / ${m.fanOut ?? "—"} · **centrality**: ${round(f.centrality)}`,
    `- **churn**: ${f.churn ? `${f.churn.value} (${f.churn.windowDays}d)` : "—"} · **role**: ${m.role ?? "—"}`,
    `- **ownership**: ${own}`,
    "",
    ...section(`Depends on (${f.dependsOn.length})`, f.dependsOn),
    ...renderConsumers(f.consumers),
  ];
  if (f.symbols.length) {
    out.push(`### Symbols (${f.symbols.length})`);
    for (const s of f.symbols) {
      const tag = s.exported ? "export" : "internal";
      const sig = s.signature ? ` \`${s.signature}\`` : "";
      const imp = s.importance !== undefined ? `, importance ${s.importance}` : "";
      out.push(`- \`${s.name}\` (${tag})${sig} — util ${s.utilization}, cog ${s.cognitive ?? "—"}, consumers ${s.consumers}${imp}`);
    }
    out.push("");
  }
  if (f.blastRadius.length) {
    out.push("### Blast radius (riskiest to touch)");
    for (const b of f.blastRadius) out.push(`- \`${b.name}\` — score ${round(b.score)} (util ${b.utilization} × cog ${b.complexity} × churn ${b.churn})`);
    out.push("");
  }
  return out;
}

function section(title: string, items: readonly string[]): string[] {
  if (!items.length) return [];
  return [`### ${title}`, ...items.map((i) => `- \`${i}\``), ""];
}

/** Source consumers lead (the actionable set); test consumers are counted, not listed. */
function renderConsumers(c: Consumers): string[] {
  const header = `### Consumers — ${c.counts.source} source, ${c.counts.test} test (${c.counts.total} total)`;
  const rows = c.source.map((i) => `- \`${i}\``);
  return [header, ...(rows.length ? rows : ["- (no non-test consumers)"]), `> ${c.note}`, ""];
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
