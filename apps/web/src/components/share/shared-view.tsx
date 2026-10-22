"use client";

import type {
  AppendixEntry,
  BlueprintContent,
  TraceabilityReport,
} from "@tessaloom/core";
import { Eye, FileText, FlaskConical } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { Provenance } from "@/lib/types";
import { Logo } from "../app-shell";
import {
  BlueprintDocument,
  TraceabilityMeter,
} from "../blueprint/blueprint-document";
import { ProvenanceChip, StatusPill } from "../provenance";
import { Skeleton } from "../ui";

interface Shared {
  scope: "project" | "experiment" | "blueprint";
  expiresAt: string;
  project: { name: string; useCase: string };
  blueprint?: {
    format: string;
    status: string;
    hypotheses: { title: string; status: string }[];
    revision: {
      revisionNumber: number;
      author: string;
      createdAt: string;
      content: BlueprintContent;
      traceabilityReport: TraceabilityReport;
    } | null;
    appendix: Omit<AppendixEntry, "toolInvocationId">[];
  };
  experiment?: {
    kind: string;
    brief: { title: string } | null;
    hypotheses: {
      id: string;
      title: string;
      premise: string;
      status: string;
      retired: boolean;
      compositeScore: number | null;
      claims: {
        id: string;
        statement: string;
        testKind: string;
        stance: string | null;
      }[];
      evidence: {
        id: string;
        claimId: string;
        stance: string;
        rationale: string | null;
        provenanceClass: string;
      }[];
    }[];
  };
  overview?: {
    experiments: { kind: string; label: string | null; createdAt: string }[];
    blueprints: {
      title: string | null;
      format: string;
      status: string;
      revisionNumber: number | null;
    }[];
  };
}

/**
 * The read-only share page (UI_UX_SPEC §4.8). It uses plain fetch (no workspace is created),
 * shows no controls, and labels fixture data exactly as the studio does.
 */
export function SharedView({ token }: { token: string }) {
  const [data, setData] = useState<Shared | null | "inactive">(null);
  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/v1/share/${encodeURIComponent(token)}`, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    })
      .then(async (r) => (r.ok ? ((await r.json()) as Shared) : "inactive"))
      .catch(() => "inactive" as const)
      .then((d) => {
        if (!cancelled) setData(d);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const fixture =
    data &&
    data !== "inactive" &&
    JSON.stringify(data).includes("DEVELOPMENT_FIXTURE");

  return (
    <div className="min-h-screen">
      {fixture ? (
        <div
          data-testid="fixture-banner"
          role="note"
          className="flex items-center justify-center gap-2 bg-rust px-4 py-1.5 text-center text-sm font-semibold text-white"
        >
          <FlaskConical aria-hidden className="size-4" />
          Development fixtures — not real Qloo data
        </div>
      ) : null}
      <header className="border-b border-border bg-card/80 print:hidden">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <Logo />
          <span
            className="inline-flex items-center gap-1.5 rounded-full border border-warp px-2.5 py-0.5 text-xs font-semibold text-warp"
            data-testid="readonly-badge"
          >
            <Eye aria-hidden className="size-3.5" /> Read-only shared view
          </span>
          {data && data !== "inactive" ? (
            <span className="text-xs text-muted-foreground">
              Expires {data.expiresAt.slice(0, 10)}
            </span>
          ) : null}
          <Link
            href="/"
            className="ml-auto rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
          >
            Create your own experiment
          </Link>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-6">
        {data === null ? <Skeleton className="h-96" /> : null}
        {data === "inactive" ? (
          <div
            className="rounded-xl border border-border bg-card p-8 text-center"
            role="status"
          >
            <h1 className="font-serif text-2xl">
              This link is no longer active.
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Ask the person who shared it for a new link.
            </p>
          </div>
        ) : null}
        {data && data !== "inactive" ? (
          <>
            <p className="text-sm text-muted-foreground">
              Shared from the project{" "}
              <strong className="text-foreground">{data.project.name}</strong>
            </p>
            {data.blueprint ? (
              <SharedBlueprint token={token} bp={data.blueprint} />
            ) : null}
            {data.experiment ? (
              <SharedExperiment exp={data.experiment} />
            ) : null}
            {data.overview ? <SharedProject overview={data.overview} /> : null}
          </>
        ) : null}
      </main>
    </div>
  );
}

function SharedBlueprint({
  token,
  bp,
}: {
  token: string;
  bp: NonNullable<Shared["blueprint"]>;
}) {
  if (!bp.revision)
    return <p className="text-sm">This blueprint is still being composed.</p>;
  const r = bp.revision;
  return (
    <div className="space-y-6">
      <header className="rounded-xl border border-border bg-card p-5">
        <h1 className="font-serif text-3xl leading-tight">{r.content.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {bp.format} · {bp.status === "ACCEPTED" ? "Accepted" : "Draft"} ·
          revision {r.revisionNumber} · from{" "}
          {bp.hypotheses.map((h) => h.title).join("; ")}
        </p>
        <a
          className="mt-3 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs hover:bg-surface-2 print:hidden"
          href={`/api/v1/share/${encodeURIComponent(token)}/export?format=md`}
          rel="noreferrer"
        >
          <FileText aria-hidden className="size-3.5" /> Download Markdown
        </a>
      </header>
      <TraceabilityMeter report={r.traceabilityReport} />
      <BlueprintDocument
        content={r.content}
        appendix={bp.appendix.map((a) => ({ ...a, toolInvocationId: null }))}
        onOpenEvidence={(id) => {
          const label = bp.appendix.find((a) => a.id === id)?.label;
          if (label)
            document
              .getElementById(`ev-${label}`)
              ?.scrollIntoView({ block: "center" });
        }}
      />
    </div>
  );
}

function SharedExperiment({ exp }: { exp: NonNullable<Shared["experiment"]> }) {
  return (
    <section aria-labelledby="exp-h" className="space-y-4">
      <h1 id="exp-h" className="font-serif text-3xl">
        {exp.brief?.title ?? "Experiment"}
        {exp.kind === "BRANCH" ? (
          <span className="ml-2 text-base text-muted-foreground">
            (What-if branch)
          </span>
        ) : null}
      </h1>
      <ul className="grid gap-4 md:grid-cols-2">
        {exp.hypotheses
          .filter((h) => !h.retired)
          .map((h) => (
            <li
              key={h.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-center justify-between gap-2">
                <StatusPill status={h.status} />
                <span className="font-serif text-xl">
                  {h.compositeScore === null
                    ? "—"
                    : Math.round(h.compositeScore)}
                </span>
              </div>
              <h2 className="mt-2 font-serif text-lg">{h.title}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                <ProvenanceChip
                  provenance="CREATIVE_SPECULATION"
                  className="mr-1 align-middle"
                />
                {h.premise}
              </p>
              <ul className="mt-3 space-y-2 text-sm">
                {h.claims.map((c) => {
                  const ev = [...h.evidence]
                    .reverse()
                    .find((e) => e.claimId === c.id);
                  return (
                    <li key={c.id}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {c.stance ? (
                          <StatusPill status={c.stance} />
                        ) : (
                          <span className="text-xs">untested</span>
                        )}
                        {c.statement}
                      </span>
                      {ev ? (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <ProvenanceChip
                            provenance={ev.provenanceClass as Provenance}
                          />
                          {ev.rationale}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
      </ul>
    </section>
  );
}

function SharedProject({
  overview,
}: {
  overview: NonNullable<Shared["overview"]>;
}) {
  return (
    <section
      aria-labelledby="proj-h"
      className="space-y-4 rounded-xl border border-border bg-card p-5"
    >
      <h1 id="proj-h" className="font-serif text-3xl">
        Project overview
      </h1>
      <p className="text-sm">
        {overview.experiments.length} experiment
        {overview.experiments.length === 1 ? "" : "s"} ·{" "}
        {overview.blueprints.length} blueprint
        {overview.blueprints.length === 1 ? "" : "s"}
      </p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {overview.blueprints.map((b, i) => (
          <li key={i}>
            {b.title ?? "Untitled"} — {b.format}, {b.status.toLowerCase()},
            revision {b.revisionNumber ?? "—"}
          </li>
        ))}
      </ul>
    </section>
  );
}
