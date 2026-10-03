import type { ReactNode } from "react";
import { Card, Section, SectionContent, SectionHeader } from "@titan-design/react-ui";

/** Deliberately not built: identity across renames (TP-187) is what makes two snapshots comparable node by node. */
export function ComparePage(): ReactNode {
  return (
    <Section>
      <SectionHeader title="Compare" subtitle="Two snapshots of the same repo: what improved, what regressed" />
      <SectionContent>
        <Card variant="outline" className="p-4">
          <p className="text-sm">
            Not built yet. The read API already takes a <code>baseline</code> on <code>hierarchy.get</code>,{" "}
            <code>node.get</code>, and <code>findings.list</code>, but it matches nodes and findings by id alone, so a moved
            or renamed file reads as one resolved finding plus one new one.
          </p>
          <p className="mt-2 text-sm">
            TP-187 carries identity across renames (alias chains, symbol aliases, rename-aware ratchet keys). Once code-read
            follows those aliases, this view can show, per directory and per finding: new, carried over, worsened, improved,
            and resolved, with deltas that survive a move.
          </p>
        </Card>
      </SectionContent>
    </Section>
  );
}
