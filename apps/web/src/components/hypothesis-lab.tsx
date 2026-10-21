"use client";

import { useProject } from "./project-context";
import { StatusPill } from "./provenance";
import { EmptyState, SectionTitle } from "./ui";

/** M5 placeholder list; the full Hypothesis Lab (cards, evidence drawer, trace) is M6. */
export function HypothesisLab() {
  const { view } = useProject();
  const hyps = view?.hypotheses ?? [];
  return (
    <div>
      <SectionTitle eyebrow="Step 3" title="Hypothesis lab" />
      {hyps.length === 0 ? (
        <EmptyState title="No hypotheses yet." />
      ) : (
        <ul className="space-y-2">
          {hyps.map((h) => (
            <li
              key={h.id}
              className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
            >
              <span className="font-serif">{h.title}</span>
              <StatusPill status={h.status} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
