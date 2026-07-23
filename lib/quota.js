// The spend guard.
//
// This demo calls a paid API from a public URL, so the interesting engineering
// problem isn't the AI — it's making sure a stranger (or a bot, or a bored
// crawler) can't run up a bill. Five independent layers, any one of which can
// stop a run:
//
//   1. Per-visitor cap    — 3 runs, tracked by BOTH hashed IP and cookie
//   2. Global daily cap   — resets at UTC midnight
//   3. Global lifetime cap— the hard ceiling on total spend, ever
//   4. Input/output caps  — bounds the tokens any single run can cost
//   5. Kill switch        — DEMO_AI_ENABLED=false serves fixtures at zero cost
//
// When a cap is hit we do NOT error. We fall back to fixture mode so the page
// still demonstrates the full pipeline — a broken demo is worse than a free one.

import { createHash, randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { getAdminDb } from "@/lib/firebaseAdmin";

export const VISITOR_COOKIE = "hsc_visitor";

const num = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const LIMITS = {
  perVisitor: num(process.env.DEMO_RUNS_PER_VISITOR, 3),
  perDay: num(process.env.DEMO_RUNS_PER_DAY, 50),
  lifetime: num(process.env.DEMO_RUNS_TOTAL, 500),
};

/** Master switch: is the app allowed to spend money at all right now? */
export function isAiEnabled() {
  return process.env.DEMO_AI_ENABLED === "true" && Boolean(process.env.GEMINI_API_KEY);
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Two independent identifiers per visitor, deliberately:
 *   - a hashed IP, which survives clearing cookies
 *   - a cookie UUID, which survives a changing/shared IP
 * We charge both and block on whichever is higher, so neither evasion works on
 * its own. The IP is hashed with a salt so we never store a raw address.
 */
export function getVisitor(request) {
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  const ip =
    forwarded.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";

  const salt = process.env.QUOTA_SALT ?? "harbor-supply-co-dev-salt";
  const ipKey = createHash("sha256").update(`${ip}:${salt}`).digest("hex").slice(0, 32);

  const existing = request.cookies.get(VISITOR_COOKIE)?.value;
  const cookieId = existing && /^[a-f0-9-]{36}$/i.test(existing) ? existing : randomUUID();

  return { ipKey, cookieId, isNewCookie: cookieId !== existing };
}

/** Lets you bypass the per-visitor cap on your own machine for screen recordings. */
export function isOwner(request) {
  const key = process.env.OWNER_DEMO_KEY;
  if (!key) return false;
  return (
    request.cookies.get("hsc_owner")?.value === key ||
    request.headers.get("x-owner-key") === key
  );
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

const dayKey = () => new Date().toISOString().slice(0, 10); // UTC — matches the reset

/** Read-only view of remaining runs. Drives the badge in the UI. */
export async function getQuotaStatus(request) {
  if (isOwner(request)) {
    return { ok: true, owner: true, remaining: Infinity, limit: LIMITS.perVisitor, reason: null };
  }

  const db = getAdminDb();
  const { ipKey, cookieId } = getVisitor(request);

  // No Firestore means we can't count, and something we can't count is
  // something we can't cap — so refuse to spend rather than fail open.
  if (!db) {
    return {
      ok: false,
      owner: false,
      remaining: 0,
      limit: LIMITS.perVisitor,
      reason: "unconfigured",
    };
  }

  const [ipSnap, cookieSnap, daySnap, totalSnap] = await Promise.all([
    db.collection("quota").doc(`ip-${ipKey}`).get(),
    db.collection("quota").doc(`visitor-${cookieId}`).get(),
    db.collection("quota").doc(`global-${dayKey()}`).get(),
    db.collection("quota").doc("global-total").get(),
  ]);

  const used = Math.max(ipSnap.data()?.count ?? 0, cookieSnap.data()?.count ?? 0);
  const remaining = Math.max(0, LIMITS.perVisitor - used);

  if ((totalSnap.data()?.count ?? 0) >= LIMITS.lifetime) {
    return { ok: false, owner: false, remaining, limit: LIMITS.perVisitor, reason: "lifetime" };
  }
  if ((daySnap.data()?.count ?? 0) >= LIMITS.perDay) {
    return { ok: false, owner: false, remaining, limit: LIMITS.perVisitor, reason: "daily" };
  }
  if (remaining <= 0) {
    return { ok: false, owner: false, remaining: 0, limit: LIMITS.perVisitor, reason: "visitor" };
  }

  return { ok: true, owner: false, remaining, limit: LIMITS.perVisitor, reason: null };
}

/**
 * Atomically claim one run against every counter.
 *
 * A transaction (not a read-then-write) because two tabs clicking Submit at the
 * same moment would otherwise both read "1 used" and both proceed — the classic
 * check-then-act race, which on a metered API costs real money.
 *
 * Returns { granted, reason, remaining }. `granted: false` is not an error —
 * the caller falls back to fixture mode.
 */
export async function consumeQuota(request) {
  if (isOwner(request)) {
    return { granted: true, reason: null, remaining: Infinity, owner: true };
  }

  const db = getAdminDb();
  if (!db) return { granted: false, reason: "unconfigured", remaining: 0, owner: false };

  const { ipKey, cookieId } = getVisitor(request);
  const quota = db.collection("quota");
  const refs = {
    ip: quota.doc(`ip-${ipKey}`),
    visitor: quota.doc(`visitor-${cookieId}`),
    day: quota.doc(`global-${dayKey()}`),
    total: quota.doc("global-total"),
  };

  try {
    return await db.runTransaction(async (tx) => {
      // All reads must precede all writes inside a Firestore transaction.
      const [ipDoc, visitorDoc, dayDoc, totalDoc] = await Promise.all([
        tx.get(refs.ip),
        tx.get(refs.visitor),
        tx.get(refs.day),
        tx.get(refs.total),
      ]);

      const totalCount = totalDoc.data()?.count ?? 0;
      const dayCount = dayDoc.data()?.count ?? 0;
      const used = Math.max(ipDoc.data()?.count ?? 0, visitorDoc.data()?.count ?? 0);
      const remaining = Math.max(0, LIMITS.perVisitor - used);

      if (totalCount >= LIMITS.lifetime) return { granted: false, reason: "lifetime", remaining, owner: false };
      if (dayCount >= LIMITS.perDay) return { granted: false, reason: "daily", remaining, owner: false };
      if (remaining <= 0) return { granted: false, reason: "visitor", remaining: 0, owner: false };

      const bump = { count: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() };
      tx.set(refs.ip, bump, { merge: true });
      tx.set(refs.visitor, bump, { merge: true });
      tx.set(refs.day, bump, { merge: true });
      tx.set(refs.total, bump, { merge: true });

      return { granted: true, reason: null, remaining: remaining - 1, owner: false };
    });
  } catch (err) {
    // A failed transaction means we don't know the count — refuse to spend.
    console.error("Quota transaction failed:", err);
    return { granted: false, reason: "error", remaining: 0, owner: false };
  }
}

/**
 * Give a run back. Called when we claimed quota but the API call then failed,
 * so a visitor isn't charged for our outage. Best-effort by design.
 */
export async function refundQuota(request) {
  if (isOwner(request)) return;
  const db = getAdminDb();
  if (!db) return;

  const { ipKey, cookieId } = getVisitor(request);
  const give = { count: FieldValue.increment(-1), updatedAt: FieldValue.serverTimestamp() };
  try {
    await Promise.all([
      db.collection("quota").doc(`ip-${ipKey}`).set(give, { merge: true }),
      db.collection("quota").doc(`visitor-${cookieId}`).set(give, { merge: true }),
      db.collection("quota").doc(`global-${dayKey()}`).set(give, { merge: true }),
      db.collection("quota").doc("global-total").set(give, { merge: true }),
    ]);
  } catch (err) {
    console.warn("Quota refund failed (non-fatal):", err?.message ?? err);
  }
}

/** Human-readable copy for each block reason. Shown as a card, never as an error. */
export function quotaMessage(reason) {
  switch (reason) {
    case "visitor":
      return `You've used your ${LIMITS.perVisitor} free live runs. The demo below still runs end to end — it just uses a canned classification instead of calling the API.`;
    case "daily":
      return "The demo has hit its daily API budget. Everything below still works; results are canned until the cap resets at midnight UTC.";
    case "lifetime":
      return "This demo has reached its lifetime API budget. It now runs entirely on canned results — the workflow itself is unchanged.";
    case "disabled":
      return "Live AI is switched off for this deployment — the demo runs on canned results at zero cost. The workflow below is otherwise identical.";
    case "breaker":
      return "The demo saw an unusual burst of traffic and automatically switched to canned results to protect its API budget. It restores itself shortly — the workflow below is unchanged.";
    case "lockdown":
      return "The demo is in lockdown and running on canned results only. Everything below still works end to end.";
    default:
      // Everything else is an API-side failure (auth, rate_limited, refusal,
      // network, unparsable…). The visitor doesn't need the distinction — they
      // need to know the demo still works.
      return "Live AI is unavailable right now, so the demo is running on canned results. The workflow below is otherwise identical.";
  }
}

/** Attach the visitor cookie to a response. 1 year, httpOnly, lax. */
export function withVisitorCookie(response, request) {
  const { cookieId, isNewCookie } = getVisitor(request);
  if (isNewCookie) {
    response.cookies.set(VISITOR_COOKIE, cookieId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}
