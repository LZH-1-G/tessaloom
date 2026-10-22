"use client";

import {
  SECTION_TITLE,
  traceabilityReport,
  type BlueprintContent,
} from "@tessaloom/core";
import {
  CheckCircle2,
  FileJson,
  FileText,
  History,
  Printer,
  Share2,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import type {
  BlueprintListItem,
  BlueprintViewData,
} from "@/lib/blueprint-types";
import { cn } from "@/lib/utils";
import { useProject } from "../project-context";
import { TraceDialog } from "../trace-dialog";
import { Button, EmptyState, SectionTitle, Skeleton, inputClass } from "../ui";
import {
  BlueprintDocument,
  TraceabilityMeter,
  type EditApi,
} from "./blueprint-document";
import { ShareDialog } from "./share-dialog";

const TERMINAL = ["COMPLETED", "COMPLETED_WITH_LIMITS", "FAILED", "CANCELLED"];
type Kind = BlueprintContent["sections"][number]["kind"];

/** Experience Blueprint page (UI_UX_SPEC §4.6). */
export function BlueprintPage() {
  const { projectId, run, refresh, loading, setFocusExperiment } = useProject();
  const router = useRouter();
  const params = useSearchParams();
  const [list, setList] = useState<BlueprintListItem[] | null>(null);
  const [detail, setDetail] = useState<BlueprintViewData | null>(null);
  const [viewing, setViewing] = useState<string | null>(null); // a past revision id
  const [past, setPast] = useState<{
    id: string;
    content: BlueprintContent;
    appendix: BlueprintViewData["appendix"];
    revisionNumber: number;
  } | null>(null);
  const [trace, setTrace] = useState<string | null>(null);
  const [share, setShare] = useState(false);
  const [recompose, setRecompose] = useState<Kind | null>(null);
  const [instruction, setInstruction] = useState("");
  const [onlySpec, setOnlySpec] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = params.get("id") ?? list?.[0]?.id ?? null;

  useEffect(() => {
    void api
      .get<{ items: BlueprintListItem[] }>(
        `/api/v1/projects/${projectId}/blueprints`,
      )
      .then((r) => setList(r.items))
      .catch((e: Error) => setError(e.message));
  }, [projectId, run?.stateVersion]);

  const load = useCallback(() => {
    if (!selected) return;
    void api
      .get<BlueprintViewData>(`/api/v1/blueprints/${selected}`)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [selected]);
  // Reload when the composition run (streamed in the dock) advances.
  useEffect(load, [load, run?.stateVersion]);

  // Follow the blueprint's own experiment (root or What-if branch) so the dock streams its
  // composition run and each state change reloads the page.
  const experimentId = detail?.blueprint.experimentId ?? null;
  useEffect(() => {
    if (!experimentId) return;
    setFocusExperiment(experimentId);
    return () => setFocusExperiment(null);
  }, [experimentId, setFocusExperiment]);

  useEffect(() => {
    if (!viewing || !detail) return;
    let cancelled = false;
    void api
      .get<{
        revision: {
          id: string;
          content: BlueprintContent;
          revisionNumber: number;
        };
        appendix: BlueprintViewData["appendix"];
      }>(`/api/v1/blueprints/${detail.blueprint.id}/revisions/${viewing}`)
      .then((r) => {
        if (!cancelled)
          setPast({
            id: r.revision.id,
            content: r.revision.content,
            appendix: r.appendix,
            revisionNumber: r.revision.revisionNumber,
          });
      })
      .catch((e: Error) => setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [viewing, detail]);

  const current = detail?.current ?? null;
  const save = useCallback(
    async (content: BlueprintContent, restoreOf?: number) => {
      if (!detail?.current) return;
      setError(null);
      try {
        await api.post(`/api/v1/blueprints/${detail.blueprint.id}/revisions`, {
          baseRevisionId: detail.current.id,
          content,
          ...(restoreOf ? { restoreOfRevisionNumber: restoreOf } : {}),
        });
        setViewing(null);
        setPast(null);
        load();
      } catch (e) {
        setError((e as Error).message);
        load();
        throw e;
      }
    },
    [detail, load],
  );

  const edit: EditApi | undefined = useMemo(() => {
    if (!current) return undefined;
    const c = current.content;
    const withSection = (
      kind: Kind,
      f: (
        blocks: BlueprintContent["sections"][number]["blocks"],
      ) => BlueprintContent["sections"][number]["blocks"],
    ) => ({
      ...c,
      sections: c.sections.map((s) =>
        s.kind === kind ? { ...s, blocks: f(s.blocks) } : s,
      ),
    });
    return {
      saveBlock: (kind, i, text) =>
        save(
          withSection(kind, (b) =>
            b.map((x, j) => (j === i ? { ...x, text } : x)),
          ),
        ),
      addBlock: (kind, text) =>
        save(
          withSection(kind, (b) => [
            ...b,
            { text, provenance: "USER_PROVIDED", evidenceIds: [] },
          ]),
        ),
      removeBlock: (kind, i) =>
        save(withSection(kind, (b) => b.filter((_, j) => j !== i))),
      saveConcept: (concept) => save({ ...c, concept }),
      recompose: (kind) => setRecompose(kind),
    };
  }, [current, save]);

  if (loading || list === null) return <Skeleton className="h-96" />;
  if (!list.length)
    return (
      <div>
        <SectionTitle eyebrow="Step 5" title="Experience blueprint" />
        <EmptyState title="No blueprint yet.">
          Select 1–3 hypotheses in the{" "}
          <Link
            className="underline"
            href={`/projects/${projectId}/hypotheses`}
          >
            Hypothesis lab
          </Link>{" "}
          (or a What-if branch) and choose “Compose blueprint”.
        </EmptyState>
      </div>
    );

  const latestRun = detail?.latestRun ?? null;
  const composing = latestRun && !TERMINAL.includes(latestRun.state);
  const report = current ? current.traceabilityReport : null;
  const shown =
    past ??
    (current
      ? {
          id: current.id,
          content: current.content,
          appendix: detail!.appendix,
          revisionNumber: current.revisionNumber,
        }
      : null);

  const startRecompose = async () => {
    if (!detail || !recompose) return;
    setError(null);
    try {
      await api.post(
        `/api/v1/blueprints/${detail.blueprint.id}/sections/${recompose}/recompose`,
        instruction.trim() ? { instruction: instruction.trim() } : {},
      );
      setRecompose(null);
      setInstruction("");
      await refresh();
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6" data-testid="blueprint-page">
      <SectionTitle eyebrow="Step 5" title="Experience blueprint">
        {list.length > 1 ? (
          <label className="flex items-center gap-2 text-sm print:hidden">
            Blueprint
            <select
              className={cn(inputClass, "h-9 py-0")}
              value={selected ?? ""}
              onChange={(e) => {
                setViewing(null);
                setPast(null);
                router.replace(
                  `/projects/${projectId}/blueprint?id=${e.target.value}`,
                );
              }}
            >
              {list.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title ?? "Composing…"} ({b.format})
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </SectionTitle>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-rust/60 bg-rust/5 p-3 text-sm text-rust"
        >
          {error}
        </p>
      ) : null}

      {!detail ? (
        <Skeleton className="h-96" />
      ) : (
        <>
          <header className="rounded-xl border border-border bg-card p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h1
                  className="font-serif text-3xl leading-tight"
                  data-testid="blueprint-title"
                >
                  {current?.content.title ?? "Composing your blueprint…"}
                </h1>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs font-medium capitalize text-foreground">
                    {detail.blueprint.format}
                  </span>
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs font-semibold",
                      detail.blueprint.status === "ACCEPTED"
                        ? "border-moss text-moss"
                        : "border-border",
                    )}
                    data-testid="blueprint-status"
                  >
                    {detail.blueprint.status === "ACCEPTED"
                      ? "Accepted"
                      : "Draft"}
                  </span>
                  {detail.experiment?.kind === "BRANCH" ? (
                    <span>from a What-if branch</span>
                  ) : null}
                  {current ? (
                    <span>· revision {current.revisionNumber}</span>
                  ) : null}
                </p>
                <p className="mt-2 text-sm">
                  <span className="text-muted-foreground">From: </span>
                  {detail.hypotheses.map((h, i) => (
                    <span key={h.id}>
                      {i ? " · " : ""}
                      <Link
                        className="underline underline-offset-2"
                        href={`/projects/${projectId}/hypotheses`}
                      >
                        {h.title}
                      </Link>
                    </span>
                  ))}
                </p>
              </div>
              {current ? (
                <div className="flex flex-wrap gap-2 print:hidden">
                  <a
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs hover:bg-surface-2"
                    href={`/api/v1/blueprints/${detail.blueprint.id}/export?format=md`}
                    download
                  >
                    <FileText aria-hidden className="size-3.5" /> Export
                    Markdown
                  </a>
                  <a
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs hover:bg-surface-2"
                    href={`/api/v1/blueprints/${detail.blueprint.id}/export?format=json`}
                    download
                  >
                    <FileJson aria-hidden className="size-3.5" /> Export JSON
                  </a>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => window.print()}
                  >
                    <Printer aria-hidden className="size-3.5" /> Print / PDF
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setShare(true)}
                  >
                    <Share2 aria-hidden className="size-3.5" /> Share read-only
                  </Button>
                  <Button
                    variant={
                      detail.blueprint.status === "ACCEPTED" ? "ghost" : "weft"
                    }
                    size="sm"
                    onClick={() =>
                      void api
                        .post(
                          `/api/v1/blueprints/${detail.blueprint.id}/status`,
                          {
                            status:
                              detail.blueprint.status === "ACCEPTED"
                                ? "DRAFT"
                                : "ACCEPTED",
                          },
                        )
                        .then(load)
                        .catch((e: Error) => setError(e.message))
                    }
                  >
                    <CheckCircle2 aria-hidden className="size-3.5" />
                    {detail.blueprint.status === "ACCEPTED"
                      ? "Reopen as draft"
                      : "Accept blueprint"}
                  </Button>
                </div>
              ) : null}
            </div>
          </header>

          {composing ? (
            <p
              role="status"
              className="rounded-lg border border-border bg-card p-4 text-sm"
            >
              The agent is{" "}
              {latestRun!.state === "VALIDATING_BLUEPRINT"
                ? "checking every citation"
                : "composing"}
              … The blueprint appears when every block has passed the
              traceability check.
            </p>
          ) : null}
          {latestRun && ["FAILED", "CANCELLED"].includes(latestRun.state) ? (
            <p
              role="alert"
              className="rounded-lg border border-rust/60 bg-rust/5 p-4 text-sm"
            >
              The last composition did not finish (
              {latestRun.terminalReason?.replace(/_/g, " ").toLowerCase()}).
              {current ? " The latest valid revision is shown." : ""}
            </p>
          ) : null}

          {shown && report ? (
            <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="min-w-0 space-y-6">
                {past ? (
                  <div
                    className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-dashed border-slate bg-surface-2 p-3 text-sm print:hidden"
                    role="status"
                  >
                    Viewing revision {past.revisionNumber} (read-only).
                    <Button
                      size="sm"
                      variant="weft"
                      onClick={() =>
                        void save(past.content, past.revisionNumber).catch(
                          () => undefined,
                        )
                      }
                    >
                      Restore as new revision
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setViewing(null);
                        setPast(null);
                      }}
                    >
                      Back to the current revision
                    </Button>
                  </div>
                ) : null}
                <TraceabilityMeter
                  report={
                    past
                      ? traceabilityReport(
                          past.content,
                          new Set(past.appendix.map((a) => a.id)),
                        )
                      : report
                  }
                  onlySpeculative={onlySpec}
                  onToggle={() => setOnlySpec((v) => !v)}
                />
                <BlueprintDocument
                  content={shown.content}
                  appendix={shown.appendix}
                  edit={past || composing ? undefined : edit}
                  onOpenEvidence={setTrace}
                  onlySpeculative={onlySpec}
                />
              </div>
              <aside
                aria-labelledby="history-h"
                className="space-y-3 print:hidden"
              >
                <section className="rounded-xl border border-border bg-card p-4">
                  <h2
                    id="history-h"
                    className="flex items-center gap-1.5 text-sm font-semibold"
                  >
                    <History aria-hidden className="size-4" /> Revision history
                  </h2>
                  <ol
                    className="mt-2 space-y-1.5"
                    data-testid="revision-history"
                  >
                    {detail.revisions.map((r) => (
                      <li key={r.id}>
                        <button
                          type="button"
                          onClick={() => {
                            if (r.id === current?.id) {
                              setViewing(null);
                              setPast(null);
                            } else setViewing(r.id);
                          }}
                          aria-current={
                            (past?.id ?? current?.id) === r.id
                              ? "true"
                              : undefined
                          }
                          className={cn(
                            "w-full rounded-md border px-2.5 py-1.5 text-left text-xs",
                            (past?.id ?? current?.id) === r.id
                              ? "border-warp bg-warp/5"
                              : "border-border hover:bg-surface-2",
                          )}
                        >
                          <span className="font-semibold">
                            Revision {r.revisionNumber}
                          </span>{" "}
                          · {r.author === "AGENT" ? "Agent" : "You"} ·{" "}
                          {r.createdAt.slice(0, 16).replace("T", " ")}
                          <span className="block text-muted-foreground">
                            {r.changeSummary}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ol>
                </section>
              </aside>
            </div>
          ) : null}
        </>
      )}

      {recompose && detail ? (
        <div
          className="fixed inset-x-0 bottom-0 z-30 border-t-2 border-weft bg-card/95 px-4 py-3 shadow-lg backdrop-blur print:hidden"
          role="region"
          aria-label="Recompose a section"
        >
          <div className="mx-auto flex max-w-5xl flex-wrap items-end gap-3">
            <label className="min-w-64 flex-1 text-sm">
              Recompose <strong>{SECTION_TITLE[recompose]}</strong> — optional
              instruction
              <input
                className={cn(inputClass, "mt-1 h-9")}
                maxLength={300}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="e.g. Lean on neighborhood notice boards"
              />
            </label>
            <Button variant="weft" onClick={startRecompose}>
              Recompose section
            </Button>
            <Button variant="ghost" onClick={() => setRecompose(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {trace ? (
        <TraceDialog evidenceId={trace} onClose={() => setTrace(null)} />
      ) : null}
      {share && detail ? (
        <ShareDialog
          projectId={projectId}
          scope="blueprint"
          targetId={detail.blueprint.id}
          label={current?.content.title ?? "Blueprint"}
          onClose={() => setShare(false)}
        />
      ) : null}
    </div>
  );
}
