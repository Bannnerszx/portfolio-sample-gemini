import Link from "next/link";
import EmailForm from "@/components/EmailForm";

export default function Home() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-12 sm:py-16">
      <header className="mb-10">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
          Harbor Supply Co. · portfolio demo
        </p>
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          AI inbox triage with a human approval gate
        </h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          An inbound email is classified and routed automatically, a reply is drafted in the
          business&apos;s voice — and then everything stops until a person clicks Approve.{" "}
          <strong className="font-medium text-zinc-900 dark:text-zinc-100">
            Nothing is ever sent without human sign-off.
          </strong>
        </p>
      </header>

      <section className="mb-10 rounded-xl border border-zinc-200 bg-white p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-3 font-medium">What happens when you submit</h2>
        <ol className="space-y-2 text-zinc-600 dark:text-zinc-400">
          <Step n="1">
            The email is validated and given a stable ID, so a retry or a double-click can never
            produce two replies to the same customer.
          </Step>
          <Step n="2">
            Gemini classifies it — intent, urgency, sentiment, confidence — and extracts contact and
            order details into a strict schema.
          </Step>
          <Step n="3">
            Low confidence stops here and goes to a review queue. Everything else is routed by
            intent: leads and tickets are upserted into the CRM sheet (deduplicated by email),
            billing goes to finance.
          </Step>
          <Step n="4">
            A reply is drafted and posted to Slack for review — then it waits. Approve, edit, or
            reject in the ops dashboard.
          </Step>
          <Step n="5">
            If any step fails, the run is marked failed with the error and can be retried from the
            dashboard.
          </Step>
        </ol>
      </section>

      <section className="mb-10">
        <h2 className="mb-1 text-lg font-medium">Simulate an inbound email</h2>
        <p className="mb-5 text-sm text-zinc-500 dark:text-zinc-400">
          Load a sample or paste your own. The &ldquo;ambiguous&rdquo; sample is worth trying — it
          deliberately trips the confidence gate.
        </p>
        <EmailForm />
      </section>

      <footer className="border-t border-zinc-200 pt-6 text-sm text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
        <p>
          Harbor Supply Co. is a fictional business. No real customer data is used.{" "}
          <Link href="/ops" className="underline">
            Open the ops dashboard
          </Link>
          .
        </p>
      </footer>
    </main>
  );
}

function Step({ n, children }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
