import {
  CircleDashed,
  Database,
  FlaskConical,
  MessageSquareQuote,
  Sigma,
  Sparkle,
  UserRound,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DataOrigin, Provenance } from "@/lib/types";

/** UI_UX_SPEC §2.4: every chip has visible text; icon and border style back up the label. */
const PROVENANCE: Record<
  Provenance,
  { label: string; Icon: typeof Database; className: string }
> = {
  QLOO_SOURCED: {
    label: "Qloo data",
    Icon: Database,
    className: "border-2 border-solid border-warp text-warp",
  },
  APP_DERIVED: {
    label: "Computed",
    Icon: Sigma,
    className: "border border-solid border-foreground text-foreground",
  },
  MODEL_INTERPRETATION: {
    label: "AI interpretation",
    Icon: MessageSquareQuote,
    className: "border-2 border-dashed border-weft text-weft",
  },
  CREATIVE_SPECULATION: {
    label: "Creative speculation",
    Icon: Sparkle,
    className: "border-2 border-dotted border-saffron text-foreground",
  },
  USER_PROVIDED: {
    label: "You",
    Icon: UserRound,
    className:
      "border border-solid border-muted-foreground text-muted-foreground",
  },
  DEVELOPMENT_FIXTURE: {
    label: "FIXTURE — not Qloo data",
    Icon: FlaskConical,
    className: "border-[3px] border-double border-rust text-rust",
  },
};

export const PROVENANCE_LABEL = Object.fromEntries(
  Object.entries(PROVENANCE).map(([k, v]) => [k, v.label]),
) as Record<Provenance, string>;

export function ProvenanceChip({
  provenance,
  origin,
  retrievedAt,
  className,
}: {
  provenance: Provenance;
  origin?: DataOrigin | null;
  retrievedAt?: string | null;
  className?: string;
}) {
  const p = PROVENANCE[provenance];
  const date = retrievedAt ? retrievedAt.slice(0, 10) : null;
  return (
    <span
      data-provenance={provenance}
      className={cn(
        "inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        p.className,
        className,
      )}
    >
      <p.Icon aria-hidden className="size-3" />
      {p.label}
      {origin && provenance === "QLOO_SOURCED" ? (
        <DataOriginText origin={origin} date={date} />
      ) : null}
    </span>
  );
}

function DataOriginText({
  origin,
  date,
}: {
  origin: DataOrigin;
  date: string | null;
}) {
  const text =
    origin === "LIVE"
      ? "live"
      : origin === "CACHE"
        ? "cached"
        : origin === "REPLAY"
          ? `recorded ${date ?? ""}`
          : "fixture";
  return (
    <span className="font-mono text-[10px] uppercase opacity-80">· {text}</span>
  );
}

export function DataOriginBadge({ origin }: { origin: DataOrigin | null }) {
  if (!origin) return null;
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide",
        origin === "FIXTURE"
          ? "border-rust text-rust"
          : "border-warp text-warp",
      )}
    >
      {origin === "FIXTURE" ? "fixture data" : origin}
    </span>
  );
}

const STATUS: Record<
  string,
  { label: string; className: string; symbol: string }
> = {
  SUPPORTED: {
    label: "Supported",
    className: "bg-moss/12 text-moss border-moss/50",
    symbol: "●",
  },
  PARTIALLY_SUPPORTED: {
    label: "Partially supported",
    className: "bg-moss/8 text-moss border-moss/40 border-dashed",
    symbol: "◐",
  },
  UNDER_INVESTIGATION: {
    label: "Under investigation",
    className: "bg-saffron-tint text-foreground border-saffron",
    symbol: "◌",
  },
  SPECULATIVE: {
    label: "Speculative",
    className: "bg-surface-2 text-foreground border-saffron border-dotted",
    symbol: "✧",
  },
  INCONCLUSIVE: {
    label: "Inconclusive",
    className: "bg-slate/10 text-slate border-slate/50",
    symbol: "◌",
  },
  CONTRADICTED: {
    label: "Contradicted",
    className: "bg-rust/10 text-rust border-rust/50",
    symbol: "✕",
  },
  UNTESTABLE: {
    label: "Untestable",
    className: "bg-surface-2 text-muted-foreground border-border",
    symbol: "∅",
  },
  SUPPORTS: {
    label: "Supports",
    className: "bg-moss/12 text-moss border-moss/50",
    symbol: "✔",
  },
  CONTRADICTS: {
    label: "Contradicts",
    className: "bg-rust/10 text-rust border-rust/50",
    symbol: "✖",
  },
  NEUTRAL: {
    label: "Neutral",
    className: "bg-slate/10 text-slate border-slate/50",
    symbol: "–",
  },
  INSUFFICIENT: {
    label: "Insufficient",
    className: "bg-surface-2 text-muted-foreground border-border",
    symbol: "◌",
  },
};

export function StatusPill({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const s = STATUS[status] ?? {
    label: status.replace(/_/g, " ").toLowerCase(),
    className: "border-border",
    symbol: "•",
  };
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
        s.className,
        className,
      )}
    >
      <span aria-hidden>{s.symbol}</span>
      {s.label}
    </span>
  );
}

export const DOMAIN_LABEL: Record<string, string> = {
  artist: "Music artist",
  book: "Book",
  brand: "Brand",
  destination: "Destination",
  movie: "Film",
  person: "Person",
  place: "Place",
  podcast: "Podcast",
  tv_show: "TV",
  videogame: "Video game",
  tag: "Tag",
  locality: "Locality",
  author: "Author (legacy type)",
  actor: "Actor (legacy type)",
  director: "Director (legacy type)",
  album: "Album (legacy type)",
};

export function DomainBadge({ domain }: { domain: string | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-medium text-foreground">
      {domain ? (
        (DOMAIN_LABEL[domain] ?? domain)
      ) : (
        <>
          <CircleDashed aria-hidden className="size-3" />
          Unknown type
        </>
      )}
    </span>
  );
}

export const typeDomain = (type?: string | null) => {
  if (!type) return null;
  if (type.startsWith("urn:tag")) return "tag";
  return /^urn:entity:([a-z_]+)$/.exec(type)?.[1] ?? null;
};
