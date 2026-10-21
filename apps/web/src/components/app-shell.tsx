"use client";

import { FlaskConical, ServerCrash } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { SystemStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function Logo() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 font-serif text-xl tracking-tight"
    >
      <svg aria-hidden viewBox="0 0 24 24" className="size-6">
        <g strokeWidth="2" strokeLinecap="round">
          <path d="M5 3v18M12 3v18M19 3v18" stroke="var(--tl-warp)" />
          <path d="M2 8h20M2 16h20" stroke="var(--tl-weft)" />
        </g>
      </svg>
      Tessaloom
    </Link>
  );
}

export function ModeBanner({ status }: { status: SystemStatus | null }) {
  return (
    <>
      {status?.mode === "fixture" ? (
        <div
          data-testid="fixture-banner"
          role="note"
          className="flex items-center justify-center gap-2 bg-rust px-4 py-1.5 text-center text-sm font-semibold text-white"
        >
          <FlaskConical aria-hidden className="size-4" />
          Development fixtures — not real Qloo data
        </div>
      ) : null}
      {status && !status.workerOnline ? (
        <div
          role="alert"
          className="flex items-center justify-center gap-2 border-b border-saffron bg-saffron-tint px-4 py-1.5 text-sm"
        >
          <ServerCrash aria-hidden className="size-4" />
          Live agent runs are temporarily unavailable. Saved experiments remain
          viewable.
        </div>
      ) : null}
    </>
  );
}

export function TopBar({
  status,
  children,
}: {
  status: SystemStatus | null;
  children?: React.ReactNode;
}) {
  const mode = status?.mode;
  return (
    <header className="border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-[1500px] items-center justify-between gap-4 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-4">
          <Logo />
          {children}
        </div>
        <div className="flex items-center gap-3 text-xs">
          {mode ? (
            <span
              data-testid="mode-badge"
              className={cn(
                "rounded border px-2 py-0.5 font-mono font-medium uppercase tracking-wide",
                mode === "fixture"
                  ? "border-rust text-rust"
                  : "border-warp text-warp",
              )}
            >
              {mode}
            </span>
          ) : null}
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              aria-hidden
              className={cn(
                "size-2 rounded-full",
                status?.qlooReady ? "bg-moss" : "bg-slate",
              )}
            />
            Qloo {status?.qlooReady ? "ready" : "unavailable"}
          </span>
        </div>
      </div>
    </header>
  );
}

const STEPS = [
  { href: "brief", label: "Brief", n: 1 },
  { href: "discovery", label: "Discover", n: 2 },
  { href: "hypotheses", label: "Hypotheses", n: 3 },
  {
    href: "what-if",
    label: "What-if",
    n: 4,
    disabled: "Arrives with the What-if Lab (M8)",
  },
  {
    href: "blueprint",
    label: "Blueprint",
    n: 5,
    disabled: "Arrives with the Blueprint composer (M9)",
  },
];

export function ProjectRail({
  projectId,
  reachable,
}: {
  projectId: string;
  reachable: Record<string, string | null>;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Experiment steps" className="lg:sticky lg:top-4">
      <ol className="flex gap-1 overflow-x-auto lg:flex-col">
        {STEPS.map((step) => {
          const href = `/projects/${projectId}/${step.href}`;
          const blocked = step.disabled ?? reachable[step.href] ?? null;
          const active = pathname === href;
          return (
            <li key={step.href} className="shrink-0">
              {blocked ? (
                <span
                  className="flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground"
                  title={blocked}
                  aria-disabled="true"
                >
                  <span className="font-mono text-xs">{step.n}</span>
                  {step.label}
                  <span className="sr-only">— unavailable: {blocked}</span>
                </span>
              ) : (
                <Link
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "hover:bg-surface-2",
                  )}
                >
                  <span className="font-mono text-xs">{step.n}</span>
                  {step.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
