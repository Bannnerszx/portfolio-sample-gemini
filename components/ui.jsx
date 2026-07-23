"use client";

// Small shared presentational bits used by both ops screens.

export const STATUS_TONES = {
  classified: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  needs_review: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  awaiting_approval: "bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
  approved: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300",
  sent: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300",
  rejected: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  failed: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
  processing: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400",
};

export function StatusBadge({ status }) {
  const tone = STATUS_TONES[status] ?? STATUS_TONES.classified;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>
      {String(status ?? "unknown").replace(/_/g, " ")}
    </span>
  );
}

export function Notice({ title, children }) {
  return (
    <div className="rounded-xl border border-dashed border-zinc-300 bg-white p-6 text-center dark:border-zinc-700 dark:bg-zinc-900">
      <p className="font-medium text-zinc-900 dark:text-zinc-100">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-zinc-500 dark:text-zinc-400">{children}</p>
    </div>
  );
}

/** Firestore Timestamp | ISO string | Date → locale string. */
export function formatTime(ts) {
  if (!ts) return "—";
  const date = typeof ts?.toDate === "function" ? ts.toDate() : new Date(ts);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
