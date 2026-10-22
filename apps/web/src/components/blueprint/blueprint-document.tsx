"use client";

import {
  originLabel,
  SECTION_ORDER,
  SECTION_TITLE,
  type AppendixEntry,
  type BlueprintContent,
  type TraceabilityReport,
} from "@tessaloom/core";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { Provenance } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ProvenanceChip } from "../provenance";
import { Button, inputClass } from "../ui";
import { MarkdownLite } from "./markdown-lite";

type SectionKind = (typeof SECTION_ORDER)[number];

const GROUPS = [
  {
    key: "evidence",
    label: "Evidence-backed",
    match: ["APP_DERIVED", "QLOO_SOURCED", "DEVELOPMENT_FIXTURE"],
    cls: "bg-warp",
  },
  {
    key: "interpretation",
    label: "AI interpretation",
    match: ["MODEL_INTERPRETATION"],
    cls: "bg-weft",
  },
  {
    key: "speculation",
    label: "Speculation (unverified)",
    match: ["CREATIVE_SPECULATION"],
    cls: "bg-saffron",
  },
  { key: "user", label: "By you", match: ["USER_PROVIDED"], cls: "bg-slate" },
] as const;

const SEVERITY: Record<string, string> = {
  info: "border-border text-foreground",
  caution: "border-saffron bg-saffron-tint text-foreground",
  blocking: "border-rust bg-rust/10 text-rust",
};

/** Traceability meter (UI_UX_SPEC §4.6): blocks by provenance, text and bar. */
export function TraceabilityMeter({
  report,
  onlySpeculative,
  onToggle,
}: {
  report: TraceabilityReport;
  onlySpeculative?: boolean;
  onToggle?: () => void;
}) {
  const total = Math.max(1, report.blocks);
  const counts = GROUPS.map((g) => ({
    ...g,
    n: g.match.reduce((sum, k) => sum + (report.byProvenance[k] ?? 0), 0),
  }));
  return (
    <section
      aria-labelledby="trace-meter"
      className="rounded-xl border border-border bg-card p-4"
      data-testid="traceability-meter"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="trace-meter" className="text-sm font-semibold">
          Traceability
        </h2>
        {onToggle ? (
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={onlySpeculative}
            onClick={onToggle}
          >
            {onlySpeculative
              ? "Show all blocks"
              : "Show only speculative blocks"}
          </Button>
        ) : null}
      </div>
      <div
        className="mt-2 flex h-3 overflow-hidden rounded-full bg-surface-2"
        aria-hidden
      >
        {counts.map((c) =>
          c.n ? (
            <div
              key={c.key}
              className={c.cls}
              style={{ width: `${(c.n / total) * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <p className="mt-2 text-sm">
        {counts
          .filter((c) => c.n)
          .map(
            (c) =>
              `${Math.round((c.n / total) * 100)}% ${c.label.toLowerCase()}`,
          )
          .join(" · ")}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {report.blocks} blocks · {report.citations} citations,{" "}
        {report.unresolved.length === 0
          ? "all resolve to stored evidence"
          : `${report.unresolved.length} unresolved`}
        {report.edited ? ` · ${report.edited} edited by you` : ""}. Qloo values
        are aggregate audience signals — they describe shared tastes, not
        attendance or sales.
      </p>
    </section>
  );
}

function CitationPills({
  ids,
  labels,
  onOpen,
}: {
  ids: string[];
  labels: Map<string, string>;
  onOpen: (id: string) => void;
}) {
  if (!ids.length) return null;
  return (
    <span className="ml-1 inline-flex flex-wrap gap-1 align-middle">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onOpen(id)}
          className="rounded border border-warp/60 px-1.5 font-mono text-[11px] text-warp hover:bg-warp/10"
          aria-label={`Open evidence ${labels.get(id) ?? ""}`}
        >
          {labels.get(id) ?? "E-?"}
        </button>
      ))}
    </span>
  );
}

export interface EditApi {
  saveBlock: (kind: SectionKind, index: number, text: string) => Promise<void>;
  addBlock: (kind: SectionKind, text: string) => Promise<void>;
  removeBlock: (kind: SectionKind, index: number) => Promise<void>;
  saveConcept: (text: string) => Promise<void>;
  recompose?: (kind: SectionKind) => void;
}

function EditBox({
  initial,
  label,
  onSave,
  onCancel,
}: {
  initial: string;
  label: string;
  onSave: (text: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const id = useId();
  return (
    <div className="mt-1 space-y-2">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        className={cn(inputClass, "min-h-24 font-sans text-sm")}
        value={text}
        maxLength={2000}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="text-[11px] text-muted-foreground">
        Plain text with **bold**, _italic_, and “- ” bullets. Saving creates a
        new revision.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="weft"
          disabled={busy || !text.trim() || text === initial}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(text.trim());
            } finally {
              setBusy(false);
            }
          }}
        >
          Save as new revision
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * The blueprint document: concept, sections with provenance-labeled blocks and citation
 * pills, constraints with severity and suggested mitigation, open questions, and the
 * evidence appendix. Read-only unless `edit` is given.
 */
export function BlueprintDocument({
  content,
  appendix,
  edit,
  onOpenEvidence,
  onlySpeculative = false,
}: {
  content: BlueprintContent;
  appendix: AppendixEntry[];
  edit?: EditApi;
  onOpenEvidence: (id: string) => void;
  onlySpeculative?: boolean;
}) {
  const labels = new Map(appendix.map((a) => [a.id, a.label]));
  const [editing, setEditing] = useState<string | null>(null);
  const shown = (p: string) => !onlySpeculative || p === "CREATIVE_SPECULATION";
  const conceptProv = (content.conceptProvenance ??
    "CREATIVE_SPECULATION") as Provenance;

  return (
    <article className="space-y-6" data-testid="blueprint-document">
      <section
        aria-labelledby="concept-h"
        className="rounded-xl border border-border bg-card p-5"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="concept-h" className="font-serif text-2xl">
            Concept
          </h2>
          <ProvenanceChip provenance={conceptProv} />
          {edit && editing !== "concept" ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto print:hidden"
              onClick={() => setEditing("concept")}
              aria-label="Edit the concept"
            >
              <Pencil aria-hidden className="size-3.5" /> Edit
            </Button>
          ) : null}
        </div>
        {editing === "concept" && edit ? (
          <EditBox
            initial={content.concept}
            label="Concept"
            onSave={async (t) => {
              await edit.saveConcept(t);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div className="mt-2 text-[15px] leading-relaxed">
            <MarkdownLite text={content.concept} />
          </div>
        )}
      </section>

      {SECTION_ORDER.map((kind) => {
        const blocks =
          content.sections.find((s) => s.kind === kind)?.blocks ?? [];
        const visible = blocks
          .map((b, i) => ({ b, i }))
          .filter(({ b }) => shown(b.provenance));
        if (onlySpeculative && !visible.length) return null;
        return (
          <section
            key={kind}
            aria-labelledby={`sec-${kind}`}
            className="rounded-xl border border-border bg-card p-5"
            data-testid={`section-${kind}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={`sec-${kind}`} className="font-serif text-xl">
                {SECTION_TITLE[kind]}
              </h2>
              {edit?.recompose ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto print:hidden"
                  onClick={() => edit.recompose!(kind)}
                >
                  Recompose section
                </Button>
              ) : null}
            </div>
            {!visible.length ? (
              kind === "risks" &&
              content.constraintsIdentified.length ? null : (
                <p className="mt-2 text-sm text-muted-foreground">
                  No blocks yet.
                </p>
              )
            ) : (
              <ul className="mt-3 space-y-3">
                {visible.map(({ b, i }) => {
                  const key = `${kind}.${i}`;
                  return (
                    <li
                      key={key}
                      className={cn(
                        "rounded-lg border-l-4 py-1.5 pl-3",
                        [
                          "APP_DERIVED",
                          "QLOO_SOURCED",
                          "DEVELOPMENT_FIXTURE",
                        ].includes(b.provenance)
                          ? "border-warp"
                          : b.provenance === "MODEL_INTERPRETATION"
                            ? "border-weft border-dashed"
                            : b.provenance === "USER_PROVIDED"
                              ? "border-slate"
                              : "border-saffron border-dotted",
                      )}
                      data-testid="blueprint-block"
                      data-provenance={b.provenance}
                    >
                      <div className="flex flex-wrap items-center gap-1.5">
                        <ProvenanceChip
                          provenance={b.provenance as Provenance}
                        />
                        {b.edited ? (
                          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                            edited by you
                          </span>
                        ) : null}
                        {edit && editing !== key ? (
                          <span className="ml-auto flex gap-1 print:hidden">
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Edit block ${i + 1} in ${SECTION_TITLE[kind]}`}
                              onClick={() => setEditing(key)}
                            >
                              <Pencil aria-hidden className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={`Remove block ${i + 1} in ${SECTION_TITLE[kind]}`}
                              onClick={() => void edit.removeBlock(kind, i)}
                            >
                              <Trash2 aria-hidden className="size-3.5" />
                            </Button>
                          </span>
                        ) : null}
                      </div>
                      {editing === key && edit ? (
                        <EditBox
                          initial={b.text}
                          label={`Block ${i + 1} in ${SECTION_TITLE[kind]}`}
                          onSave={async (t) => {
                            await edit.saveBlock(kind, i, t);
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      ) : (
                        <div className="mt-1 text-sm leading-relaxed">
                          <MarkdownLite text={b.text} />
                          <CitationPills
                            ids={b.evidenceIds}
                            labels={labels}
                            onOpen={onOpenEvidence}
                          />
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {edit && !onlySpeculative ? (
              editing === `${kind}.new` ? (
                <EditBox
                  initial=""
                  label={`New block in ${SECTION_TITLE[kind]}`}
                  onSave={async (t) => {
                    await edit.addBlock(kind, t);
                    setEditing(null);
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 print:hidden"
                  onClick={() => setEditing(`${kind}.new`)}
                >
                  <Plus aria-hidden className="size-3.5" /> Add a block
                </Button>
              )
            ) : null}
            {kind === "risks" && content.constraintsIdentified.length ? (
              <div className="mt-4" data-testid="constraints">
                <h3 className="text-sm font-semibold">
                  Constraints identified
                </h3>
                <ul className="mt-2 space-y-2">
                  {content.constraintsIdentified.map((c, i) => (
                    <li
                      key={i}
                      className={cn(
                        "rounded-lg border p-3 text-sm",
                        SEVERITY[c.severity],
                      )}
                    >
                      <p>
                        <span className="mr-2 rounded border border-current px-1.5 py-0.5 text-[10px] font-semibold uppercase">
                          {c.severity}
                        </span>
                        {c.constraint}
                        <CitationPills
                          ids={c.evidenceIds}
                          labels={labels}
                          onOpen={onOpenEvidence}
                        />
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Source: {c.source ?? "—"}
                      </p>
                      {c.mitigation ? (
                        <div className="mt-2 flex flex-wrap items-start gap-1.5 text-xs">
                          <ProvenanceChip provenance="MODEL_INTERPRETATION" />
                          <span>Suggested mitigation: {c.mitigation}</span>
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>
        );
      })}

      <section
        aria-labelledby="questions-h"
        className="rounded-xl border border-border bg-card p-5"
      >
        <h2 id="questions-h" className="font-serif text-xl">
          Open questions
        </h2>
        {content.openQuestions.length ? (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
            {content.openQuestions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">None.</p>
        )}
      </section>

      <section
        aria-labelledby="appendix-h"
        className="rounded-xl border border-border bg-card p-5"
        data-testid="evidence-appendix"
      >
        <h2 id="appendix-h" className="font-serif text-xl">
          Evidence appendix
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Every reference resolves to a stored, traceable evidence record graded
          by a deterministic rule.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 pr-2 font-medium">Ref</th>
                <th className="py-1 pr-2 font-medium">Claim</th>
                <th className="py-1 pr-2 font-medium">Stance and rule</th>
                <th className="py-1 pr-2 font-medium">Origin</th>
                <th className="py-1 font-medium">Retrieved</th>
              </tr>
            </thead>
            <tbody>
              {appendix.map((a) => (
                <tr
                  key={a.id}
                  id={`ev-${a.label}`}
                  className="border-t border-border align-top"
                >
                  <td className="py-1.5 pr-2">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 whitespace-nowrap font-mono text-warp hover:underline"
                      onClick={() => onOpenEvidence(a.id)}
                    >
                      <Search aria-hidden className="size-3 print:hidden" />
                      {a.label}
                    </button>
                  </td>
                  <td className="py-1.5 pr-2">
                    {a.claim}
                    <span className="block text-muted-foreground">
                      {a.hypothesisTitle}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2">
                    {a.rationale ?? `${a.stance} (${a.evaluatorId})`}
                  </td>
                  <td className="py-1.5 pr-2">{originLabel(a)}</td>
                  <td className="whitespace-nowrap py-1.5 font-mono">
                    {a.retrievedAt ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </article>
  );
}
