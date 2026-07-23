import Link from "next/link";
import RunDetail from "@/components/RunDetail";

export const metadata = {
  title: "Review run — Harbor Supply Co.",
};

// Next 15: route params are async and must be awaited.
export default async function RunPage({ params }) {
  const { id } = await params;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12">
      <header className="mb-8">
        <Link
          href="/ops"
          className="text-xs text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400"
        >
          ← All runs
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Review run</h1>
        <p className="mt-1 font-mono text-xs text-zinc-500 dark:text-zinc-400">{id}</p>
      </header>

      <RunDetail runId={id} />
    </main>
  );
}
