"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useProject } from "../project-context";
import { StatusPill } from "../provenance";
import { Button } from "../ui";

const FORMATS = [
  { value: "event", label: "One-off event" },
  { value: "series", label: "Recurring series" },
  { value: "installation", label: "Installation" },
] as const;

export interface ComposeChoice {
  id: string;
  title: string;
  status: string;
  compositeScore: number | null;
}

/**
 * Compose a blueprint from 1–3 hypotheses (PRD EB-1). From gate H3 it first records the
 * selection (the run completes), then starts the COMPOSITION run.
 */
export function ComposeDialog({
  projectId,
  experimentId,
  choices,
  preselected,
  selectionRunId,
  source,
  onClose,
}: {
  projectId: string;
  experimentId: string;
  choices: ComposeChoice[];
  preselected: string[];
  /** Set while gate H3 is open: the selection is recorded before composing. */
  selectionRunId?: string | null;
  source: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const { refresh } = useProject();
  const [picked, setPicked] = useState<string[]>(preselected.slice(0, 3));
  const [format, setFormat] =
    useState<(typeof FORMATS)[number]["value"]>("event");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const toggle = (id: string) =>
    setPicked((p) =>
      p.includes(id)
        ? p.filter((x) => x !== id)
        : p.length < 3
          ? [...p, id]
          : p,
    );
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (selectionRunId)
        await api.post(`/api/v1/runs/${selectionRunId}/confirmations`, {
          kind: "HYPOTHESIS_SELECTION",
          selectedHypothesisIds: picked,
        });
      const res = await api.post<{ blueprintId: string }>(
        `/api/v1/experiments/${experimentId}/blueprints`,
        { hypothesisIds: picked, format },
      );
      await refresh();
      router.push(`/projects/${projectId}/blueprint?id=${res.blueprintId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="compose-title"
      className="m-auto w-[min(600px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h2 id="compose-title" className="font-serif text-xl">
            Compose a blueprint
          </h2>
          <p className="text-xs text-muted-foreground">{source}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="space-y-4 px-5 py-4">
        <fieldset>
          <legend className="text-sm font-semibold">Hypotheses (1–3)</legend>
          <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto">
            {choices.map((c) => (
              <li key={c.id}>
                <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(c.id)}
                    disabled={!picked.includes(c.id) && picked.length >= 3}
                    onChange={() => toggle(c.id)}
                  />
                  <span className="min-w-0 flex-1 font-serif">{c.title}</span>
                  <StatusPill status={c.status} />
                  <span className="font-mono text-xs text-muted-foreground">
                    {c.compositeScore === null
                      ? "—"
                      : Math.round(c.compositeScore)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-semibold">Format</legend>
          <div className="mt-2 flex flex-wrap gap-3 text-sm">
            {FORMATS.map((f) => (
              <label key={f.value} className="flex items-center gap-1.5">
                <input
                  type="radio"
                  name="format"
                  checked={format === f.value}
                  onChange={() => setFormat(f.value)}
                />
                {f.label}
              </label>
            ))}
          </div>
        </fieldset>
        <p className="rounded-md bg-surface-2 p-3 text-xs">
          The agent writes the plan; every evidence-backed statement cites the
          stored evidence, and ideas are labeled as unverified.
          {selectionRunId
            ? " Your selection is recorded and the hypothesis loop finishes."
            : ""}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-rust">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => ref.current?.close()}>
            Cancel
          </Button>
          <Button
            variant="weft"
            onClick={submit}
            disabled={busy || picked.length === 0}
          >
            Compose blueprint
          </Button>
        </div>
      </div>
    </dialog>
  );
}
