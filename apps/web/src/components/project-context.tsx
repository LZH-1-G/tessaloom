"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "@/lib/api";
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
  status: SystemStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => Promise<void>;
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
  const inflight = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    inflight.current ??= (async () => {
      try {
        const [o, s] = await Promise.all([
          api.get<ProjectOverview>(`/api/v1/projects/${projectId}`),
          api.get<SystemStatus>("/api/v1/system/status"),
        ]);
        setOverview(o);
        setStatus(s);
        const latest = o.experiments[0];
        setView(
          latest
            ? await api.get<ExperimentViewData>(
                `/api/v1/experiments/${latest.id}`,
              )
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
      void api
        .get<SystemStatus>("/api/v1/system/status")
        .then(setStatus)
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = view?.runs[0] ?? null;
  return (
    <Ctx.Provider
      value={{
        projectId,
        overview,
        view,
        run,
        status,
        error,
        loading,
        refresh,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
