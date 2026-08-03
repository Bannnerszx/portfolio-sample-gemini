// Egress proxy for the Generative Language API.
//
// Why this exists: the demo VM is in a country Google blocks for
// generativelanguage.googleapis.com. Every call failed with HTTP 400
// FAILED_PRECONDITION ("User location is not supported") before reaching the
// model, so the app fell back to fixtures on every run. Cloudflare's egress is
// in a supported region, so forwarding through a Worker clears the block.
//
// This is a dumb pass-through by design — it does not parse, log, or store
// request bodies, and it never holds the Gemini key. The app still sends its
// own key; the Worker only changes where the request leaves from.
//
// PROXY_TOKEN (a Worker secret) keeps this from being an open relay: without
// it, anyone who found the URL could route their own Gemini traffic through it
// and burn your Cloudflare quota.

const UPSTREAM = "generativelanguage.googleapis.com";

const proxy = {
  async fetch(request, env) {
    if (env.PROXY_TOKEN) {
      const presented = request.headers.get("x-proxy-token") ?? "";
      if (!timingSafeEqual(presented, env.PROXY_TOKEN)) {
        return new Response("Forbidden", { status: 403 });
      }
    }

    const url = new URL(request.url);
    url.protocol = "https:";
    url.hostname = UPSTREAM;
    url.port = "";

    // Strip our own auth header so it never reaches Google, and drop the
    // inbound Host so fetch sets it from the new hostname.
    const headers = new Headers(request.headers);
    headers.delete("x-proxy-token");
    headers.delete("host");

    const upstream = await fetch(
      new Request(url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: "follow",
      })
    );

    // Pass the response through untouched — the SDK needs the original status
    // and body to map errors to its own reason codes.
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  },
};

export default proxy;

/** Constant-time compare, so the token can't be recovered byte-by-byte. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
