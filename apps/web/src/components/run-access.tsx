"use client";

import { Eye, KeyRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import { Button, inputClass } from "./ui";

interface RunAccessState {
  access: "off" | "invite" | "open";
  allowed: boolean;
  grant: { label: string; expiresAt: string } | null;
}

/**
 * Paid-AI access for this workspace (M10-A public demo cost safety). The server decides; this
 * only explains it. Nothing renders when runs are open, so local development is unchanged.
 */
export function RunAccessNotice({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<RunAccessState | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<RunAccessState>("/api/v1/workspace/access")
      .then(setState)
      .catch(() => {});
  }, []);

  if (!state || state.access === "open") return null;

  const redeem = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setState(
        await api.post<RunAccessState>("/api/v1/workspace/access", {
          code: code.trim(),
        }),
      );
      setCode("");
    } catch (e) {
      setError(
        e instanceof ApiRequestError ? e.message : "Could not check the code.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (state.access === "off")
    return (
      <p
        role="status"
        data-testid="run-access"
        className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm"
      >
        New AI runs are paused on this demo. Saved projects, shared links, and
        the demo samples still work.
      </p>
    );

  if (state.allowed)
    return compact ? null : (
      <p
        role="status"
        data-testid="run-access"
        className="rounded-lg border border-moss/50 bg-card px-4 py-3 text-sm"
      >
        <KeyRound aria-hidden className="mr-1.5 inline size-4" />
        Demo access active ({state.grant?.label}) until{" "}
        {state.grant?.expiresAt.slice(0, 10)}. AI runs are capped per day and
        per experiment.
      </p>
    );

  return (
    <section
      aria-labelledby="run-access-h"
      data-testid="run-access"
      className="rounded-lg border-2 border-saffron bg-saffron-tint px-4 py-3 text-sm"
    >
      <h2 id="run-access-h" className="font-semibold">
        AI runs on this demo need an access code
      </h2>
      <p className="mt-1">
        Paid AI generation is limited to invited testers and judges. You can
        still browse the read-only demo samples and any shared links.
      </p>
      <form onSubmit={redeem} className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs" htmlFor="access-code">
          Access code
          <input
            id="access-code"
            className={`${inputClass} mt-1 h-9 w-72 font-mono`}
            value={code}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCode(e.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? "access-code-error" : undefined}
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          disabled={busy || !code.trim()}
        >
          Unlock AI runs
        </Button>
      </form>
      {error ? (
        <p id="access-code-error" role="alert" className="mt-1 text-rust">
          {error}
        </p>
      ) : null}
    </section>
  );
}

interface Sample {
  id: string;
  scope: string;
  projectName: string;
  useCase: string;
}

/** Read-only demo samples (featured project links): browsing them never starts AI work. */
export function DemoSamples() {
  const [items, setItems] = useState<Sample[] | null>(null);
  useEffect(() => {
    void fetch("/api/v1/samples", { credentials: "omit" })
      .then(async (r) =>
        r.ok ? ((await r.json()) as { items: Sample[] }) : null,
      )
      .then((r) => setItems(r?.items ?? []))
      .catch(() => setItems([]));
  }, []);
  if (!items?.length) return null;
  return (
    <section aria-labelledby="samples-h" data-testid="demo-samples">
      <h2 id="samples-h" className="mb-3 font-serif text-2xl">
        Demo samples
      </h2>
      <ul className="grid gap-3 sm:grid-cols-2">
        {items.map((s) => (
          <li key={s.id}>
            <Link
              href={`/samples/${s.id}`}
              className="block rounded-lg border border-border bg-card p-4 hover:border-warp"
            >
              <p className="font-serif text-lg">{s.projectName}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Eye aria-hidden className="size-3.5" /> Read-only · no AI run
                needed
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
