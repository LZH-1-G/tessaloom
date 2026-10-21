"use client";

import { ArrowRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiRequestError } from "@/lib/api";
import type { RunView, SystemStatus } from "@/lib/types";
import { ModeBanner, TopBar } from "./app-shell";
import { Button, Card, EmptyState, Field, inputClass, Skeleton } from "./ui";

interface ProjectSummary {
  id: string;
  name: string;
  useCase: string;
  updatedAt: string;
  briefCount: number;
  latestExperiment: {
    id: string;
    status: string;
    latestRun: RunView | null;
  } | null;
}

const USE_CASES = [
  ["bookstore", "Bookstore"],
  ["cafe", "Café"],
  ["venue", "Venue"],
  ["community_event", "Community event"],
  ["other", "Other"],
] as const;

export function Dashboard() {
  const router = useRouter();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [name, setName] = useState("");
  const [useCase, setUseCase] = useState<string>("cafe");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api
      .get<{ items: ProjectSummary[] }>("/api/v1/projects")
      .then((r) => setProjects(r.items))
      .catch((e: Error) => setError(e.message));
    void api
      .get<SystemStatus>("/api/v1/system/status")
      .then(setStatus)
      .catch(() => {});
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Give the project a name.");
    setBusy(true);
    try {
      const project = await api.post<{ id: string }>("/api/v1/projects", {
        name: name.trim(),
        useCase,
      });
      router.push(`/projects/${project.id}/brief`);
    } catch (e) {
      setError(
        e instanceof ApiRequestError
          ? e.message
          : "Could not create the project.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <ModeBanner status={status} />
      <TopBar status={status} />
      <main id="main" className="mx-auto max-w-[1200px] px-4 py-10 sm:px-6">
        <section className="tl-warp-texture relative overflow-hidden rounded-2xl border border-border bg-surface px-6 py-10 sm:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            Cultural experimentation studio
          </p>
          <h1 className="mt-3 max-w-2xl font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
            Where different worlds create new possibilities.
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
            Describe your venue and the cultures you love. Tessaloom weaves
            cross-domain hypotheses and tests each one against aggregate Qloo
            audience-affinity data, showing exactly where every fact came from.
          </p>
          <ol
            className="mt-8 grid gap-3 sm:grid-cols-3"
            aria-label="How it works"
          >
            {[
              ["Brief", "Your challenge and 2–6 cultural interests."],
              ["Hypotheses", "Collisions tested with Qloo evidence."],
              ["What-if & blueprint", "Branch, compare, and compose."],
            ].map(([title, text], i) => (
              <li
                key={title}
                className="rounded-lg border border-border bg-background/70 p-4"
              >
                <p className="font-mono text-xs text-weft">0{i + 1}</p>
                <p className="mt-1 font-medium">{title}</p>
                <p className="text-sm text-muted-foreground">{text}</p>
              </li>
            ))}
          </ol>
        </section>

        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1fr)_340px]">
          <section aria-labelledby="projects-heading">
            <h2 id="projects-heading" className="mb-4 font-serif text-2xl">
              Your projects
            </h2>
            {projects === null ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
              </div>
            ) : projects.length === 0 ? (
              <EmptyState title="An empty loom.">
                Your experiments will appear here. Start a project to weave your
                first brief.
              </EmptyState>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {projects.map((p) => {
                  const run = p.latestExperiment?.latestRun;
                  const needsInput = run?.state.startsWith("AWAITING_");
                  return (
                    <li key={p.id}>
                      <Link
                        href={`/projects/${p.id}/brief`}
                        className="group block h-full rounded-lg border border-border bg-card p-5 transition-colors hover:border-warp"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-serif text-xl">{p.name}</p>
                          <ArrowRight
                            aria-hidden
                            className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
                          />
                        </div>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {USE_CASES.find(([v]) => v === p.useCase)?.[1]} ·{" "}
                          {p.briefCount} brief version
                          {p.briefCount === 1 ? "" : "s"}
                        </p>
                        <p className="mt-3 text-xs">
                          {run ? (
                            <span
                              className={
                                needsInput
                                  ? "rounded bg-saffron-tint px-1.5 py-0.5 font-semibold"
                                  : "font-mono uppercase text-muted-foreground"
                              }
                            >
                              {needsInput
                                ? "Needs your input"
                                : run.state.replace(/_/g, " ").toLowerCase()}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              No experiment yet
                            </span>
                          )}
                        </p>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <Card className="h-fit p-5">
            <h2 className="font-serif text-xl">Start a new project</h2>
            <form onSubmit={create} className="mt-4 space-y-4" noValidate>
              <Field
                label="Project name"
                htmlFor="project-name"
                error={error ?? undefined}
              >
                <input
                  id="project-name"
                  className={inputClass}
                  value={name}
                  maxLength={80}
                  onChange={(e) => setName(e.target.value)}
                  aria-invalid={!!error}
                  aria-describedby={error ? "project-name-error" : undefined}
                  placeholder="Midnight Margins"
                />
              </Field>
              <Field label="Use case" htmlFor="use-case">
                <select
                  id="use-case"
                  className={inputClass}
                  value={useCase}
                  onChange={(e) => setUseCase(e.target.value)}
                >
                  {USE_CASES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Button type="submit" className="w-full" disabled={busy}>
                <Plus aria-hidden className="size-4" /> Create project
              </Button>
            </form>
            <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">System status</p>
              <p className="mt-1">
                Agent worker:{" "}
                {status ? (status.workerOnline ? "online" : "offline") : "…"}
              </p>
              <p>
                Qloo adapter:{" "}
                {status?.qlooReady
                  ? `ready (${status.qlooTransport})`
                  : "unavailable"}
              </p>
            </div>
          </Card>
        </div>
      </main>
    </div>
  );
}
