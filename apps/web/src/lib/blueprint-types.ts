import type {
  AppendixEntry,
  BlueprintContent,
  TraceabilityReport,
} from "@tessaloom/core";
import type { RunView } from "./types";

export interface RevisionSummary {
  id: string;
  revisionNumber: number;
  author: "AGENT" | "USER";
  changeSummary: string | null;
  contentHash: string;
  createdAt: string;
}

export interface BlueprintViewData {
  blueprint: {
    id: string;
    projectId: string;
    experimentId: string;
    hypothesisIds: string[];
    format: "event" | "series" | "installation";
    status: "DRAFT" | "ACCEPTED";
    currentRevisionId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  experiment: { id: string; kind: string; label: string | null } | null;
  hypotheses: { id: string; title: string; status: string }[];
  current: {
    id: string;
    revisionNumber: number;
    author: "AGENT" | "USER";
    content: BlueprintContent;
    traceabilityReport: TraceabilityReport;
    changeSummary: string | null;
    createdAt: string;
  } | null;
  appendix: AppendixEntry[];
  revisions: RevisionSummary[];
  latestRun: RunView | null;
}

export interface BlueprintListItem {
  id: string;
  experimentId: string;
  format: string;
  status: string;
  title: string | null;
  revisionNumber: number | null;
  updatedAt: string;
}

export interface ShareLinkItem {
  id: string;
  scope: "project" | "experiment" | "blueprint";
  targetId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  viewCount: number;
}
