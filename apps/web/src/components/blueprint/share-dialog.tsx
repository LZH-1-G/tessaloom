"use client";

import { Copy, Link2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ShareLinkItem } from "@/lib/blueprint-types";
import { Button, inputClass } from "../ui";

/**
 * Read-only share links (PRD §6.8, SECURITY §4.3). The token is shown once; only a peppered
 * hash is stored, so a lost link cannot be recovered — create a new one instead.
 */
export function ShareDialog({
  projectId,
  scope,
  targetId,
  label,
  allowStory = false,
  onClose,
}: {
  projectId: string;
  scope: "project" | "experiment" | "blueprint";
  targetId: string;
  label: string;
  /** Offer sharing the whole project story (brief → evidence → blueprint) as well. */
  allowStory?: boolean;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [links, setLinks] = useState<ShareLinkItem[] | null>(null);
  // "Now" for active/expired labels, captured when the list loads (renders stay pure).
  const [loadedAt, setLoadedAt] = useState(0);
  const [days, setDays] = useState(30);
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [whole, setWhole] = useState(false);
  const shareScope = allowStory && whole ? "project" : scope;
  const shareTarget = allowStory && whole ? projectId : targetId;
  const load = useCallback(
    () =>
      void api
        .get<{ items: ShareLinkItem[] }>(
          `/api/v1/projects/${projectId}/share-links`,
        )
        .then((r) => {
          setLinks(
            r.items.filter(
              (l) =>
                l.targetId === targetId ||
                (allowStory && l.scope === "project"),
            ),
          );
          setLoadedAt(Date.now());
        })
        .catch((e: Error) => setError(e.message)),
    [projectId, targetId, allowStory],
  );
  useEffect(() => {
    ref.current?.showModal();
    load();
  }, [load]);
  const create = async () => {
    setError(null);
    try {
      const res = await api.post<{ url: string }>(
        `/api/v1/projects/${projectId}/share-links`,
        { scope: shareScope, targetId: shareTarget, expiresInDays: days },
      );
      setCreated(`${window.location.origin}${res.url}`);
      setCopied(false);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const revoke = async (id: string) => {
    setError(null);
    try {
      await api.delete(`/api/v1/share-links/${id}`);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="share-title"
      className="m-auto w-[min(620px,calc(100vw-2rem))] rounded-xl border border-border bg-card p-0 text-card-foreground shadow-2xl backdrop:bg-black/40"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-3">
        <div>
          <h2 id="share-title" className="font-serif text-xl">
            Share read-only
          </h2>
          <p className="text-xs text-muted-foreground">{label}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Close share"
          onClick={() => ref.current?.close()}
        >
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      <div className="space-y-4 px-5 py-4 text-sm">
        {allowStory ? (
          <fieldset className="space-y-1.5">
            <legend className="text-xs font-semibold">What to share</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="share-what"
                checked={!whole}
                onChange={() => setWhole(false)}
              />
              This blueprint
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="share-what"
                checked={whole}
                onChange={() => setWhole(true)}
              />
              The whole story — brief, Qloo discovery, tested hypotheses and the
              blueprint
            </label>
          </fieldset>
        ) : null}
        <p className="text-muted-foreground">
          Anyone with the link can view{" "}
          {shareScope === "project" ? "the project story" : `this ${scope}`} —
          no editing, no run controls, no workspace access. You can revoke it at
          any time.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">
            Expires after
            <select
              className={`${inputClass} mt-1 h-9 py-0`}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </label>
          <Button variant="weft" onClick={create}>
            <Link2 aria-hidden className="size-4" /> Create link
          </Button>
        </div>
        {created ? (
          <div
            className="rounded-lg border-2 border-saffron bg-saffron-tint p-3"
            role="status"
          >
            <p className="text-xs font-semibold">
              Copy this link now — it is shown only once.
            </p>
            <div className="mt-2 flex gap-2">
              <input
                readOnly
                aria-label="Share link"
                className={`${inputClass} h-9 font-mono text-xs`}
                value={created}
                data-testid="share-url"
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    ?.writeText(created)
                    .then(() => setCopied(true))
                    .catch(() => setCopied(false))
                }
              >
                <Copy aria-hidden className="size-4" />{" "}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-rust">
            {error}
          </p>
        ) : null}
        <section aria-labelledby="links-h">
          <h3 id="links-h" className="font-semibold">
            {allowStory ? "Links" : `Links for this ${scope}`}
          </h3>
          {!links?.length ? (
            <p className="mt-1 text-muted-foreground">None yet.</p>
          ) : (
            <ul className="mt-2 space-y-1.5" data-testid="share-links">
              {links.map((l) => {
                const active =
                  !l.revokedAt && Date.parse(l.expiresAt) > loadedAt;
                return (
                  <li
                    key={l.id}
                    className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
                  >
                    <span className="flex-1 text-xs">
                      {allowStory
                        ? l.scope === "project"
                          ? "Whole story · "
                          : "Blueprint · "
                        : ""}
                      Created {l.createdAt.slice(0, 10)} ·{" "}
                      {l.revokedAt
                        ? `revoked ${l.revokedAt.slice(0, 10)}`
                        : active
                          ? `expires ${l.expiresAt.slice(0, 10)}`
                          : "expired"}{" "}
                      · {l.viewCount} view{l.viewCount === 1 ? "" : "s"}
                      <span className="block font-mono text-[10px] text-muted-foreground">
                        Link ID {l.id}
                      </span>
                    </span>
                    {active ? (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => void revoke(l.id)}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </dialog>
  );
}
