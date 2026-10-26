import { ArrowRightLeft, CircleAlert } from "lucide-react";
import type { DataOrigin, Provenance } from "@/lib/types";
import { DomainBadge, ProvenanceChip, StatusPill } from "../provenance";

interface StoryEntity {
  name: string;
  domain: string;
}

export interface Story {
  /** The story follows a What-if branch (the experiment its blueprint came from). */
  fromBranch?: boolean;
  /** Synthetic development data (decided by the experiment mode on the server). */
  fixture: boolean;
  brief: {
    title: string;
    challenge: string;
    interests: string[];
    venue: { type: string; capacity?: number };
    budgetBand: string | null;
    durationMinutes: number | null;
    goals: string[];
  } | null;
  seeds: StoryEntity[];
  discovery: {
    threadResults: number;
    byDomain: { domain: string; count: number }[];
    inMultipleThreads: number;
    bridgeCandidates: number;
    bridges: StoryEntity[][];
  };
  hypotheses: {
    title: string;
    premise: string;
    status: string;
    compositeScore: number | null;
    carriedToBlueprint: boolean;
    elements: StoryEntity[];
    claims: {
      statement: string;
      stance: string | null;
      evidence: {
        stance: string;
        rationale: string | null;
        provenanceClass: string;
        dataOrigin: DataOrigin | null;
        retrievedAt: string | null;
      } | null;
    }[];
  }[];
  dataOrigins: string[];
}

function Step({
  n,
  id,
  title,
  children,
}: {
  n: number;
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      className="rounded-xl border border-border bg-card p-5"
    >
      <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Step {n}
      </p>
      <h2 id={id} className="mt-1 font-serif text-2xl">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm">{children}</div>
    </section>
  );
}

const Chip = ({ e }: { e: StoryEntity }) => (
  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1">
    <span className="font-medium">{e.name}</span>
    <DomainBadge domain={e.domain} />
  </span>
);

/**
 * The read-only path from brief to evidence (UI_UX_SPEC §4.8 extension for demo samples).
 * Everything shown comes from the stored project; nothing here calls a model or Qloo.
 */
export function SharedStory({
  story,
  blueprint,
}: {
  story: Story;
  /** The composed blueprint, rendered as the final step before the limitations. */
  blueprint?: React.ReactNode;
}) {
  const counts = (claims: Story["hypotheses"][number]["claims"]) => {
    const tally = (s: string) => claims.filter((c) => c.stance === s).length;
    return {
      supports: tally("SUPPORTS"),
      contradicts: tally("CONTRADICTS"),
      other: claims.filter(
        (c) => !c.stance || !["SUPPORTS", "CONTRADICTS"].includes(c.stance),
      ).length,
    };
  };
  return (
    <div className="space-y-6">
      {story.brief ? (
        <Step n={1} id="story-brief" title="The creative brief">
          <p className="font-serif text-xl">{story.brief.title}</p>
          <p>{story.brief.challenge}</p>
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
            <div>
              <dt className="inline text-muted-foreground">Venue: </dt>
              <dd className="inline">
                {story.brief.venue.type}
                {story.brief.venue.capacity
                  ? ` · ${story.brief.venue.capacity} guests`
                  : ""}
              </dd>
            </div>
            {story.brief.budgetBand ? (
              <div>
                <dt className="inline text-muted-foreground">Budget: </dt>
                <dd className="inline">{story.brief.budgetBand}</dd>
              </div>
            ) : null}
            {story.brief.durationMinutes ? (
              <div>
                <dt className="inline text-muted-foreground">Duration: </dt>
                <dd className="inline">{story.brief.durationMinutes} min</dd>
              </div>
            ) : null}
            {story.brief.goals.length ? (
              <div>
                <dt className="inline text-muted-foreground">Goals: </dt>
                <dd className="inline">{story.brief.goals.join("; ")}</dd>
              </div>
            ) : null}
          </dl>
        </Step>
      ) : null}

      <Step n={2} id="story-seeds" title="Interests confirmed with Qloo">
        <p className="text-muted-foreground">
          The user’s interests, each resolved to one Qloo entity chosen by the
          user.
        </p>
        <div className="flex flex-wrap gap-2">
          {story.seeds.map((e) => (
            <Chip key={`${e.name}-${e.domain}`} e={e} />
          ))}
        </div>
      </Step>

      <Step n={3} id="story-discovery" title="Discovery across cultural worlds">
        <p>
          Qloo recommendations from each interest into other worlds returned{" "}
          <strong>{story.discovery.threadResults}</strong> results
          {story.discovery.inMultipleThreads
            ? `; ${story.discovery.inMultipleThreads} appeared in more than one interest's thread`
            : ""}
          .
        </p>
        <ul className="flex flex-wrap gap-2" aria-label="Results by world">
          {story.discovery.byDomain.map((d) => (
            <li
              key={d.domain}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
            >
              <DomainBadge domain={d.domain} /> {d.count}
            </li>
          ))}
        </ul>
        {story.discovery.bridges.length ? (
          <>
            <p>
              Of {story.discovery.bridgeCandidates} candidate bridges between
              different worlds, these {story.discovery.bridges.length} were
              taken forward:
            </p>
            <ul className="space-y-2" aria-label="Selected bridges">
              {story.discovery.bridges.map((pair, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2">
                  {pair.map((e, j) => (
                    <span key={j} className="contents">
                      {j > 0 ? (
                        <ArrowRightLeft
                          aria-label="bridged with"
                          className="size-4 text-weft"
                        />
                      ) : null}
                      <Chip e={e} />
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Step>

      <Step
        n={4}
        id="story-hypotheses"
        title="Hypotheses tested against Qloo evidence"
      >
        <p className="text-muted-foreground">
          Each idea is creative speculation. Its claims were checked against
          Qloo results by fixed rules; the stance and the rule’s reason are
          shown per claim.
          {story.fromBranch
            ? " These results come from a What-if branch of the original experiment, the one the blueprint was composed from."
            : ""}
        </p>
        <ol className="space-y-4">
          {story.hypotheses.map((h, i) => {
            const c = counts(h.claims);
            return (
              <li
                key={i}
                className={
                  h.carriedToBlueprint
                    ? "rounded-lg border-2 border-weft p-4"
                    : "rounded-lg border border-border p-4"
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill status={h.status} />
                  {h.carriedToBlueprint ? (
                    <span className="rounded-full bg-weft px-2 py-0.5 text-xs font-semibold text-white">
                      Chosen for the blueprint
                    </span>
                  ) : null}
                  {h.compositeScore !== null ? (
                    <span className="ml-auto text-xs text-muted-foreground">
                      Composite score {Math.round(h.compositeScore)}
                    </span>
                  ) : null}
                </div>
                <h3 className="mt-2 font-serif text-lg">{h.title}</h3>
                <p className="mt-1 text-muted-foreground">
                  <ProvenanceChip
                    provenance="CREATIVE_SPECULATION"
                    className="mr-1 align-middle"
                  />
                  {h.premise}
                </p>
                {h.elements.length ? (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {h.elements.map((e) => (
                      <Chip key={`${e.name}-${e.domain}`} e={e} />
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-muted-foreground">
                  {c.supports} supporting · {c.contradicts} contradicting ·{" "}
                  {c.other} neutral or untested
                </p>
                <ul className="mt-2 space-y-2">
                  {h.claims.map((cl, j) => (
                    <li key={j}>
                      <span className="flex flex-wrap items-center gap-1.5">
                        {cl.stance ? (
                          <StatusPill status={cl.stance} />
                        ) : (
                          <span className="text-xs">untested</span>
                        )}
                        {cl.statement}
                      </span>
                      {cl.evidence ? (
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                          <ProvenanceChip
                            provenance={
                              cl.evidence.provenanceClass as Provenance
                            }
                            origin={cl.evidence.dataOrigin}
                            retrievedAt={cl.evidence.retrievedAt}
                          />
                          {cl.evidence.rationale}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>
      </Step>

      {blueprint ? (
        <section aria-labelledby="story-blueprint" className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-wide text-muted-foreground">
            Step 5
          </p>
          <h2 id="story-blueprint" className="sr-only">
            Experience blueprint
          </h2>
          {blueprint}
        </section>
      ) : null}

      <section
        aria-labelledby="story-limits"
        className="rounded-xl border border-border bg-surface p-5 text-sm"
      >
        <h2
          id="story-limits"
          className="flex items-center gap-1.5 font-semibold"
        >
          <CircleAlert aria-hidden className="size-4" /> What this does not show
        </h2>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            Qloo values are aggregate audience-taste signals. They are not
            predictions of attendance, sales or any individual’s preferences,
            and they do not show cause and effect.
          </li>
          <li>
            Hypotheses and most blueprint blocks are AI interpretation or
            creative speculation; only blocks marked as evidence cite Qloo
            results.
          </li>
          <li>
            {!story.fixture
              ? "Evidence was retrieved live from Qloo on the dates shown and is not refreshed when this page is viewed."
              : "This sample uses labelled synthetic fixtures, not Qloo data."}
          </li>
          <li>Cultural data: Qloo. Hypotheses and blueprint: Tessaloom.</li>
        </ul>
      </section>
    </div>
  );
}
