"use client";

import { CheckCircle2, CircleHelp, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import type { BriefContent, BriefVersion, IntentFrameView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { JUDGE_BRIEF } from "@/lib/judge-scenario";
import { useProject } from "./project-context";
import { DOMAIN_LABEL, DomainBadge, ProvenanceChip } from "./provenance";
import { Button, Card, Field, inputClass, SectionTitle } from "./ui";

const DOMAINS = [
  "book",
  "artist",
  "movie",
  "tv_show",
  "podcast",
  "videogame",
  "place",
  "brand",
  "destination",
  "person",
] as const;
const VENUES = [
  ["bookstore", "Bookstore"],
  ["cafe", "Café"],
  ["bar", "Bar"],
  ["gallery", "Gallery"],
  ["library", "Library"],
  ["small_venue", "Small venue"],
  ["outdoor", "Outdoor"],
  ["online", "Online"],
  ["other", "Other"],
] as const;
const DEFAULT_TARGETS = ["artist", "book", "movie", "place"];

interface FormState {
  title: string;
  challenge: string;
  interests: { text: string; domainHint: string }[];
  venueType: string;
  localityText: string;
  capacity: string;
  budgetBand: string;
  durationMinutes: string;
  notes: string;
  goals: string[];
  targets: string[];
}

const empty: FormState = {
  title: "",
  challenge: "",
  interests: [
    { text: "", domainHint: "" },
    { text: "", domainHint: "" },
  ],
  venueType: "cafe",
  localityText: "",
  capacity: "",
  budgetBand: "",
  durationMinutes: "",
  notes: "",
  goals: [""],
  targets: DEFAULT_TARGETS,
};

function fromBrief(b: BriefContent, targets?: string[]): FormState {
  return {
    title: b.title,
    challenge: b.challenge,
    interests: b.interests.map((i) => ({
      text: i.text,
      domainHint: i.domainHint ?? "",
    })),
    venueType: b.venue.type,
    localityText: b.venue.localityText ?? "",
    capacity: b.venue.capacity ? String(b.venue.capacity) : "",
    budgetBand: b.constraints.budgetBand ?? "",
    durationMinutes: b.constraints.durationMinutes
      ? String(b.constraints.durationMinutes)
      : "",
    notes: (b.constraints.notes ?? []).join(", "),
    goals: b.goals.length ? b.goals : [""],
    targets: targets ?? DEFAULT_TARGETS,
  };
}

/** Client-side mirror of BriefInput (the server validates again). */
export function validateBrief(f: FormState): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!f.title.trim() || f.title.trim().length > 120)
    errors.title = "Give the brief a title (up to 120 characters).";
  const challenge = f.challenge.trim();
  if (challenge.length < 20)
    errors.challenge = "Describe the challenge in at least 20 characters.";
  else if (challenge.length > 2000)
    errors.challenge = "Keep the challenge under 2000 characters.";
  const interests = f.interests.map((i) => i.text.trim()).filter(Boolean);
  if (interests.length < 2)
    errors.interests = "Add at least two interests from different worlds.";
  else if (
    new Set(interests.map((i) => i.toLowerCase())).size !== interests.length
  )
    errors.interests = "Each interest can appear only once.";
  else if (interests.some((i) => i.length > 120))
    errors.interests = "Keep each interest under 120 characters.";
  if (
    f.capacity &&
    (!/^\d+$/.test(f.capacity) ||
      Number(f.capacity) < 1 ||
      Number(f.capacity) > 5000)
  )
    errors.capacity = "Capacity must be a whole number from 1 to 5000.";
  if (
    f.durationMinutes &&
    (!/^\d+$/.test(f.durationMinutes) ||
      Number(f.durationMinutes) < 15 ||
      Number(f.durationMinutes) > 1440)
  )
    errors.durationMinutes = "Duration must be 15 to 1440 minutes.";
  if (f.goals.some((g) => g.trim().length > 140))
    errors.goals = "Keep each goal under 140 characters.";
  if (f.targets.length < 1)
    errors.targets = "Pick at least one world to explore.";
  return errors;
}

function toBrief(f: FormState): BriefContent {
  const notes = f.notes
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return {
    title: f.title.trim(),
    challenge: f.challenge.trim(),
    interests: f.interests
      .filter((i) => i.text.trim())
      .map((i) => ({
        text: i.text.trim(),
        ...(i.domainHint ? { domainHint: i.domainHint } : {}),
      })),
    venue: {
      type: f.venueType,
      ...(f.localityText.trim() ? { localityText: f.localityText.trim() } : {}),
      ...(f.capacity ? { capacity: Number(f.capacity) } : {}),
    },
    constraints: {
      ...(f.budgetBand ? { budgetBand: f.budgetBand } : {}),
      ...(f.durationMinutes
        ? { durationMinutes: Number(f.durationMinutes) }
        : {}),
      ...(notes.length ? { notes } : {}),
    },
    goals: f.goals
      .map((g) => g.trim())
      .filter(Boolean)
      .slice(0, 5),
  };
}

function BriefCard({
  brief,
  heading = "Brief card",
}: {
  brief: BriefContent;
  heading?: string;
}) {
  return (
    <Card className="p-5" aria-label={heading}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {heading}
        </p>
        <ProvenanceChip provenance="USER_PROVIDED" />
      </div>
      <p className="mt-3 font-serif text-2xl leading-snug">
        {brief.title || "Untitled brief"}
      </p>
      <p className="mt-2 whitespace-pre-line text-sm text-muted-foreground">
        {brief.challenge || "Your creative challenge will appear here."}
      </p>
      <ul className="mt-4 flex flex-wrap gap-2" aria-label="Interests">
        {brief.interests.map((i) => (
          <li
            key={i.text}
            className="flex items-center gap-1.5 rounded-full border border-warp/40 bg-background px-3 py-1 text-sm"
          >
            {i.text}
            {i.domainHint ? <DomainBadge domain={i.domainHint} /> : null}
          </li>
        ))}
      </ul>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-sm">
        <dt className="text-muted-foreground">Venue</dt>
        <dd>
          {VENUES.find(([v]) => v === brief.venue.type)?.[1]}
          {brief.venue.capacity ? ` · ${brief.venue.capacity} guests` : ""}
          {brief.venue.localityText ? ` · ${brief.venue.localityText}` : ""}
        </dd>
        {brief.constraints.budgetBand ? (
          <>
            <dt className="text-muted-foreground">Budget</dt>
            <dd className="capitalize">{brief.constraints.budgetBand}</dd>
          </>
        ) : null}
        {brief.constraints.durationMinutes ? (
          <>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{brief.constraints.durationMinutes} min</dd>
          </>
        ) : null}
      </dl>
      {brief.goals.length ? (
        <ul className="mt-3 list-disc pl-5 text-sm">
          {brief.goals.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function IntentPanel({
  intent,
  brief,
  targets,
  onConfirm,
  onEdit,
  busy,
}: {
  intent: IntentFrameView;
  brief: BriefVersion;
  targets: string[];
  onConfirm: (edits: { interestIndex: number; domain: string }[]) => void;
  onEdit: () => void;
  busy: boolean;
}) {
  const [domains, setDomains] = useState(() =>
    intent.interests.map(
      (i, idx) => brief.content.interests[idx]?.domainHint ?? i.guessedDomain,
    ),
  );
  const edits = domains
    .map((domain, interestIndex) => ({ interestIndex, domain }))
    .filter(
      ({ interestIndex, domain }) =>
        domain !==
        (brief.content.interests[interestIndex]?.domainHint ??
          intent.interests[interestIndex]?.guessedDomain),
    );
  return (
    <section
      aria-labelledby="h1-heading"
      className="rounded-xl border-2 border-saffron bg-card p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="h1-heading" className="font-serif text-2xl">
          Did we read your brief right?
        </h2>
        <ProvenanceChip provenance="MODEL_INTERPRETATION" />
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        {intent.decisionSummary}
      </p>
      <h3 className="mt-5 text-sm font-semibold">Interests and their worlds</h3>
      <p className="text-xs text-muted-foreground">
        Change a world if the guess is off — it decides how Tessaloom searches
        Qloo.
      </p>
      <ul className="mt-3 grid gap-2 @container">
        {intent.interests.map((interest, i) => (
          <li
            key={i}
            className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
          >
            <span className="min-w-0 truncate font-medium">
              {brief.content.interests[i]?.text ?? interest.text}
            </span>
            <label className="sr-only" htmlFor={`intent-domain-${i}`}>
              World for {interest.text}
            </label>
            <select
              id={`intent-domain-${i}`}
              className={cn(inputClass, "w-auto py-1 text-xs")}
              value={domains[i]}
              onChange={(e) =>
                setDomains(
                  domains.map((d, j) => (j === i ? e.target.value : d)),
                )
              }
            >
              <option value="unknown">Not sure (search tags too)</option>
              {DOMAINS.map((d) => (
                <option key={d} value={d}>
                  {DOMAIN_LABEL[d]}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
      {intent.ambiguities.length ? (
        <ul className="mt-4 space-y-2" aria-label="Ambiguities">
          {intent.ambiguities.map((a) => (
            <li
              key={a.interestIndex}
              className="flex gap-2 rounded-md bg-saffron-tint px-3 py-2 text-sm"
            >
              <CircleHelp aria-hidden className="mt-0.5 size-4 shrink-0" />
              {a.question}
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground">Worlds to explore</dt>
          <dd className="mt-1 flex flex-wrap gap-1">
            {targets.map((t) => (
              <DomainBadge key={t} domain={t} />
            ))}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Venue</dt>
          <dd className="mt-1">
            {VENUES.find(([v]) => v === intent.venue.type)?.[1] ??
              intent.venue.type}
            {intent.venue.capacity ? ` · ${intent.venue.capacity}` : ""}
            {intent.venue.locality ? ` · ${intent.venue.locality}` : ""}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Goals</dt>
          <dd className="mt-1">{intent.goals.join("; ") || "—"}</dd>
        </div>
      </dl>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button onClick={() => onConfirm(edits)} disabled={busy}>
          <CheckCircle2 aria-hidden className="size-4" /> Confirm &amp; discover
        </Button>
        <Button variant="secondary" onClick={onEdit} disabled={busy}>
          <Pencil aria-hidden className="size-4" /> Edit brief
        </Button>
        {edits.length ? (
          <span className="self-center text-xs text-muted-foreground">
            {edits.length} world change{edits.length === 1 ? "" : "s"} will be
            applied (labelled “You”).
          </span>
        ) : null}
      </div>
    </section>
  );
}

function Shuttle({ text }: { text: string }) {
  return (
    <div
      role="status"
      className="flex items-center gap-4 rounded-xl border border-border bg-card p-5"
    >
      <svg aria-hidden viewBox="0 0 120 24" className="h-6 w-28 shrink-0">
        {[20, 40, 60, 80, 100].map((x) => (
          <line
            key={x}
            x1={x}
            y1="2"
            x2={x}
            y2="22"
            stroke="var(--tl-warp)"
            strokeWidth="2"
            opacity="0.5"
          />
        ))}
        <rect
          y="9"
          width="18"
          height="6"
          rx="3"
          fill="var(--tl-weft)"
          className="motion-safe:animate-[shuttle_1.6s_ease-in-out_infinite_alternate]"
        />
      </svg>
      <p className="text-sm">{text}</p>
      <style>{`@keyframes shuttle { from { transform: translateX(0) } to { transform: translateX(100px) } }`}</style>
    </div>
  );
}

export function BriefPage() {
  const { projectId, overview, view, run, refresh, loading, status } =
    useProject();
  const latest = overview?.briefs[0] ?? null;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<string>("");

  const targets =
    view?.experiment.definition.variables.targetDomains ?? DEFAULT_TARGETS;
  // With no brief yet, the form is the page.
  const showForm = editing || (!loading && !latest);

  const preview = useMemo(() => toBrief(form), [form]);
  const viewing =
    overview?.briefs.find((b) => b.id === selectedVersion) ?? null;
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const startEditing = () => {
    setForm(latest ? fromBrief(latest.content, targets) : empty);
    setErrors({});
    setEditing(true);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const found = validateBrief(form);
    setErrors(found);
    if (Object.keys(found).length) {
      document.getElementById(`brief-${Object.keys(found)[0]}`)?.focus();
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      // A new version supersedes the current run (it no longer matches the brief).
      if (
        run &&
        !["COMPLETED", "COMPLETED_WITH_LIMITS", "FAILED", "CANCELLED"].includes(
          run.state,
        )
      )
        await api.post(`/api/v1/runs/${run.id}/cancel`);
      const brief = await api.post<{ id: string }>(
        `/api/v1/projects/${projectId}/briefs`,
        toBrief(form),
      );
      await api.post(
        `/api/v1/projects/${projectId}/experiments`,
        {
          briefVersionId: brief.id,
          mode: "live",
          variables: { targetDomains: form.targets },
        },
        { "Idempotency-Key": crypto.randomUUID() },
      );
      setEditing(false);
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === "VALIDATION_FAILED")
        setMessage("Some fields need attention.");
      else
        setMessage(
          e instanceof ApiRequestError
            ? e.message
            : "Could not save the brief.",
        );
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const confirm = async (
    edits: { interestIndex: number; domain: string }[],
  ) => {
    if (!run || !view?.brief) return;
    setBusy(true);
    try {
      await api.post(`/api/v1/runs/${run.id}/confirmations`, {
        kind: "BRIEF",
        briefVersionId: view.brief.id,
        action: "confirm",
        ...(edits.length ? { interestDomains: edits } : {}),
      });
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const state = run?.state ?? null;
  const intent = view?.brief?.intentFrame ?? null;

  return (
    <div>
      <SectionTitle eyebrow="Step 1" title="Creative brief">
        {overview && overview.briefs.length > 0 ? (
          <div className="flex items-center gap-2">
            <label
              htmlFor="brief-version"
              className="text-sm text-muted-foreground"
            >
              Version
            </label>
            <select
              id="brief-version"
              className={cn(inputClass, "w-auto")}
              value={selectedVersion}
              onChange={(e) => setSelectedVersion(e.target.value)}
            >
              <option value="">Current (v{latest?.version})</option>
              {overview.briefs.slice(1).map((b) => (
                <option key={b.id} value={b.id}>
                  v{b.version} · {b.createdAt.slice(0, 10)} (read-only)
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </SectionTitle>

      {message ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-rust/60 bg-rust/5 px-3 py-2 text-sm text-rust"
        >
          {message}
        </p>
      ) : null}

      {viewing ? (
        <BriefCard
          brief={viewing.content}
          heading={`Version ${viewing.version} (read-only)`}
        />
      ) : showForm ? (
        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <form
            onSubmit={submit}
            noValidate
            className="@container space-y-5"
            aria-label="Brief form"
          >
            {!latest &&
            status?.mode === "fixture" &&
            !form.title &&
            !form.challenge ? (
              <div className="rounded-lg border border-border bg-surface-2 p-4 text-sm">
                <p className="font-medium">
                  Try a complete cultural experiment
                </p>
                <p className="mt-1 text-muted-foreground">
                  Bring cozy games, illustrated travel stories and neon cinema
                  into a 40-seat supper club. All titles and affinity data in
                  this example are fictional.
                </p>
                <Button
                  type="button"
                  variant="secondary"
                  className="mt-3"
                  onClick={() => {
                    setForm(fromBrief(JUDGE_BRIEF));
                    setErrors({});
                  }}
                >
                  Use the fixture example
                </Button>
              </div>
            ) : null}
            <Field label="Title" htmlFor="brief-title" error={errors.title}>
              <input
                id="brief-title"
                className={inputClass}
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                maxLength={120}
                aria-invalid={!!errors.title}
                aria-describedby={
                  errors.title ? "brief-title-error" : undefined
                }
              />
            </Field>
            <Field
              label="Creative challenge"
              htmlFor="brief-challenge"
              hint="What do you want to create, for whom, and why now?"
              error={errors.challenge}
            >
              <textarea
                id="brief-challenge"
                rows={4}
                className={inputClass}
                value={form.challenge}
                onChange={(e) => set("challenge", e.target.value)}
                aria-invalid={!!errors.challenge}
                aria-describedby={
                  errors.challenge
                    ? "brief-challenge-error"
                    : "brief-challenge-hint"
                }
                placeholder="A 40-seat café wants a recurring weekday evening that brings film lovers and music fans together."
              />
            </Field>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">
                Cultural interests (2–6)
              </legend>
              <p className="text-xs text-muted-foreground">
                Name the books, artists, films, places, or themes your audience
                loves. Pick a world if you know it.
              </p>
              {form.interests.map((interest, i) => (
                <div key={i} className="flex gap-2">
                  <label
                    className="sr-only"
                    htmlFor={
                      i === 0 ? "brief-interests" : `brief-interest-${i}`
                    }
                  >
                    Interest {i + 1}
                  </label>
                  <input
                    id={i === 0 ? "brief-interests" : `brief-interest-${i}`}
                    className={inputClass}
                    value={interest.text}
                    maxLength={120}
                    aria-invalid={!!errors.interests}
                    aria-describedby={
                      errors.interests ? "brief-interests-error" : undefined
                    }
                    onChange={(e) =>
                      set(
                        "interests",
                        form.interests.map((x, j) =>
                          j === i ? { ...x, text: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder={
                      [
                        "e.g. a novelist",
                        "e.g. a music scene",
                        "e.g. a film",
                        "e.g. a game",
                      ][i] ?? "Another interest"
                    }
                  />
                  <label
                    className="sr-only"
                    htmlFor={`brief-interest-domain-${i}`}
                  >
                    World for interest {i + 1}
                  </label>
                  <select
                    id={`brief-interest-domain-${i}`}
                    className={cn(inputClass, "w-40 shrink-0")}
                    value={interest.domainHint}
                    onChange={(e) =>
                      set(
                        "interests",
                        form.interests.map((x, j) =>
                          j === i ? { ...x, domainHint: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">Any world</option>
                    {DOMAINS.map((d) => (
                      <option key={d} value={d}>
                        {DOMAIN_LABEL[d]}
                      </option>
                    ))}
                  </select>
                  {form.interests.length > 2 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove interest ${i + 1}`}
                      onClick={() =>
                        set(
                          "interests",
                          form.interests.filter((_, j) => j !== i),
                        )
                      }
                    >
                      <Trash2 aria-hidden className="size-4" />
                    </Button>
                  ) : null}
                </div>
              ))}
              {errors.interests ? (
                <p
                  id="brief-interests-error"
                  role="alert"
                  className="text-xs font-medium text-rust"
                >
                  <span aria-hidden>⚠ </span>
                  {errors.interests}
                </p>
              ) : null}
              {form.interests.length < 6 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    set("interests", [
                      ...form.interests,
                      { text: "", domainHint: "" },
                    ])
                  }
                >
                  <Plus aria-hidden className="size-4" /> Add interest
                </Button>
              ) : null}
            </fieldset>
            <div className="grid gap-4 @xl:grid-cols-3">
              <Field label="Venue type" htmlFor="brief-venue">
                <select
                  id="brief-venue"
                  className={inputClass}
                  value={form.venueType}
                  onChange={(e) => set("venueType", e.target.value)}
                >
                  {VENUES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field
                label="Locality (optional)"
                htmlFor="brief-locality"
                hint="Enables location evidence"
              >
                <input
                  id="brief-locality"
                  className={inputClass}
                  value={form.localityText}
                  maxLength={120}
                  onChange={(e) => set("localityText", e.target.value)}
                />
              </Field>
              <Field
                label="Capacity"
                htmlFor="brief-capacity"
                error={errors.capacity}
              >
                <input
                  id="brief-capacity"
                  inputMode="numeric"
                  className={inputClass}
                  value={form.capacity}
                  onChange={(e) => set("capacity", e.target.value)}
                  aria-invalid={!!errors.capacity}
                  aria-describedby={
                    errors.capacity ? "brief-capacity-error" : undefined
                  }
                />
              </Field>
            </div>
            <div className="grid gap-4 @xl:grid-cols-3">
              <fieldset>
                <legend className="mb-1.5 text-sm font-medium">
                  Budget band
                </legend>
                <div className="flex overflow-hidden rounded-md border border-input">
                  {["low", "medium", "high"].map((b) => (
                    <label
                      key={b}
                      className={cn(
                        "flex-1 cursor-pointer px-2 py-2 text-center text-sm capitalize has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-warp",
                        form.budgetBand === b
                          ? "bg-primary text-primary-foreground"
                          : "bg-surface",
                      )}
                    >
                      <input
                        type="radio"
                        name="budget"
                        aria-label={`${b} budget`}
                        className="sr-only"
                        checked={form.budgetBand === b}
                        onChange={() =>
                          set("budgetBand", form.budgetBand === b ? "" : b)
                        }
                        onClick={() =>
                          form.budgetBand === b && set("budgetBand", "")
                        }
                      />
                      {b}
                    </label>
                  ))}
                </div>
              </fieldset>
              <Field
                label="Duration (minutes)"
                htmlFor="brief-durationMinutes"
                error={errors.durationMinutes}
              >
                <input
                  id="brief-durationMinutes"
                  inputMode="numeric"
                  className={inputClass}
                  value={form.durationMinutes}
                  onChange={(e) => set("durationMinutes", e.target.value)}
                  aria-invalid={!!errors.durationMinutes}
                />
              </Field>
              <Field label="Notes" htmlFor="brief-notes" hint="Comma-separated">
                <input
                  id="brief-notes"
                  className={inputClass}
                  value={form.notes}
                  onChange={(e) => set("notes", e.target.value)}
                />
              </Field>
            </div>
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">Goals (up to 5)</legend>
              {form.goals.map((goal, i) => (
                <div key={i} className="flex gap-2">
                  <label
                    className="sr-only"
                    htmlFor={i === 0 ? "brief-goals" : `brief-goal-${i}`}
                  >
                    Goal {i + 1}
                  </label>
                  <input
                    id={i === 0 ? "brief-goals" : `brief-goal-${i}`}
                    className={inputClass}
                    value={goal}
                    maxLength={140}
                    onChange={(e) =>
                      set(
                        "goals",
                        form.goals.map((g, j) =>
                          j === i ? e.target.value : g,
                        ),
                      )
                    }
                    placeholder="Attract new weekday visitors"
                  />
                </div>
              ))}
              {errors.goals ? (
                <p className="text-xs text-rust">{errors.goals}</p>
              ) : null}
              {form.goals.length < 5 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => set("goals", [...form.goals, ""])}
                >
                  <Plus aria-hidden className="size-4" /> Add goal
                </Button>
              ) : null}
            </fieldset>
            <fieldset>
              <legend className="text-sm font-medium">Worlds to explore</legend>
              <p className="text-xs text-muted-foreground">
                Discovery threads each seed into these domains.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {DOMAINS.filter((d) => d !== "destination").map((d) => (
                  <label
                    key={d}
                    className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-sm has-[:checked]:border-warp has-[:checked]:bg-warp/10"
                  >
                    <input
                      id={d === "book" ? "brief-targets" : undefined}
                      type="checkbox"
                      checked={form.targets.includes(d)}
                      onChange={(e) =>
                        set(
                          "targets",
                          e.target.checked
                            ? [...form.targets, d]
                            : form.targets.filter((t) => t !== d),
                        )
                      }
                    />
                    {DOMAIN_LABEL[d]}
                  </label>
                ))}
              </div>
              {errors.targets ? (
                <p className="mt-1 text-xs text-rust">{errors.targets}</p>
              ) : null}
            </fieldset>
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted-foreground">
              Don’t include personal information. Your brief is sent to an AI
              model and stored with this project. Only the cultural interests
              you confirm are sent to Qloo.
            </p>
            <div className="flex gap-2">
              <Button type="submit" size="lg" disabled={busy}>
                Interpret brief
              </Button>
              {latest ? (
                <Button
                  variant="ghost"
                  size="lg"
                  onClick={() => setEditing(false)}
                  disabled={busy}
                >
                  Cancel
                </Button>
              ) : null}
            </div>
          </form>
          <div className="2xl:sticky 2xl:top-4 2xl:self-start">
            <BriefCard brief={preview} heading="Preview" />
          </div>
        </div>
      ) : latest ? (
        <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_380px]">
          <div className="space-y-4">
            {state === "AWAITING_BRIEF_CONFIRMATION" &&
            intent &&
            view?.brief ? (
              <IntentPanel
                key={view.brief.id}
                intent={intent}
                brief={view.brief}
                targets={targets}
                onConfirm={confirm}
                onEdit={startEditing}
                busy={busy}
              />
            ) : state === "QUEUED" || state === "ANALYZING_INTENT" ? (
              <Shuttle
                text={
                  state === "QUEUED"
                    ? "Queued — your experiment will start shortly."
                    : "Interpreting your brief…"
                }
              />
            ) : view?.brief?.confirmedAt ? (
              <Card className="p-5">
                <p className="flex items-center gap-2 font-medium text-moss">
                  <CheckCircle2 aria-hidden className="size-5" /> Brief
                  confirmed
                </p>
                <p className="mt-2 text-sm text-muted-foreground">
                  The agent is resolving your interests with Qloo and threading
                  them into other worlds.
                </p>
                <Link
                  href={`/projects/${projectId}/discovery`}
                  className="mt-3 inline-block text-sm font-medium text-warp underline underline-offset-2"
                >
                  Open the Discovery canvas
                </Link>
              </Card>
            ) : !view ? (
              <Card className="p-5 text-sm">
                <p>This brief has no experiment yet.</p>
                <Button
                  className="mt-3"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api.post(
                        `/api/v1/projects/${projectId}/experiments`,
                        { briefVersionId: latest.id, mode: "live" },
                        { "Idempotency-Key": crypto.randomUUID() },
                      );
                    } catch (e) {
                      setMessage((e as Error).message);
                    } finally {
                      setBusy(false);
                      await refresh();
                    }
                  }}
                >
                  Start experiment
                </Button>
              </Card>
            ) : null}
            <Button variant="secondary" onClick={startEditing}>
              <Pencil aria-hidden className="size-4" /> New brief version
            </Button>
          </div>
          <BriefCard
            brief={latest.content}
            heading={`Version ${latest.version}`}
          />
        </div>
      ) : null}
    </div>
  );
}
