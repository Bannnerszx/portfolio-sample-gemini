// Idempotency.
//
// Mail systems and webhook senders retry. n8n retries. A user double-clicks
// Submit. Without a guard, the same email gets classified twice: two API
// charges, two CRM rows, and potentially two replies to the same customer.
//
// The fix is to derive the document ID from the message rather than letting
// Firestore generate one, and to create it with `create()` — which fails if
// the document already exists — instead of `set()`, which would overwrite.
// The uniqueness check and the write are then a single atomic operation.

import { createHash } from "node:crypto";

/** Stable document id for an email. Same message in → same id out. */
export function runIdFor(messageId) {
  return createHash("sha256").update(String(messageId)).digest("hex").slice(0, 24);
}

/**
 * Try to claim this message. Returns:
 *   { claimed: true }                     — first time; caller should process it
 *   { claimed: false, existing: {...} }   — already seen; caller returns the old run
 */
export async function claimRun(db, runId, seed) {
  try {
    await db.collection("runs").doc(runId).create(seed);
    return { claimed: true };
  } catch (err) {
    // ALREADY_EXISTS (code 6) is the expected, non-exceptional path here.
    if (err?.code === 6 || /already exists/i.test(err?.message ?? "")) {
      const snap = await db.collection("runs").doc(runId).get();
      return { claimed: false, existing: snap.exists ? { id: snap.id, ...snap.data() } : null };
    }
    throw err;
  }
}
