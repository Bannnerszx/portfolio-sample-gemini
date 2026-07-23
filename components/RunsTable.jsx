"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, onSnapshot, orderBy, query, limit } from "firebase/firestore";
import { db, isFirebaseConfigured } from "@/lib/firebase";
import { STATUS_TONES, StatusBadge, Notice, formatTime } from "@/components/ui";

export default function RunsTable() {
  const [rows, setRows] = useState([]);
  const [state, setState] = useState(isFirebaseConfigured ? "loading" : "unconfigured");

  useEffect(() => {
    if (!isFirebaseConfigured || !db) return;

    const q = query(collection(db, "runs"), orderBy("createdAt", "desc"), limit(50));
    const unsub = onSnapshot(
      q,
      (snap) => {
        setRows(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
        setState("ready");
      },
      (err) => {
        console.error("Firestore subscription error:", err);
        setState("error");
      }
    );
    return () => unsub();
  }, []);

  if (state === "unconfigured") {
    return (
      <Notice title="Firebase not configured">
        Add your <code>NEXT_PUBLIC_FIREBASE_*</code> values to <code>.env.local</code> and restart
        the dev server to see live runs here.
      </Notice>
    );
  }
  if (state === "error") {
    return (
      <Notice title="Couldn’t load runs">
        Check the browser console and your Firestore rules (the demo allows public read on{" "}
        <code>runs</code>).
      </Notice>
    );
  }
  if (state === "loading") {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading runs…</p>;
  }
  if (rows.length === 0) {
    return (
      <Notice title="No runs yet">
        Triage an email on the{" "}
        <Link href="/" className="underline">
          home page
        </Link>{" "}
        — runs appear here instantly, no refresh needed.
      </Notice>
    );
  }

  const spend = rows.reduce((sum, r) => sum + (r.cost ?? 0), 0);
  const liveRuns = rows.filter((r) => r.live).length;
  const awaiting = rows.filter(
    (r) => r.status === "awaiting_approval" || r.status === "needs_review"
  ).length;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Awaiting a human" value={awaiting} />
        <Stat label="Live AI runs" value={`${liveRuns} of ${rows.length}`} />
        <Stat label="API spend (shown)" value={`$${spend.toFixed(4)}`} />
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            <tr>
              <Th>From</Th>
              <Th>Subject</Th>
              <Th>Intent</Th>
              <Th className="text-right">Conf.</Th>
              <Th>Status</Th>
              <Th>Received</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {rows.map((r) => (
              <tr key={r.id} className="bg-white dark:bg-zinc-950">
                <Td>
                  <Link
                    href={`/ops/${r.id}`}
                    className="font-medium underline-offset-2 hover:underline"
                  >
                    {r.email?.fromName || r.email?.from}
                  </Link>
                  <span className="block text-xs text-zinc-500 dark:text-zinc-400">
                    {r.email?.from}
                  </span>
                </Td>
                <Td className="max-w-[240px] truncate">{r.email?.subject}</Td>
                <Td>
                  <span className="rounded bg-zinc-100 px-1.5 py-0.5 font-mono text-xs dark:bg-zinc-800">
                    {r.classification?.intent ?? "—"}
                  </span>
                </Td>
                <Td className="text-right tabular-nums">
                  <span className={r.needsReview ? "text-amber-600 dark:text-amber-400" : ""}>
                    {Number(r.classification?.confidence ?? 0).toFixed(2)}
                  </span>
                </Td>
                <Td>
                  <StatusBadge status={r.status} />
                </Td>
                <Td className="whitespace-nowrap text-zinc-500 dark:text-zinc-400">
                  {formatTime(r.createdAt)}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        Statuses: {Object.keys(STATUS_TONES).join(" · ")}
      </p>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Th({ children, className = "" }) {
  return <th className={`px-4 py-3 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = "" }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>;
}
