import Link from "next/link";
import RunsTable from "@/components/RunsTable";

export const metadata = {
  title: "Ops — Harbor Supply Co.",
  description: "Live triage runs awaiting human review.",
};

export default function OpsPage() {
  return (
    <main className="mx-auto w-full max-w-5xl flex-1 px-5 py-12">
      <header className="mb-8">
        <Link
          href="/"
          className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
        >
          ← Back to the demo
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Ops dashboard</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          Every triage run, live. Anything in <strong>awaiting approval</strong> or{" "}
          <strong>needs review</strong> is blocked on a human — open it to approve, edit, or reject.
        </p>
      </header>

      <RunsTable />
    </main>
  );
}
