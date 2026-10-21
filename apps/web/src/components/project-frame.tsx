"use client";

import Link from "next/link";
import { ActivityDock } from "./activity-dock";
import { ModeBanner, ProjectRail, TopBar } from "./app-shell";
import { useProject } from "./project-context";

export function ProjectFrame({ children }: { children: React.ReactNode }) {
  const { projectId, overview, view, run, status, refresh, error } =
    useProject();
  const hasDiscovery = (view?.resolutions.length ?? 0) > 0;
  const hasHypotheses = (view?.hypotheses.length ?? 0) > 0;
  return (
    <div className="min-h-screen">
      <ModeBanner status={status} />
      <TopBar status={status}>
        <span aria-hidden className="text-muted-foreground">
          /
        </span>
        <Link
          href="/"
          className="truncate text-sm text-muted-foreground hover:text-foreground"
        >
          Projects
        </Link>
        {overview ? (
          <>
            <span aria-hidden className="text-muted-foreground">
              /
            </span>
            <span
              className="truncate text-sm font-medium"
              data-testid="project-name"
            >
              {overview.project.name}
            </span>
          </>
        ) : null}
      </TopBar>
      <div className="mx-auto grid max-w-[1500px] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[180px_minmax(0,1fr)] xl:grid-cols-[180px_minmax(0,1fr)_340px]">
        <ProjectRail
          projectId={projectId}
          reachable={{
            discovery: hasDiscovery ? null : "Confirm your brief first",
            hypotheses: hasHypotheses
              ? null
              : "Generate hypotheses from the collision pool first",
          }}
        />
        <main id="main" className="min-w-0">
          {error ? (
            <p
              role="alert"
              className="mb-4 rounded-md border border-rust/60 bg-rust/5 p-3 text-sm text-rust"
            >
              {error === "Not found."
                ? "We couldn't find that project in this workspace."
                : error}
            </p>
          ) : null}
          {children}
        </main>
        <div className="xl:sticky xl:top-4 xl:self-start">
          <ActivityDock
            run={run}
            projectId={projectId}
            onChange={() => void refresh()}
          />
        </div>
      </div>
    </div>
  );
}
