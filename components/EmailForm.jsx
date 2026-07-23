"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { MAX_BODY_CHARS, MAX_SUBJECT_CHARS } from "@/lib/schemas";
import { getSamples } from "@/lib/fixtures";

// company_website is the honeypot — hidden from humans, irresistible to bots.
const EMPTY = { from: "", fromName: "", subject: "", body: "", company_website: "" };

export default function EmailForm() {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState({});
  const [state, setState] = useState("idle"); // idle | sending | done | error
  const [result, setResult] = useState(null);
  const [quota, setQuota] = useState(null);

  // Tell the visitor what they've got left before they type, not after.
  useEffect(() => {
    fetch("/api/quota")
      .then((r) => r.json())
      .then(setQuota)
      .catch(() => setQuota(null));
  }, []);

  const set = (key) => (e) => {
    setValues((v) => ({ ...v, [key]: e.target.value }));
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  };

  const loadSample = (sample) => {
    setValues({
      from: sample.from,
      fromName: sample.fromName,
      subject: sample.subject,
      body: sample.body,
      company_website: "",
    });
    setErrors({});
    setState("idle");
    setResult(null);
  };

  async function onSubmit(e) {
    e.preventDefault();
    setState("sending");
    setErrors({});

    try {
      const res = await fetch("/api/triage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...values,
          // Stand-in for a real Message-ID. Stable per submission, so a
          // double-click is deduplicated by the API rather than charged twice.
          messageId: `demo-${btoa(`${values.from}|${values.subject}`).slice(0, 24)}-${Date.now()}`,
          receivedAt: new Date().toISOString(),
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        setErrors(data.fieldErrors ?? {});
        setResult({ message: data.message ?? "Something went wrong." });
        setState("error");
        return;
      }

      setResult(data);
      setState("done");
      fetch("/api/quota")
        .then((r) => r.json())
        .then(setQuota)
        .catch(() => {});
    } catch {
      setResult({ message: "Network error — is the dev server running?" });
      setState("error");
    }
  }

  return (
    <div className="space-y-6">
      <QuotaNotice quota={quota} />

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Load a sample
        </p>
        <div className="flex flex-wrap gap-2">
          {getSamples().map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => loadSample(s)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 transition hover:border-zinc-400 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {/*
          Honeypot. Invisible to people (off-screen, aria-hidden, not tabbable,
          autocomplete off) but present in the DOM, so a bot that fills every
          input will fill this one too. The server then fakes a success response.
        */}
        <div className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden" aria-hidden="true">
          <label htmlFor="company_website">Company website — leave this blank</label>
          <input
            id="company_website"
            name="company_website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={values.company_website}
            onChange={set("company_website")}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sender email" error={errors.from}>
            <input
              type="email"
              value={values.from}
              onChange={set("from")}
              placeholder="dana@brightlinecafe.com"
              className={inputClass(errors.from)}
            />
          </Field>
          <Field label="Sender name" hint="optional" error={errors.fromName}>
            <input
              type="text"
              value={values.fromName}
              onChange={set("fromName")}
              placeholder="Dana Whitfield"
              className={inputClass(errors.fromName)}
            />
          </Field>
        </div>

        <Field
          label="Subject"
          hint={`${values.subject.length}/${MAX_SUBJECT_CHARS}`}
          error={errors.subject}
        >
          <input
            type="text"
            value={values.subject}
            onChange={set("subject")}
            maxLength={MAX_SUBJECT_CHARS}
            placeholder="Wholesale pricing for 200 units?"
            className={inputClass(errors.subject)}
          />
        </Field>

        <Field
          label="Message body"
          hint={`${values.body.length}/${MAX_BODY_CHARS}`}
          error={errors.body}
        >
          <textarea
            value={values.body}
            onChange={set("body")}
            rows={8}
            maxLength={MAX_BODY_CHARS}
            placeholder="Paste an email here…"
            className={inputClass(errors.body)}
          />
        </Field>

        <button
          type="submit"
          disabled={state === "sending"}
          className="w-full rounded-lg bg-zinc-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200"
        >
          {state === "sending" ? "Triaging…" : "Triage this email"}
        </button>
      </form>

      {state === "error" && (
        <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {result?.message}
        </p>
      )}

      {state === "done" && result && <ResultCard result={result} />}
    </div>
  );
}

function QuotaNotice({ quota }) {
  if (!quota) return null;

  if (quota.live) {
    return (
      <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
        Live AI enabled —{" "}
        <strong>
          {quota.owner ? "unlimited (owner)" : `${quota.remaining} of ${quota.limit} free runs left`}
        </strong>
        . After that the demo keeps working on canned results.
      </p>
    );
  }

  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
      {quota.message}
    </p>
  );
}

function ResultCard({ result }) {
  const run = result.run ?? {};
  const c = run.classification ?? {};

  return (
    <div className="space-y-3 rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone="slate">{c.intent}</Pill>
        <Pill tone={c.urgency === "high" ? "red" : "slate"}>urgency: {c.urgency}</Pill>
        <Pill tone={run.needsReview ? "amber" : "green"}>
          confidence {Number(c.confidence ?? 0).toFixed(2)}
        </Pill>
        <Pill tone={result.live ? "green" : "slate"}>{result.live ? "live AI" : "canned"}</Pill>
      </div>

      {result.notice && (
        <p className="text-xs text-zinc-500 dark:text-zinc-400">{result.notice}</p>
      )}

      <p className="text-sm text-zinc-700 dark:text-zinc-300">{c.summary}</p>

      {run.needsReview ? (
        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
          Confidence is below the {run.confidenceThreshold} threshold, so no reply was drafted. This
          one goes to a human review queue instead — which is the point of the gate.
        </p>
      ) : (
        run.draft?.body && (
          <div>
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Drafted reply (not sent)
            </p>
            <pre className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 font-sans text-sm text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
              {run.draft.body}
            </pre>
          </div>
        )
      )}

      <Link
        href={`/ops/${result.id}`}
        className="inline-block rounded-lg border border-zinc-300 px-3 py-1.5 text-sm font-medium transition hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
      >
        Open in the ops dashboard →
      </Link>
    </div>
  );
}

function Field({ label, hint, error, children }) {
  return (
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{label}</span>
        {hint && <span className="text-xs text-zinc-400">{hint}</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-xs text-red-600 dark:text-red-400">{error}</span>}
    </label>
  );
}

function inputClass(error) {
  return `w-full rounded-lg border px-3 py-2 text-sm outline-none transition focus:ring-2 focus:ring-zinc-400 dark:bg-zinc-950 ${
    error
      ? "border-red-400 dark:border-red-700"
      : "border-zinc-300 dark:border-zinc-700"
  }`;
}

const TONES = {
  slate: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  green: "bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-300",
};

function Pill({ tone = "slate", children }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>
      {children}
    </span>
  );
}

export { Pill };
