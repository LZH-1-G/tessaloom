"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api, publicGet } from "@/lib/api";
import type {
  ExperimentViewData,
  ProjectOverview,
  RunView,
  SystemStatus,
} from "@/lib/types";

interface ProjectState {
  projectId: string;
  overview: ProjectOverview | null;
  view: ExperimentViewData | null;
  run: RunView | null;
  /** The main experiment's hypothesis-loop run (never a composition run). */
  explorationRun: RunView | null;
  status: SystemStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
  /** A branch the What-if Lab is following; the dock streams its run (null = the root). */
  focusExperimentId: string | null;
  focusView: ExperimentViewData | null;
  setFocusExperiment: (id: string | null) => void;
}

const Ctx = createContext<ProjectState | null>(null);

export function useProject(): ProjectState {
  const value = useContext(Ctx);
  if (!value) throw new Error("useProject outside ProjectProvider");
  return value;
}

export function ProjectProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: React.ReactNode;
}) {
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [view, setView] = useState<ExperimentViewData | null>(null);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [focusExperimentId, setFocusExperiment] = useState<string | null>(null);
  const [focusView, setFocusView] = useState<ExperimentViewData | null>(null);
  const focusRef = useRef<string | null>(null);
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    inflight.current ??= (async () => {
      try {
        const [o, s] = await Promise.all([
          api.get<ProjectOverview>(`/api/v1/projects/${projectId}`),
          publicGet<SystemStatus>("/api/v1/system/status"),
        ]);
        setOverview(o);
        setStatus(s);
        // The project's main experiment is its latest root; branches live in the What-if Lab.
        const root =
          o.experiments.find((e) => e.kind === "ROOT") ?? o.experiments[0];
        setView(
          root
            ? await api.get<ExperimentViewData>(
                `/api/v1/experiments/${root.id}`,
              )
            : null,
        );
        const focus = focusRef.current;
        setFocusView(
          focus
            ? await api.get<ExperimentViewData>(`/api/v1/experiments/${focus}`)
            : null,
        );
        setError(null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
        inflight.current = null;
      }
    })();
    return inflight.current;
  }, [projectId]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void publicGet<SystemStatus>("/api/v1/system/status")
        .then(setStatus)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    focusRef.current = focusExperimentId;
    void refresh();
  }, [focusExperimentId, refresh]);

  const run =
    (focusExperimentId ? focusView?.runs[0] : null) ?? view?.runs[0] ?? null;
  return (
    <Ctx.Provider
      value={{
        projectId,
        overview,
        view,
        run,
        explorationRun:
          view?.runs.find((r) => r.kind === "EXPLORATION") ?? null,
        status,
        error,
        loading,
        refresh,
        focusExperimentId,
        focusView,
        setFocusExperiment,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
