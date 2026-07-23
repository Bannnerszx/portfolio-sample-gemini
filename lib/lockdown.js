// Anti-abuse layer.
//
// The quota caps in lib/quota.js bound how much money can be spent. This file
// is about something different: stopping automated traffic from burning through
// that budget (or Google's rate limits) in the first place, and giving the demo
// a way to shut its own door when it's under attack.
//
// Four defences, cheapest first — each one runs before anything expensive:
//
//   1. Origin check   — rejects POSTs that didn't come from our own page
//   2. Honeypot       — a hidden field only a bot fills in
//   3. Circuit breaker— auto-trips into zero-cost canned mode during a burst
//   4. Manual switch  — DEMO_LOCKDOWN=true, an instant panic button
//
// Why the breaker lives in Firestore rather than in memory: on Vercel each
// request may hit a different serverless instance, so an in-process counter
// would reset constantly and never detect anything. Shared state is the only
// thing that works in that environment.

import { FieldValue } from "firebase-admin/firestore";

const num = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export const BURST = {
  // How many runs within one window before we assume it isn't a human.
  threshold: num(process.env.DEMO_BURST_THRESHOLD, 15),
  // Window length in minutes.
  windowMinutes: num(process.env.DEMO_BURST_WINDOW_MINUTES, 10),
  // How long the breaker stays open once tripped.
  cooldownMinutes: num(process.env.DEMO_BREAKER_COOLDOWN_MINUTES, 120),
};

/** The panic button. Flip the env var, redeploy, everything goes canned. */
export function isManuallyLockedDown() {
  return process.env.DEMO_LOCKDOWN === "true";
}

// ---------------------------------------------------------------------------
// 1. Origin check
// ---------------------------------------------------------------------------

/**
 * A browser always sends Origin on a cross-origin POST, and same-origin fetch
 * sends it too. A naive script (curl, a scraper, a copied fetch snippet run
 * from elsewhere) usually doesn't send one at all, or sends the wrong host.
 *
 * This is not real security — Origin is trivially forged by anything that
 * bothers. It is a cheap filter that removes the laziest traffic for free.
 * Deliberately permissive: when we can't tell, we allow.
 */
export function isOriginAllowed(request) {
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const host = request.headers.get("host");
  if (!host) return true;

  // Explicit allowlist wins when configured (useful for the n8n callbacks).
  const allowed = (process.env.DEMO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const candidate = origin ?? referer;
  // No Origin and no Referer: server-to-server. Allowed — n8n PATCHes this API.
  if (!candidate) return true;

  try {
    const url = new URL(candidate);
    if (url.host === host) return true;
    return allowed.some((a) => {
      try {
        return new URL(a).host === url.host;
      } catch {
        return a === url.host;
      }
    });
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 2. Honeypot
// ---------------------------------------------------------------------------

/**
 * `company_website` is rendered in the form but hidden from humans and marked
 * aria-hidden + tabindex=-1. A real person can't see it, can't tab to it, and
 * won't fill it. A bot that parses the DOM and fills every input will.
 *
 * When tripped we return a fake success rather than an error — telling a bot
 * precisely which check caught it just helps it adapt.
 */
export function isHoneypotTripped(body) {
  const value = body?.company_website;
  return typeof value === "string" && value.trim().length > 0;
}

// ---------------------------------------------------------------------------
// 3. Circuit breaker
// ---------------------------------------------------------------------------

const windowKey = () => {
  const ms = BURST.windowMinutes * 60 * 1000;
  return Math.floor(Date.now() / ms);
};

/**
 * Is the breaker currently open? Read on every request, so keep it to one doc.
 * Returns { tripped, until, reason }.
 */
export async function getBreakerState(db) {
  if (!db) return { tripped: false, until: null, reason: null };
  try {
    const snap = await db.collection("quota").doc("breaker").get();
    const data = snap.data();
    if (!data?.until) return { tripped: false, until: null, reason: null };
    const until = Number(data.until);
    if (Date.now() >= until) {
      // Expired — self-healing. No cron job, no manual reset.
      return { tripped: false, until: null, reason: null };
    }
    return { tripped: true, until, reason: data.reason ?? "burst" };
  } catch (err) {
    // If we can't read the breaker we don't know if we're under attack.
    // Fail safe: assume tripped, which costs nothing but canned results.
    console.warn("Breaker read failed, assuming tripped:", err?.message ?? err);
    return { tripped: true, until: null, reason: "unreadable" };
  }
}

/**
 * Record one request against the current window and trip the breaker if the
 * window is over threshold.
 *
 * Called on EVERY submission attempt, including ones already serving canned
 * results — otherwise a bot that has exhausted its per-visitor quota would keep
 * hammering the endpoint invisibly.
 *
 * Returns true if this call tripped the breaker.
 */
export async function recordAndDetectBurst(db) {
  if (!db) return false;

  const ref = db.collection("quota").doc(`burst-${windowKey()}`);
  try {
    const count = await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const next = (snap.data()?.count ?? 0) + 1;
      tx.set(
        ref,
        { count: next, updatedAt: FieldValue.serverTimestamp() },
        { merge: true }
      );
      return next;
    });

    if (count < BURST.threshold) return false;

    // Only trip on the way *up*. Once the breaker is open, leave its expiry
    // alone.
    //
    // Without this guard every subsequent request re-trips it and pushes the
    // expiry forward, so the cooldown restarts continuously and the breaker
    // reopens only after traffic stops completely for the full cooldown. On a
    // public demo a slow trickle of genuine visitors would then keep it locked
    // shut indefinitely — the opposite of self-healing.
    const existing = await getBreakerState(db);
    if (existing.tripped) return false;

    const until = Date.now() + BURST.cooldownMinutes * 60 * 1000;
    await db.collection("quota").doc("breaker").set(
      {
        until,
        reason: "burst",
        trippedAt: FieldValue.serverTimestamp(),
        observed: count,
        windowMinutes: BURST.windowMinutes,
      },
      { merge: true }
    );

    console.warn(
      `Circuit breaker TRIPPED: ${count} requests in ${BURST.windowMinutes}m ` +
        `(threshold ${BURST.threshold}). Canned mode until ${new Date(until).toISOString()}.`
    );
    await alertSlack(
      `🔒 *Demo circuit breaker tripped* — ${count} requests in ${BURST.windowMinutes} minutes ` +
        `(threshold ${BURST.threshold}). Serving canned results for ${BURST.cooldownMinutes} minutes. No API spend.`
    );
    return true;
  } catch (err) {
    console.warn("Burst detection failed (non-fatal):", err?.message ?? err);
    return false;
  }
}

/** Best-effort Slack alert. Never throws, never blocks the response path. */
async function alertSlack(text) {
  const url = process.env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // An alert failing must never affect the request that triggered it.
  }
}

/**
 * Single entry point used by the API route. Returns the reason the request may
 * not use live AI, or null if it's clear to proceed.
 */
export async function checkLockdown(db) {
  if (isManuallyLockedDown()) return "lockdown";
  const breaker = await getBreakerState(db);
  return breaker.tripped ? "breaker" : null;
}
