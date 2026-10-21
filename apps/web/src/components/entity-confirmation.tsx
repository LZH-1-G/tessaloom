"use client";

import { Ban, PencilLine } from "lucide-react";
import { useState } from "react";
import { api } from "@/lib/api";
import type { ResolutionView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DomainBadge, typeDomain } from "./provenance";
import { Button, inputClass } from "./ui";

type Choice =
  | { type: "candidate"; qlooId: string }
  | { type: "refine"; text: string }
  | { type: "exclude" };

const SOURCE: Record<string, string> = {
  selected: "Qloo's exact-name pick",
  alternative: "Alternative",
  issue_candidate: "Candidate",
  search: "Search result",
};

/**
 * Gate H2 (UI_UX_SPEC §4.3). Candidates are never pre-selected when ambiguous (CI-2); each
 * card shows only the fields Qloo returned (CI-3), including the type (V1 finding 2).
 */
export function EntityConfirmation({
  runId,
  rows,
  interests,
  onDone,
}: {
  runId: string;
  rows: ResolutionView[];
  interests: string[];
  onDone: () => void;
}) {
  const [choices, setChoices] = useState<Record<number, Choice | undefined>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (index: number) => interests[index] ?? "Venue locality";
  const complete = rows.every((r) => {
    const c = choices[r.interestIndex ?? -1];
    return c && (c.type !== "refine" || c.text.trim().length > 0);
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/v1/runs/${runId}/confirmations`, {
        kind: "ENTITIES",
        selections: rows.map((r) => ({
          interestIndex: r.interestIndex,
          choice: choices[r.interestIndex ?? -1],
        })),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      aria-labelledby="h2-heading"
      className="rounded-xl border-2 border-saffron bg-card p-5"
    >
      <h2 id="h2-heading" className="font-serif text-2xl">
        Which ones did you mean?
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Qloo returned several possibilities. Pick one, refine the search text,
        or leave the interest out. Nothing is chosen for you.
      </p>
      <div className="mt-5 space-y-6">
        {rows.map((r) => {
          const index = r.interestIndex ?? -1;
          const choice = choices[index];
          const name = `h2-${index}`;
          const all = [
            ...r.candidates.entities.map((c) => ({
              id: c.qlooId,
              name: c.name,
              domain: typeDomain(c.type),
              detail: c.disambiguation ?? c.description,
              popularity: c.popularity,
              source: SOURCE[c.source] ?? c.source,
              legacy: c.legacyType,
            })),
            ...r.candidates.tags.map((t) => ({
              id: t.tagId,
              name: t.name,
              domain: "tag",
              detail: t.tagType?.replace("urn:tag:", "Tag type: "),
              popularity: t.popularity,
              source: "Tag",
              legacy: false,
            })),
          ];
          return (
            <fieldset
              key={r.id}
              className="rounded-lg border border-border p-4"
              data-testid={`h2-row-${index}`}
            >
              <legend className="px-1 text-sm">
                <span className="text-muted-foreground">You wrote </span>
                <span className="font-semibold">“{r.inputText}”</span>
                <span className="text-muted-foreground">
                  {" "}
                  (
                  {r.requestedKind === "locality"
                    ? "venue locality"
                    : label(index)}
                  )
                </span>
              </legend>
              {all.length === 0 ? (
                <p className="mt-1 text-sm">
                  Qloo found no match for “{r.inputText}”. Refine the text or
                  exclude it.
                </p>
              ) : null}
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {all.map((c) => (
                  <label
                    key={c.id}
                    aria-label={`Use ${c.name}${c.domain ? `, ${c.domain}` : ""}${c.detail ? `, ${c.detail}` : ""}`}
                    className={cn(
                      "cursor-pointer rounded-lg border bg-background p-3 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-warp",
                      choice?.type === "candidate" && choice.qlooId === c.id
                        ? "border-warp ring-2 ring-warp/30"
                        : "border-border hover:border-warp/60",
                    )}
                  >
                    <span className="flex items-start gap-2">
                      <input
                        type="radio"
                        aria-label={`Use ${c.name}${c.domain ? `, ${c.domain}` : ""}${c.detail ? `, ${c.detail}` : ""}`}
                        name={name}
                        className="mt-1"
                        checked={
                          choice?.type === "candidate" && choice.qlooId === c.id
                        }
                        onChange={() =>
                          setChoices({
                            ...choices,
                            [index]: { type: "candidate", qlooId: c.id },
                          })
                        }
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{c.name}</span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <DomainBadge domain={c.domain} />
                          {c.legacy ? (
                            <span className="text-[11px] text-muted-foreground">
                              legacy type
                            </span>
                          ) : null}
                          <span className="text-[11px] text-muted-foreground">
                            {c.source}
                          </span>
                          {typeof c.popularity === "number" ? (
                            <span className="font-mono text-[11px] text-muted-foreground">
                              popularity {c.popularity.toFixed(2)}
                            </span>
                          ) : null}
                        </span>
                        {c.detail ? (
                          <span className="mt-1 block text-xs text-muted-foreground">
                            {c.detail}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={name}
                    checked={choice?.type === "refine"}
                    onChange={() =>
                      setChoices({
                        ...choices,
                        [index]: { type: "refine", text: r.inputText },
                      })
                    }
                  />
                  <PencilLine aria-hidden className="size-4" /> Refine
                </label>
                {choice?.type === "refine" ? (
                  <>
                    <label htmlFor={`refine-${index}`} className="sr-only">
                      Refined search text for {r.inputText}
                    </label>
                    <input
                      id={`refine-${index}`}
                      className={cn(inputClass, "w-64")}
                      value={choice.text}
                      maxLength={120}
                      onChange={(e) =>
                        setChoices({
                          ...choices,
                          [index]: { type: "refine", text: e.target.value },
                        })
                      }
                    />
                  </>
                ) : null}
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name={name}
                    checked={choice?.type === "exclude"}
                    onChange={() =>
                      setChoices({ ...choices, [index]: { type: "exclude" } })
                    }
                  />
                  <Ban aria-hidden className="size-4" /> Exclude
                </label>
              </div>
            </fieldset>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-rust">
          {error}
        </p>
      ) : null}
      <Button className="mt-5" onClick={submit} disabled={!complete || busy}>
        Confirm choices
      </Button>
      {!complete ? (
        <span className="ml-3 text-xs text-muted-foreground">
          Make a choice for every row.
        </span>
      ) : null}
    </section>
  );
}
