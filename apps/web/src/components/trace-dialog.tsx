"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Fact } from "@/lib/types";
import { Button } from "./ui";

interface InvocationTrace {
  id: string;
  method: string;
  workflow: string;
  transport: string;
  argsRedacted: Record<string, unknown>;
  requestHash: string;
  dataOrigin: string;
  envelopeStatus: string;
  envelopeShape: string;
  resultCount: number | null;
  errorCode: string | null;
  correlationId: string | null;
  harnessEndpoint: string | null;
  harnessRequests: {
    method: string;
    path: string;
    query: Record<string, unknown>;
  }[];
  latencyMs: number | null;
  attempt: number;
  retrievedAt: string;
}

interface EvidenceTraceData {
  evidence: {
    id: string;
    stance: string;
    evaluatorId: string;
    rulesetVersion: string;
    facts: Fact[];
    quality: string;
    primaryMeasure: string;
    provenanceClass: string;
  };
  claim: { statement: string; testKind: string };
  hypothesis: { title: string };
  invocation: InvocationTrace | null;
  snapshot: {
    rawRetained: boolean;
    resultCount: number | null;
    retrievedAt: string;
  } | null;
}

/** Request-to-result trace (UI_UX_SPEC §4.3/§4.4). Shows only redacted, stored metadata. */
export function TraceDialog({
  evidenceId,
  invocationId,
  onClose,
  rule,
}: {
  evidenceId?: string;
  invocationId?: string;
  onClose: () => void;
  rule?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [evidence, setEvidence] = useState<EvidenceTraceData | null>(null);
  const [invocation, setInvocation] = useState<InvocationTrace | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ref.current?.showModal();
    if (evidenceId)
      void api
        .get<EvidenceTraceData>(`/api/v1/evidence/${evidenceId}/trace`)
        .then((t) => {
          setEvidence(t);
          setInvocation(t.invocation);
        })
        .catch((e: Error) => setError(e.message));
    else if (invocationId)
      void api
        .get<InvocationTrace>(`/api/v1/invocations/${invocationId}`)
        .then(setInvocation)
        .catch((e: Error) => setError(e.message));
  }, [evidenceId, invocationId]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="trace-title"
      className="m-auto w-[min(720px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <h2 id="trace-title" className="font-serif text-xl">
          Trace: request to result
        </h2>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close trace"
          onClick={() => ref.current?.close()}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="max-h-[70vh] space-y-5 overflow-y-auto px-5 py-4 text-sm">
        {error ? (
          <p role="alert" className="text-rust">
            {error}
          </p>
        ) : null}
        {!invocation && !error ? <p>Loading…</p> : null}
        {evidence ? (
          <section>
            <h3 className="font-semibold">Claim and evaluator</h3>
            <p className="mt-1">{evidence.claim.statement}</p>
            <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Stance</dt>
              <dd className="font-semibold">{evidence.evidence.stance}</dd>
              <dt className="text-muted-foreground">Evaluator rule</dt>
              <dd className="font-mono text-xs">
                {evidence.evidence.evaluatorId}
              </dd>
              {rule ? (
                <>
                  <dt className="text-muted-foreground">Why</dt>
                  <dd>{rule}</dd>
                </>
              ) : null}
              <dt className="text-muted-foreground">Measure</dt>
              <dd>
                {evidence.evidence.primaryMeasure
                  .replace(/_/g, " ")
                  .toLowerCase()}{" "}
                (aggregate signal)
              </dd>
              <dt className="text-muted-foreground">Quality</dt>
              <dd>{evidence.evidence.quality}</dd>
            </dl>
            {evidence.evidence.facts.length ? (
              <table className="mt-3 w-full text-left text-xs">
                <caption className="sr-only">Facts and pointer values</caption>
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="py-1 font-medium">Fact</th>
                    <th className="py-1 font-medium">JSON pointer</th>
                    <th className="py-1 font-medium">Value</th>
                    <th className="py-1 font-medium">Verified</th>
                  </tr>
                </thead>
                <tbody>
                  {evidence.evidence.facts.map((f, i) => (
                    <tr
                      key={i}
                      className="border-t border-border align-top"
                      data-testid="trace-fact"
                    >
                      <td className="py-1 pr-2">{f.statement}</td>
                      <td className="py-1 pr-2 font-mono">{f.jsonPointer}</td>
                      <td className="py-1 pr-2 font-mono">
                        {JSON.stringify(f.value)}
                      </td>
                      <td className="py-1">
                        {f.verifiedAtIngest ? "at ingest ✓" : "not verified"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">
                This evaluator recorded no numeric facts.
              </p>
            )}
          </section>
        ) : null}
        {invocation ? (
          <section>
            <h3 className="font-semibold">Qloo request (redacted)</h3>
            <dl className="mt-2 grid grid-cols-[10rem_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">Workflow</dt>
              <dd className="font-mono text-xs">
                {invocation.workflow} ({invocation.method})
              </dd>
              <dt className="text-muted-foreground">Envelope status</dt>
              <dd data-testid="trace-envelope">
                {invocation.envelopeStatus} · {invocation.envelopeShape}
                {invocation.resultCount !== null
                  ? ` · ${invocation.resultCount} results`
                  : ""}
                {invocation.errorCode ? ` · ${invocation.errorCode}` : ""}
              </dd>
              <dt className="text-muted-foreground">Data origin</dt>
              <dd>
                {invocation.dataOrigin === "FIXTURE"
                  ? "FIXTURE — not Qloo data"
                  : invocation.dataOrigin}
              </dd>
              <dt className="text-muted-foreground">Transport</dt>
              <dd>{invocation.transport}</dd>
              <dt className="text-muted-foreground">Retrieved</dt>
              <dd>{new Date(invocation.retrievedAt).toLocaleString()}</dd>
              <dt className="text-muted-foreground">Request hash</dt>
              <dd className="truncate font-mono text-xs">
                {invocation.requestHash}
              </dd>
            </dl>
            <pre
              className="mt-2 overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-xs"
              data-testid="trace-args"
            >
              {JSON.stringify(invocation.argsRedacted, null, 2)}
            </pre>
            {invocation.harnessRequests.length ? (
              <ul className="mt-2 space-y-1 font-mono text-xs">
                {invocation.harnessRequests.map((r, i) => (
                  <li key={i}>
                    {r.method} {r.path} {JSON.stringify(r.query)}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2 text-xs text-muted-foreground">
              {evidence?.snapshot?.rawRetained
                ? "The raw response is retained and can be re-verified."
                : "Raw responses are not retained (storage permission pending); pointer values were verified when the response arrived."}
            </p>
          </section>
        ) : null}
      </div>
    </dialog>
  );
}
