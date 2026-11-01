import type { ReactNode } from "react";
import { Typography, VStack } from "@titan-design/react-ui";
import type { GateEvidence } from "../../server/inbox-gate-evidence.js";

type EvidenceSection = GateEvidence["sections"][number];
type CiPolicy = NonNullable<EvidenceSection["ciPolicy"]>;

const FACT_TITLE: Readonly<Record<string, string>> = {
  "ci-policy-weakened": "CI policy weakened",
  "ci-policy-malformed": "CI-policy line malformed",
  "skill-path": "Repo skill changed",
};

/** Wraps, never clamps or scrolls: every string is the factory's `exactLine` rendering and the owner reads it whole. */
const PRE = "whitespace-pre-wrap break-all rounded bg-surface-raised p-2 font-mono text-sm";

const reading = ({ kind, keys }: CiPolicy): string => (keys === undefined || keys.length === 0 ? kind : `${kind}: ${keys.join(", ")}`);

/**
 * TP-4404: the card an owner-at-head gate's stored evidence shows, as the factory projected it; this tap answers exactly these
 * sections. Each string is shown verbatim, and the long ones start collapsed so the sheet fits a phone.
 */
export function EvidenceFacts({ evidence }: { evidence: GateEvidence }): ReactNode {
  return (
    <VStack gap={2} testID="inbox-readback-evidence">
      <Typography variant="subtitle2">{`You read this at the head: ${evidence.facts.join(", ")}. Diffs are against merge base ${evidence.mergeBase.slice(0, 7)}.`}</Typography>
      {evidence.sections.map((section) => (
        <EvidenceSectionFacts key={section.fact} section={section} />
      ))}
    </VStack>
  );
}

function EvidenceSectionFacts({ section }: { section: EvidenceSection }): ReactNode {
  return (
    <VStack gap={1} testID={`inbox-evidence-${section.fact}`}>
      <Typography variant="body2">{FACT_TITLE[section.fact] ?? section.fact}</Typography>
      {section.ciPolicy === undefined ? null : <Typography variant="mono" testID="inbox-evidence-ci-policy">{`CI policy: ${reading(section.ciPolicy)}`}</Typography>}
      {(section.labelledLines ?? []).map((line, index) => (
        <pre key={index} className={PRE} data-testid="inbox-evidence-labelled-line">{`${line.raw}  (reads ${reading(line.reading)})`}</pre>
      ))}
      {section.verdictLines === undefined ? null : (
        <details>
          <summary>The reviewer's verdict, with its rationale</summary>
          <pre className={PRE} data-testid="inbox-evidence-verdict">{section.verdictLines.join("\n")}</pre>
        </details>
      )}
      {section.files.map((file) => (
        <details key={file.path}>
          <summary>{`${file.path} (${file.rows.length} changed lines)`}</summary>
          <pre className={PRE} data-testid="inbox-evidence-file">{file.rows.map(({ side, n, text }) => `${side} L${n}: ${text}`).join("\n")}</pre>
        </details>
      ))}
    </VStack>
  );
}
