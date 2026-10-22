"use client";

import { X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button } from "../ui";
import { WeightsEditor, sameWeights, type Weights } from "./weights-editor";

/**
 * "Adjust weights" (UI_UX_SPEC §4.4 score breakdown): creates a rescore-only branch and opens
 * its comparison in the What-if Lab. It never mutates the original experiment.
 */
export function AdjustWeightsDialog({
  projectId,
  experimentId,
  current,
  onClose,
}: {
  projectId: string;
  experimentId: string;
  current: Weights;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [weights, setWeights] = useState(current);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ branchExperimentId: string }>(
        `/api/v1/experiments/${experimentId}/branches`,
        {
          delta: { scoringWeights: weights },
          mode: "hold_hypotheses",
          label: "Re-weighted scores",
        },
      );
      router.push(
        `/projects/${projectId}/what-if?branch=${res.branchExperimentId}`,
      );
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="adjust-weights-title"
      className="m-auto w-[min(520px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="adjust-weights-title" className="font-serif text-xl">
          Adjust scoring weights
        </h2>
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
        <WeightsEditor value={weights} onChange={setWeights} />
        <p className="rounded-md bg-surface-2 p-3 text-sm">
          This creates a <strong>rescore-only branch</strong>: the same
          evidence, re-ranked with these weights. Your original experiment is
          not changed.
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
            disabled={busy || sameWeights(weights, current)}
          >
            Create rescore-only branch
          </Button>
        </div>
      </div>
    </dialog>
  );
}
