"use client";

import { Search, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { breakdownOf, testQuestion } from "@/lib/hypothesis-view";
import type { EntityView, EvidenceView, HypothesisRow } from "@/lib/types";
import { DomainBadge, ProvenanceChip, StatusPill } from "./provenance";
import { Button } from "./ui";

const QUALITY_NOTE: Record<string, string> = {
  PARTIAL: "Partial data — Qloo returned fewer results than requested.",
  DEGRADED: "Partial data — the response was degraded.",
  FIELD_UNAVAILABLE: "The measure this rule needs was not in the response.",
  ERROR: "Not tested — the Qloo request failed.",
};

function EvidenceItem({
  e,
  onTrace,
}: {
  e: EvidenceView;
  onTrace: (e: EvidenceView) => void;
}) {
  return (
    <li
      className="rounded-lg border border-border p-3"
      data-testid="evidence-item"
    >
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill status={e.stance} />
        <ProvenanceChip
          provenance={e.provenanceClass}
          origin={e.dataOrigin}
          retrievedAt={e.retrievedAt}
        />
        <span className="font-mono text-[10px] text-muted-foreground">
          {e.evaluatorId} · {e.rulesetVersion}
        </span>
      </div>
      {e.rationale ? (
        <p className="mt-2 text-sm" data-testid="evidence-rule">
          <span className="sr-only">Evaluator rule: </span>
          {e.rationale}
        </p>
      ) : null}
      {QUALITY_NOTE[e.quality] ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {QUALITY_NOTE[e.quality]}
        </p>
      ) : null}
      {e.facts.length ? (
        <ul className="mt-2 space-y-1">
          {e.facts.map((f, i) => (
            <li key={i} className="text-xs">
              {f.statement}
              <span className="ml-1 font-mono text-[10px] text-muted-foreground">
                {f.jsonPointer} = {JSON.stringify(f.value)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {e.criticNote ? (
        <div className="mt-2 border-l-2 border-dashed border-slate pl-2 text-xs">
          <ProvenanceChip provenance="MODEL_INTERPRETATION" />
          <p className="mt-1 text-muted-foreground">{e.criticNote}</p>
        </div>
      ) : null}
      {e.toolInvocationId ? (
        <Button
          variant="secondary"
          size="sm"
          className="mt-2"
          onClick={() => onTrace(e)}
        >
          <Search aria-hidden className="size-3.5" /> Trace
        </Button>
      ) : null}
    </li>
  );
}

/** Evidence drawer (UI_UX_SPEC §4.4): claims, plain-language tests, stances, rules, trace. */
export function EvidenceDrawer({
  hypothesis: h,
  entities,
  onClose,
  onTrace,
}: {
  hypothesis: HypothesisRow;
  entities: Map<string, EntityView>;
  onClose: () => void;
  onTrace: (e: EvidenceView) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const critique = breakdownOf(h).critique;
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="drawer-title"
      className="m-0 ml-auto h-dvh max-h-dvh w-full max-w-[min(640px,100vw)] border-l border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-border bg-card px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Evidence · iteration {h.iteration + 1}
          </p>
          <h2 id="drawer-title" className="font-serif text-2xl leading-tight">
            {h.title}
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusPill status={h.status} />
            {h.elements.map((el) => {
              const e = entities.get(el.entityId);
              return e ? (
                <span
                  key={el.entityId}
                  className="flex items-center gap-1 text-xs"
                >
                  {e.name} <DomainBadge domain={e.domain} />
                </span>
              ) : null;
            })}
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close evidence"
          onClick={() => ref.current?.close()}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="space-y-5 px-5 py-4">
        {critique ? (
          <section
            aria-labelledby="critique-heading"
            className="rounded-lg border border-dashed border-slate p-3 text-sm"
          >
            <h3
              id="critique-heading"
              className="flex items-center gap-2 font-semibold"
            >
              Critic <ProvenanceChip provenance="MODEL_INTERPRETATION" />
            </h3>
            <p className="mt-1">
              Recommends{" "}
              <span className="font-semibold">
                {critique.recommendation.toLowerCase()}
              </span>
              {critique.downgrade
                ? ` · downgraded to ${critique.downgrade.replace(/_/g, " ").toLowerCase()}`
                : ""}
            </p>
            {critique.confidenceNote ? (
              <p className="mt-1 text-muted-foreground">
                {critique.confidenceNote}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted-foreground">
              The critic can downgrade a status or add interpretation; it never
              changes an evaluator&apos;s stance.
            </p>
          </section>
        ) : null}
        {h.claims
          .slice()
          .sort((a, b) => a.ordinal - b.ordinal)
          .map((c) => {
            const evidence = h.evidence.filter((e) => e.claimId === c.id);
            return (
              <section
                key={c.id}
                aria-labelledby={`claim-${c.id}`}
                data-testid="claim"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h3 id={`claim-${c.id}`} className="font-medium">
                    {c.ordinal + 1}. {c.statement}
                  </h3>
                  {c.currentStance ? (
                    <StatusPill status={c.currentStance} />
                  ) : (
                    <StatusPill status={c.status} />
                  )}
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {testQuestion(c, entities)}{" "}
                  <span className="font-mono text-[10px]">({c.testKind})</span>
                </p>
                {evidence.length ? (
                  <ul className="mt-2 space-y-2">
                    {evidence.map((e) => (
                      <EvidenceItem key={e.id} e={e} onTrace={onTrace} />
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {c.status === "UNSUPPORTED"
                      ? "Untestable with Qloo's documented capabilities; no request was made."
                      : "No evidence collected for this claim yet."}
                  </p>
                )}
              </section>
            );
          })}
        <section aria-labelledby="concept-heading">
          <h3
            id="concept-heading"
            className="flex items-center gap-2 font-semibold"
          >
            Concept <ProvenanceChip provenance="CREATIVE_SPECULATION" />
          </h3>
          <p className="mt-1 text-sm">{h.premise}</p>
          <p className="mt-2 text-sm text-muted-foreground">
            {h.experienceSketch}
          </p>
          {h.creativeElements.length ? (
            <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
              {h.creativeElements.map((c, i) => (
                <li key={i}>{c.text}</li>
              ))}
            </ul>
          ) : null}
        </section>
      </div>
    </dialog>
  );
}
