"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { StatusBadge, Notice, formatTime } from "@/components/ui";

export default function RunDetail({ runId }) {
  const [run, setRun] = useState(null);
  const [state, setState] = useState(isFirebaseConfigured ? "loading" : "unconfigured");
  const [draft, setDraft] = useState({ subject: "", body: "" });
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;

    const unsub = onSnapshot(
      doc(db, "runs", runId),
      (snap) => {
        if (!snap.exists()) {
          setState("missing");
          return;
        }
        const data = { id: snap.id, ...snap.data() };
        setRun(data);
        setState("ready");
        // Don't clobber edits in progress when the live subscription fires.
        setDirty((isDirty) => {
          if (!isDirty) {
            setDraft({
              subject: data.draft?.subject ?? "",
              body: data.draft?.body ?? "",
            });
          }
          return isDirty;
        });
      },
      (err) => {
        console.error("Run subscription error:", err);
        setState("error");
      }
    );
    return () => unsub();
  }, [runId]);

  async function act(action, payload = {}) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/triage", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runId, action, ...payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Request failed.");
      setDirty(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (state === "unconfigured") {
    return (
      <Notice title="Firebase not configured">
        Add your <code>NEXT_PUBLIC_FIREBASE_*</code> values to <code>.env.local</code> to view runs.
      </Notice>
    );
  }
  if (state === "missing") return <Notice title="Run not found">No run with that id.</Notice>;
  if (state === "error") return <Notice title="Couldn’t load this run">Check the console.</Notice>;
  if (state === "loading" || !run) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  const c = run.classification ?? {};
  const decided = ["approved", "sent", "rejected"].includes(run.status);
  const canAct = !decided && run.status !== "processing";

  return (
    <div className="space-y-6">
      {/* ---- status + classification ------------------------------------ */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatusBadge status={run.status} />
          <Chip>{c.intent}</Chip>
          <Chip>urgency: {c.urgency}</Chip>
          <Chip>sentiment: {c.sentiment}</Chip>
          <Chip tone={run.needsReview ? "amber" : "green"}>
            confidence {Number(c.confidence ?? 0).toFixed(2)}
          </Chip>
          <Chip>{run.live ? `live · ${run.model}` : "canned result"}</Chip>
          {run.cost > 0 && <Chip>${run.cost.toFixed(4)}</Chip>}
        </div>

        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Row label="Summary">{c.summary || "—"}</Row>
          <Row label="Suggested owner">{c.suggestedOwner || "—"}</Row>
          <Row label="Contact">
            {c.contact?.name || "—"}
            {c.contact?.company ? ` · ${c.contact.company}` : ""}
          </Row>
          <Row label="Order / invoice ref">{c.orderRef || "none found"}</Row>
        </dl>

        {run.usage && (
          <p className="mt-4 border-t border-zinc-100 pt-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
            {run.usage.input_tokens} in · {run.usage.output_tokens} out ·{" "}
            {run.usage.cache_read_input_tokens ?? 0} cached (cache reads bill at ~10% of input —
            the system prompt is byte-identical on every run, which is what makes them hit).
          </p>
        )}
      </section>

      {run.error && (
        <section className="rounded-xl border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/40">
          <p className="text-sm font-medium text-red-900 dark:text-red-300">Workflow error</p>
          <p className="mt-1 font-mono text-xs text-red-800 dark:text-red-400">{run.error}</p>
          <button
            onClick={() => act("retry")}
            disabled={busy}
            className="mt-3 rounded-lg border border-red-300 px-3 py-1.5 text-sm font-medium text-red-900 transition hover:bg-red-100 disabled:opacity-60 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-950"
          >
            Retry this run
          </button>
        </section>
      )}

      {/* ---- original email --------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Original email
        </h2>
        <p className="text-sm">
          <strong>{run.email?.fromName || run.email?.from}</strong>{" "}
          <span className="text-zinc-500 dark:text-zinc-400">&lt;{run.email?.from}&gt;</span>
        </p>
        <p className="mt-1 text-sm font-medium">{run.email?.subject}</p>
        <pre className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 font-sans text-sm text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
          {run.email?.body}
        </pre>
      </section>

      {/* ---- the approval gate ------------------------------------------ */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Drafted reply
        </h2>

        {run.needsReview ? (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
            Confidence {Number(c.confidence ?? 0).toFixed(2)} is below the{" "}
            {run.confidenceThreshold} threshold, so no reply was drafted. Write one yourself below,
            or reject the run.
          </p>
        ) : (
          <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
            Edit anything you like. Nothing is sent until you press Approve.
          </p>
        )}

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Subject
            </span>
            <input
              value={draft.subject}
              disabled={!canAct}
              onChange={(e) => {
                setDraft((d) => ({ ...d, subject: e.target.value }));
                setDirty(true);
              }}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-600 dark:text-zinc-400">
              Body
            </span>
            <textarea
              value={draft.body}
              rows={10}
              disabled={!canAct}
              onChange={(e) => {
                setDraft((d) => ({ ...d, body: e.target.value }));
                setDirty(true);
              }}
              className="w-full rounded-lg border border-zinc-300 px-3 py-2 font-sans text-sm outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>

        {error && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </p>
        )}

        {canAct ? (
          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => act("approve", dirty ? { draft } : {})}
              disabled={busy || !draft.body.trim()}
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
            >
              {busy ? "Working…" : dirty ? "Approve edited reply & send" : "Approve & send"}
            </button>
            <button
              onClick={() => act("reject")}
              disabled={busy}
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium transition hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              Reject
            </button>
            {dirty && (
              <button
                onClick={() => {
                  setDraft({
                    subject: run.draft?.subject ?? "",
                    body: run.draft?.body ?? "",
                  });
                  setDirty(false);
                }}
                className="rounded-lg px-3 py-2 text-sm text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
              >
                Revert edits
              </button>
            )}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            This run is <strong>{String(run.status).replace(/_/g, " ")}</strong> — no further action
            available.
          </p>
        )}
      </section>

      {/* ---- audit trail -------------------------------------------------- */}
      <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          History
        </h2>
        <ul className="space-y-2 text-sm">
          {(run.history ?? []).map((h, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-40 shrink-0 text-xs text-zinc-400">{formatTime(h.at)}</span>
              <span>
                {h.event}
                {h.detail && (
                  <span className="text-zinc-500 dark:text-zinc-400"> — {h.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

const CHIP_TONES = {
  slate: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  green: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
};

function Chip({ tone = "slate", children }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${CHIP_TONES[tone]}`}>
      {children}
    </span>
  );
}
