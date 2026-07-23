import { NextResponse } from "next/server";
import { FieldValue } from "firebase-admin/firestore";
import { inboundEmailSchema, patchSchema, fieldErrors } from "@/lib/schemas";
import { getAdminDb } from "@/lib/firebaseAdmin";
import { runIdFor, claimRun } from "@/lib/idempotency";
import { triageEmail, AiUnavailable } from "@/lib/gemini";
import { fixtureClassification, fixtureDraft } from "@/lib/fixtures";
import {
  consumeQuota,
  refundQuota,
  isAiEnabled,
  quotaMessage,
  withVisitorCookie,
} from "@/lib/quota";
import {
  checkLockdown,
  isHoneypotTripped,
  isOriginAllowed,
  recordAndDetectBurst,
} from "@/lib/lockdown";

// firebase-admin, node:crypto and the outbound fetch to n8n all require Node.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CONFIDENCE_THRESHOLD = 0.7;

/**
 * POST /api/triage
 *
 * The order of operations matters and is the whole point of the design:
 *   validate → claim quota → claim idempotency → classify → persist → forward.
 * Quota is claimed BEFORE the API call so a burst can't slip through, and
 * refunded if the call then fails, so an outage doesn't cost the visitor a run.
 */
export async function POST(request) {
  // 0) Anti-abuse, cheapest checks first — all of these run before we touch
  //    Firestore or the model, so a bot costs us nothing but a few CPU cycles.
  if (!isOriginAllowed(request)) {
    return NextResponse.json({ ok: false, message: "Forbidden." }, { status: 403 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  if (isHoneypotTripped(body)) {
    // Deliberately indistinguishable from success. Telling a bot which check
    // caught it only helps it adapt.
    console.warn("Honeypot tripped — dropping request.");
    return NextResponse.json({ ok: true, id: null, live: false }, { status: 200 });
  }

  // 1) Validate. Size caps here are what bound the worst-case token cost.
  const parsed = inboundEmailSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        message: "Please fix the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      },
      { status: 400 }
    );
  }
  const email = parsed.data;

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json(
      {
        ok: false,
        message:
          "Firestore admin isn't configured. Add the FIREBASE_ADMIN_* values to .env.local — see README.",
      },
      { status: 503 }
    );
  }

  // 2) Idempotency. Claim the message id before spending anything: a retried
  //    webhook must cost nothing and must not produce a second CRM row.
  const runId = runIdFor(email.messageId);
  const claim = await claimRun(db, runId, {
    email,
    status: "processing",
    createdAt: FieldValue.serverTimestamp(),
  });

  if (!claim.claimed) {
    return withVisitorCookie(
      NextResponse.json(
        {
          ok: true,
          id: runId,
          duplicate: true,
          message: "This message was already triaged — returning the existing run.",
          run: claim.existing,
        },
        { status: 200 }
      ),
      request
    );
  }

  // 3) Burst detection + lockdown. Recorded on EVERY attempt, including ones
  //    already serving canned results — otherwise a bot that has exhausted its
  //    per-visitor quota would keep hammering the endpoint invisibly.
  await recordAndDetectBurst(db);
  const lockdownReason = await checkLockdown(db);

  // 4) Quota. Claimed before the spend, not after.
  let live = false;
  let quotaReason = null;

  if (lockdownReason) {
    quotaReason = lockdownReason;
  } else if (isAiEnabled()) {
    const quota = await consumeQuota(request);
    live = quota.granted;
    quotaReason = quota.reason;
  } else {
    quotaReason = "disabled";
  }

  // 5) Classify + draft — live if we're allowed to spend, canned otherwise.
  //    Either way the pipeline below is identical, which is what keeps the
  //    demo honest: the fallback exercises the same code path.
  let classification;
  let draft;
  let usage = null;
  let cost = 0;
  let model = "fixtures";

  if (live) {
    try {
      const result = await triageEmail(email);
      ({ classification, draft, usage, cost, model } = result);
    } catch (err) {
      // Expected failure modes (rate limit, refusal, unparsable) degrade to
      // fixtures rather than showing a visitor a stack trace.
      const reason = err instanceof AiUnavailable ? err.reason : "unknown";
      console.warn(`Gemini unavailable (${reason}) — falling back to fixtures.`);
      await refundQuota(request); // our fault, not theirs
      live = false;
      quotaReason = reason;
      classification = fixtureClassification(email);
      draft = fixtureDraft(email, classification);
    }
  } else {
    classification = fixtureClassification(email);
    draft = fixtureDraft(email, classification);
  }

  // 6) Route. The confidence gate is the reason a human stays in the loop:
  //    an unsure classification never reaches the reply-drafting stage as
  //    something approvable — it goes to a review queue instead.
  const needsReview = classification.confidence < CONFIDENCE_THRESHOLD;
  const status = needsReview
    ? "needs_review"
    : classification.intent === "spam"
      ? "classified"
      : "awaiting_approval";

  const run = {
    email,
    classification,
    draft,
    status,
    live,
    model,
    usage: usage ?? null,
    cost,
    needsReview,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    history: [
      {
        at: new Date().toISOString(),
        event: live ? "classified (live)" : "classified (canned)",
        detail: `${classification.intent} · confidence ${classification.confidence.toFixed(2)}`,
      },
    ],
    updatedAt: FieldValue.serverTimestamp(),
  };

  try {
    await db.collection("runs").doc(runId).set(run, { merge: true });
  } catch (err) {
    console.error("Firestore write failed:", err);
    return NextResponse.json(
      { ok: false, message: "Could not save the triage result." },
      { status: 500 }
    );
  }

  // 7) Forward to n8n — best-effort, exactly as in piece #1. A deployed URL
  //    can't reach a laptop's n8n, and that must not break the demo
  await forwardToN8n(process.env.N8N_WEBHOOK_URL, {
    runId,
    status,
    ...email,
    ...classification,
    draftSubject: draft.subject,
    draftBody: draft.body,
  });

  return withVisitorCookie(
    NextResponse.json(
      {
        ok: true,
        id: runId,
        live,
        notice: live ? null : quotaMessage(quotaReason),
        run: { ...run, id: runId, updatedAt: null },
      },
      { status: 200 }
    ),
    request
  );
}

/**
 * PATCH /api/triage
 *
 * The human-approval gate and the error/retry path. Called by the ops UI
 * (approve / reject / retry) and by n8n (status reports, error trigger).
 *
 * Demo-only: no auth. In a client build this would sit behind the CRM's login.
 */
export async function PATCH(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, message: "Invalid request.", fieldErrors: fieldErrors(parsed.error) },
      { status: 400 }
    );
  }
  const { id, action, draft, status: reportedStatus, error } = parsed.data;

  const db = getAdminDb();
  if (!db) {
    return NextResponse.json(
      { ok: false, message: "Firestore admin is not configured." },
      { status: 503 }
    );
  }

  const ref = db.collection("runs").doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    return NextResponse.json({ ok: false, message: "Run not found." }, { status: 404 });
  }
  const existing = snap.data();

  const update = { updatedAt: FieldValue.serverTimestamp() };
  let historyEvent = "";

  switch (action) {
    case "approve": {
      // The gate. Nothing is sent unless this branch runs.
      if (draft?.subject || draft?.body) {
        update.draft = { ...existing.draft, ...draft };
        update.draftEdited = true;
      }
      update.status = "approved";
      update.approvedAt = FieldValue.serverTimestamp();
      historyEvent = draft ? "approved (draft edited by human)" : "approved by human";
      break;
    }
    case "reject": {
      update.status = "rejected";
      historyEvent = "rejected by human — nothing sent";
      break;
    }
    case "retry": {
      // Clears the failure so n8n can pick the run up again.
      update.status = existing.needsReview ? "needs_review" : "awaiting_approval";
      update.error = FieldValue.delete();
      historyEvent = "retried after failure";
      break;
    }
    case "status": {
      // n8n reporting back. This is how `sent` and `failed` arrive.
      if (!reportedStatus) {
        return NextResponse.json(
          { ok: false, message: "status action requires a status field." },
          { status: 400 }
        );
      }
      update.status = reportedStatus;
      if (error) update.error = error;
      historyEvent = error ? `${reportedStatus}: ${error}` : reportedStatus;
      break;
    }
  }

  update.history = FieldValue.arrayUnion({
    at: new Date().toISOString(),
    event: historyEvent,
    detail: "",
  });

  try {
    await ref.update(update);
  } catch (err) {
    console.error("Run update failed:", err);
    return NextResponse.json({ ok: false, message: "Could not update the run." }, { status: 500 });
  }

  // On approval, kick n8n's send workflow. Best-effort again — if it's
  // unreachable the run simply stays `approved` and is retryable from /ops.
  if (action === "approve") {
    await forwardToN8n(process.env.N8N_APPROVE_WEBHOOK_URL, {
      runId: id,
      to: existing.email?.from,
      subject: draft?.subject ?? existing.draft?.subject,
      body: draft?.body ?? existing.draft?.body,
      intent: existing.classification?.intent,
    });
  }

  return NextResponse.json({ ok: true, id, status: update.status }, { status: 200 });
}

/** Fire-and-forget POST to an n8n webhook. Never throws. */
async function forwardToN8n(url, payload) {
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, at: new Date().toISOString() }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.warn("n8n forward skipped:", err?.message ?? err);
  }
}
