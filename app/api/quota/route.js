import { NextResponse } from "next/server";
import { getQuotaStatus, isAiEnabled, quotaMessage, withVisitorCookie } from "@/lib/quota";

// firebase-admin needs the Node.js runtime (not Edge).
export const runtime = "nodejs";
// Per-visitor state — must never be cached or statically prerendered.
export const dynamic = "force-dynamic";

/**
 * GET /api/quota
 * Read-only. Tells the UI how many live runs the visitor has left so the badge
 * and the form can say so *before* they type, rather than after.
 */
export async function GET(request) {
  const aiEnabled = isAiEnabled();

  // Kill switch off: no need to touch Firestore, nothing can be spent.
  if (!aiEnabled) {
    return withVisitorCookie(
      NextResponse.json({
        live: false,
        remaining: 0,
        limit: 0,
        reason: "disabled",
        message:
          "Live AI is switched off for this deployment — the demo runs on canned results at zero cost.",
      }),
      request
    );
  }

  const status = await getQuotaStatus(request);

  return withVisitorCookie(
    NextResponse.json({
      live: status.ok,
      owner: status.owner,
      remaining: status.owner ? null : status.remaining,
      limit: status.limit,
      reason: status.reason,
      message: status.ok ? null : quotaMessage(status.reason),
    }),
    request
  );
}
