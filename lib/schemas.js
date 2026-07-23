// Shared zod schemas. Used in three places, which is the point:
//   1. the browser form (client-side validation),
//   2. POST /api/triage (server-side validation — never trust the client),
//   3. the Gemini call (the classification schema becomes a strict JSON schema,
//      so the model literally cannot return an intent the Switch node can't route).
import { z } from "zod";

// ---------------------------------------------------------------------------
// Inbound email (what the demo form submits / what the Gmail Trigger forwards)
// ---------------------------------------------------------------------------

// Size caps are a cost control, not just hygiene: the body length bounds the
// input tokens we can ever be billed for. See lib/quota.js.
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 4000;

export const inboundEmailSchema = z.object({
  from: z.string().trim().min(1, "Sender is required.").email("Enter a valid email address."),
  fromName: z.string().trim().max(120).optional().default(""),
  subject: z
    .string()
    .trim()
    .min(1, "Subject is required.")
    .max(MAX_SUBJECT_CHARS, `Keep the subject under ${MAX_SUBJECT_CHARS} characters.`),
  body: z
    .string()
    .trim()
    .min(1, "Message body is required.")
    .max(MAX_BODY_CHARS, `Keep the body under ${MAX_BODY_CHARS} characters.`),
  // Gmail's Message-ID when real, a generated id from the demo form otherwise.
  // This is the idempotency key — see lib/idempotency.js.
  messageId: z.string().trim().min(1).max(200),
  receivedAt: z.string().trim().optional(),
  // Honeypot. Rendered in the form but hidden from humans — a real person can
  // never fill this, a DOM-scraping bot usually will. Validated as "must be
  // empty" here; the route treats a non-empty value as a bot and fakes success.
  // See lib/lockdown.js.
  company_website: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// The model's classification output
// ---------------------------------------------------------------------------

// Strict enums are what make the downstream n8n Switch node reliable — there is
// no "sort of a lead" branch to handle because the model can't emit one.
export const INTENTS = ["new_lead", "support", "billing", "spam"];
export const URGENCIES = ["low", "normal", "high"];
export const SENTIMENTS = ["positive", "neutral", "negative"];

export const classificationSchema = z.object({
  intent: z.enum(INTENTS),
  urgency: z.enum(URGENCIES),
  sentiment: z.enum(SENTIMENTS),
  // How sure the model is. Drives the human-review gate in the n8n IF node.
  confidence: z.number().min(0).max(1),
  contact: z.object({
    name: z.string(),
    email: z.string(),
    company: z.string(),
  }),
  // Empty string when absent — the API's structured outputs don't support
  // optional fields well, so "absent" is modelled as "" everywhere.
  orderRef: z.string(),
  summary: z.string(),
  suggestedOwner: z.string(),
});

export const draftSchema = z.object({
  subject: z.string(),
  body: z.string(),
});

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export const RUN_STATUSES = [
  "classified", // the model has run; routing done
  "needs_review", // low confidence — a human must look before anything else
  "awaiting_approval", // draft ready, waiting on Approve/Reject
  "approved", // human said yes; n8n is sending
  "sent", // Gmail confirmed sent
  "rejected", // human said no; nothing was sent
  "failed", // a workflow step errored — retryable from /ops
];

export const patchSchema = z.object({
  id: z.string().trim().min(1, "Missing run id."),
  action: z.enum(["approve", "reject", "retry", "status"]),
  // Present when the human edited the draft before approving.
  draft: draftSchema.partial().optional(),
  // Used by n8n when reporting back a terminal state or a failure.
  status: z.enum(RUN_STATUSES).optional(),
  error: z.string().max(2000).optional(),
});

/** Flatten a zod error into { fieldName: "first message" } for the form UI. */
export function fieldErrors(error) {
  const out = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
