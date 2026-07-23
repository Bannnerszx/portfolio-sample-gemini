// Gemini integration: classify + extract, then draft a reply.
//
// Model: gemini-3.1-flash-lite — Google's cheapest model, which is the right
// choice here because both jobs are small, well-specified, and schema-bound.
// At $0.25/$1.50 per 1M tokens a full run costs about a third of a cent.
//
// Two separate calls rather than one, on purpose:
//   - classification is cheap, near-deterministic, and must be schema-strict
//     because the n8n Switch node routes on it;
//   - drafting is only worth paying for once we know the intent isn't spam.
// Spam and low-confidence emails therefore never reach the second call at all.

import { GoogleGenAI, ApiError } from "@google/genai";
import { z } from "zod";
import { classificationSchema, draftSchema } from "@/lib/schemas";

const MODEL = "gemini-3.1-flash-lite";

// Output ceilings. These bound the worst-case cost of a single run.
const MAX_TOKENS_CLASSIFY = 700;
const MAX_TOKENS_DRAFT = 900;
// Belt-and-braces on top of the character caps in schemas.js: if a payload
// somehow tokenises far larger than expected, refuse it rather than pay for it.
const MAX_INPUT_TOKENS = 2000;

// gemini-3.1-flash-lite paid-tier pricing, USD per million tokens.
// Used to show a running cost in /ops — you can't manage a budget you can't see.
const USD_PER_MTOK_IN = 0.25;
const USD_PER_MTOK_OUT = 1.5;

let client = null;
function getClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

/**
 * Gemini constrains generation with a JSON Schema. Rather than hand-maintain a
 * second copy of the shape, we derive it from the same zod schemas the API
 * route and the form already use — one source of truth.
 *
 * `$schema` is stripped because Gemini rejects unknown top-level keys.
 */
function toGeminiSchema(schema) {
  const json = z.toJSONSchema(schema, { target: "draft-7" });
  delete json.$schema;
  return json;
}

const CLASSIFICATION_JSON_SCHEMA = toGeminiSchema(classificationSchema);
const DRAFT_JSON_SCHEMA = toGeminiSchema(draftSchema);

const CLASSIFY_SYSTEM = `You triage inbound email for Harbor Supply Co., a wholesale supplier of paper goods and packaging to cafés, restaurants, and small retailers.

Classify each email and extract structured fields.

Intent definitions — pick exactly one:
- new_lead: someone not yet a customer asking about products, pricing, quotes, or opening an account.
- support: an existing customer with a problem or question about an order, delivery, product, or return.
- billing: anything about invoices, payments, charges, refunds, credit terms, or purchase orders.
- spam: unsolicited marketing, phishing, SEO/crypto pitches, or automated bulk mail.

Confidence: report your genuine certainty in the intent, from 0 to 1. Use a value below 0.7 when the email is too short, vague, or ambiguous to classify reliably — a human will review those. Do not inflate confidence to seem decisive; an honest low score is more useful than a confident wrong answer.

Extraction rules:
- contact.name, contact.company, orderRef: copy only what is actually present in the email. Use an empty string when absent. Never guess or infer a value that isn't written down.
- contact.email: the sender's address.
- summary: one sentence, under 20 words, stating what the sender wants.
- suggestedOwner: one of Sales, Support, or Finance.`;

const DRAFT_SYSTEM = `You draft reply emails for Harbor Supply Co., a wholesale supplier of paper goods and packaging.

Voice: warm, direct, and professional. Plain sentences. British-neutral business English.

Rules:
- Open by addressing the sender's actual issue, not with filler like "Thank you for reaching out."
- Commit only to things a real business could do: acknowledging, investigating, escalating, or promising a follow-up within a stated timeframe.
- Never invent prices, stock levels, delivery dates, refund amounts, or policy. If a specific number is needed, say a colleague will confirm it.
- Ask at most one clarifying question, and only when genuinely needed to proceed.
- 120 words or fewer. Sign off as "Harbor Supply Co.".

This draft goes to a human for approval before anything is sent, so write it as a finished email, not as options or notes.`;

/** Convert Gemini usage metadata into a dollar figure for the ops dashboard. */
export function estimateCost(usage) {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Cached input bills at a reduced rate; treat it as ~25% to stay conservative.
  const cached = usage.cached_tokens ?? 0;
  const inputCost = ((input + cached * 0.25) / 1_000_000) * USD_PER_MTOK_IN;
  const outputCost = (output / 1_000_000) * USD_PER_MTOK_OUT;
  return inputCost + outputCost;
}

/** Normalise Gemini's usageMetadata into the shape the rest of the app uses. */
function readUsage(response) {
  const m = response?.usageMetadata ?? {};
  return {
    // promptTokenCount includes cached tokens, so subtract to avoid double-count.
    input_tokens: Math.max(0, (m.promptTokenCount ?? 0) - (m.cachedContentTokenCount ?? 0)),
    // Thinking tokens are billed as output when present.
    output_tokens: (m.candidatesTokenCount ?? 0) + (m.thoughtsTokenCount ?? 0),
    cached_tokens: m.cachedContentTokenCount ?? 0,
    total_tokens: m.totalTokenCount ?? 0,
  };
}

const sumUsage = (a, b) => ({
  input_tokens: (a?.input_tokens ?? 0) + (b?.input_tokens ?? 0),
  output_tokens: (a?.output_tokens ?? 0) + (b?.output_tokens ?? 0),
  cached_tokens: (a?.cached_tokens ?? 0) + (b?.cached_tokens ?? 0),
  total_tokens: (a?.total_tokens ?? 0) + (b?.total_tokens ?? 0),
});

function formatEmail(email) {
  return `From: ${email.fromName ? `${email.fromName} <${email.from}>` : email.from}
Subject: ${email.subject}

${email.body}`;
}

/**
 * Anything that isn't a clean success is surfaced as this, and the caller
 * degrades to fixture mode. The demo never shows a stack trace to a visitor.
 */
class AiUnavailable extends Error {
  constructor(reason, cause) {
    super(reason);
    this.name = "AiUnavailable";
    this.reason = reason;
    this.cause = cause;
  }
}

/** Map an SDK error to a short reason code for logging and metrics. */
function toReason(err) {
  if (err instanceof ApiError) {
    if (err.status === 429) return "rate_limited";
    if (err.status === 401 || err.status === 403) return "auth";
    if (err.status >= 500) return "upstream";
    return `api_${err.status}`;
  }
  if (err?.name === "AbortError") return "timeout";
  return "unknown";
}

/**
 * Parse and validate a structured response.
 *
 * The JSON Schema constrains generation, but we validate the result with zod
 * anyway. Belt and braces: if the model ever deviates, zod catches it here and
 * the run degrades to human review instead of putting a bad value into the
 * routing switch.
 */
function parseStructured(response, schema) {
  const text = response?.text;
  if (!text) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Guard against a response that was cut short or blocked by safety filters. */
function checkFinish(response) {
  const reason = response?.candidates?.[0]?.finishReason;
  if (!reason || reason === "STOP") return;
  if (reason === "MAX_TOKENS") throw new AiUnavailable("truncated");
  if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT") {
    throw new AiUnavailable("refusal");
  }
  throw new AiUnavailable(`finish_${String(reason).toLowerCase()}`);
}

/**
 * Run the full AI step for one email.
 * Resolves to { classification, draft, usage, cost, model } or throws
 * AiUnavailable — which is a routine, expected outcome, not a bug.
 */
export async function triageEmail(email) {
  const ai = getClient();
  if (!ai) throw new AiUnavailable("no_api_key");

  const emailText = formatEmail(email);

  try {
    // Pre-flight: never send something we haven't priced.
    const count = await ai.models.countTokens({
      model: MODEL,
      contents: emailText,
    });
    if ((count.totalTokens ?? 0) > MAX_INPUT_TOKENS) {
      throw new AiUnavailable("input_too_large");
    }

    // ---- 1. Classify + extract -------------------------------------------
    // thinkingBudget 0 disables thinking entirely: cheapest, and correct for
    // schema-bound extraction where there is nothing to reason about.
    const classifyRes = await ai.models.generateContent({
      model: MODEL,
      contents: emailText,
      config: {
        systemInstruction: CLASSIFY_SYSTEM,
        responseMimeType: "application/json",
        responseJsonSchema: CLASSIFICATION_JSON_SCHEMA,
        maxOutputTokens: MAX_TOKENS_CLASSIFY,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    checkFinish(classifyRes);

    const classification = parseStructured(classifyRes, classificationSchema);
    // Null means the response didn't validate. Don't crash — an unclassifiable
    // email is exactly what the human-review queue is for.
    if (!classification) throw new AiUnavailable("unparsable");

    let usage = readUsage(classifyRes);

    // ---- 2. Draft a reply -------------------------------------------------
    // Skipped entirely for spam and for anything a human needs to look at
    // first. This is the cheap decision that keeps the demo affordable.
    const worthDrafting =
      classification.intent !== "spam" && classification.confidence >= 0.7;

    let draft = { subject: `Re: ${email.subject}`, body: "" };

    if (worthDrafting) {
      const draftRes = await ai.models.generateContent({
        model: MODEL,
        contents: `Context from triage:
- Intent: ${classification.intent}
- Urgency: ${classification.urgency}
- Sentiment: ${classification.sentiment}
- Order/invoice reference: ${classification.orderRef || "none given"}

Reply to this email:

${emailText}`,
        config: {
          systemInstruction: DRAFT_SYSTEM,
          responseMimeType: "application/json",
          responseJsonSchema: DRAFT_JSON_SCHEMA,
          maxOutputTokens: MAX_TOKENS_DRAFT,
          // A little variation reads more naturally than temperature 0 prose.
          temperature: 0.4,
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      usage = sumUsage(usage, readUsage(draftRes));

      const parsedDraft = parseStructured(draftRes, draftSchema);
      if (parsedDraft) draft = parsedDraft;
      // A failed draft is survivable: the run still routes and still reaches a
      // human, who can write the reply themselves. Only classification is critical.
    }

    return {
      classification,
      draft,
      usage,
      cost: estimateCost(usage),
      model: MODEL,
      drafted: worthDrafting,
    };
  } catch (err) {
    if (err instanceof AiUnavailable) throw err;
    console.error("Gemini call failed:", err);
    throw new AiUnavailable(toReason(err), err);
  }
}

export { AiUnavailable, MODEL };
