// Canned results for zero-spend mode.
//
// The whole demo runs end-to-end against these without touching the Gemini API.
// Three things use them:
//   - DEMO_AI_ENABLED=false (the kill switch),
//   - any quota cap being hit (so the site degrades instead of erroring),
//   - local development, so you can build the UI without burning tokens.
//
// The classifier here is deliberately dumb keyword matching. It is NOT a
// fallback "AI" — it exists so the pipeline stays demonstrable at zero cost.

const SAMPLES = [
  {
    label: "New lead",
    from: "dana@brightlinecafe.com",
    fromName: "Dana Whitfield",
    subject: "Wholesale pricing for 200 units?",
    body: "Hi there,\n\nWe run three cafés in Portland and are looking to switch suppliers for our paper goods. Could you send wholesale pricing for around 200 units a month? We'd want to start in the next few weeks.\n\nThanks,\nDana Whitfield\nBrightline Cafe",
  },
  {
    label: "Support",
    from: "m.okafor@gmail.com",
    fromName: "Michael Okafor",
    subject: "Order HS-4471 arrived damaged",
    body: "Two of the four boxes in order HS-4471 were crushed on arrival and the contents are unusable. I need replacements before Friday — we have an event this weekend. Photos attached.\n\nMichael",
  },
  {
    label: "Billing",
    from: "accounts@northgate-retail.co",
    fromName: "Northgate Accounts",
    subject: "Duplicate charge on invoice INV-2213",
    body: "We appear to have been charged twice for invoice INV-2213 (once on the 3rd and again on the 5th). Please confirm and refund the duplicate. Our PO reference is NG-88120.",
  },
  {
    label: "Ambiguous (triggers human review)",
    from: "someone@example.org",
    fromName: "",
    subject: "question",
    body: "hi, is this still available? let me know",
  },
];

export function getSamples() {
  return SAMPLES;
}

/**
 * Keyword classifier used only in zero-spend mode.
 * Returns the same shape as classificationSchema so nothing downstream changes.
 */
export function fixtureClassification(email) {
  const text = `${email.subject} ${email.body}`.toLowerCase();
  const has = (...words) => words.some((w) => text.includes(w));

  let intent = "support";
  let confidence = 0.82;

  if (has("wholesale", "pricing", "quote", "interested in", "supplier")) {
    intent = "new_lead";
    confidence = 0.91;
  } else if (has("invoice", "charged", "refund", "billing", "payment", "duplicate charge")) {
    intent = "billing";
    confidence = 0.88;
  } else if (has("unsubscribe", "crypto", "seo services", "click here to claim")) {
    intent = "spam";
    confidence = 0.95;
  } else if (has("damaged", "broken", "not working", "return", "order ")) {
    intent = "support";
    confidence = 0.87;
  }

  // Short, vague messages are exactly what a confidence gate is for.
  if (email.body.trim().length < 60) confidence = 0.41;

  const urgency = has("urgent", "asap", "before friday", "immediately", "this weekend")
    ? "high"
    : "normal";
  const sentiment = has("damaged", "broken", "unacceptable", "twice", "unusable")
    ? "negative"
    : "neutral";

  const orderMatch = `${email.subject} ${email.body}`.match(/\b(?:HS|INV|PO|NG)-\d+\b/i);

  return {
    intent,
    urgency,
    sentiment,
    confidence,
    contact: {
      name: email.fromName || "",
      email: email.from,
      company: guessCompany(email.from),
    },
    orderRef: orderMatch ? orderMatch[0] : "",
    summary: `${email.subject} — from ${email.fromName || email.from}.`,
    suggestedOwner:
      intent === "new_lead" ? "Sales" : intent === "billing" ? "Finance" : "Support",
  };
}

export function fixtureDraft(email, classification) {
  // Mirror the live path exactly: spam and low-confidence emails never get a
  // draft, because a human is going to look at them first. Keeping the two
  // paths identical is what makes the canned mode an honest demo rather than
  // a different product wearing the same UI.
  if (classification.intent === "spam" || classification.confidence < 0.7) {
    return { subject: `Re: ${email.subject}`, body: "" };
  }

  const first = (classification.contact.name || "").split(" ")[0] || "there";

  const bodies = {
    new_lead: `Hi ${first},\n\nThanks for getting in touch about wholesale pricing — happy to help. I'm putting together a quote based on the volume you mentioned and will have it over to you within one business day.\n\nCould you confirm your delivery address and preferred start date so I can include accurate shipping?\n\nBest regards,\nHarbor Supply Co.`,
    support: `Hi ${first},\n\nI'm sorry about the trouble${classification.orderRef ? ` with ${classification.orderRef}` : ""} — that's not the standard we hold ourselves to. I've flagged this for immediate replacement and our team will confirm a dispatch date today.\n\nNo need to return the damaged items; we'll handle the write-off on our end.\n\nBest regards,\nHarbor Supply Co.`,
    billing: `Hi ${first},\n\nThanks for flagging this. I've passed${classification.orderRef ? ` ${classification.orderRef}` : " the invoice"} to our finance team to review the duplicate charge. If it's confirmed, the refund will be issued to the original payment method within 3–5 business days.\n\nI'll follow up as soon as I hear back.\n\nBest regards,\nHarbor Supply Co.`,
    spam: "",
  };

  return {
    subject: `Re: ${email.subject}`,
    body: bodies[classification.intent] ?? bodies.support,
  };
}

function guessCompany(address) {
  const domain = String(address).split("@")[1] ?? "";
  const free = ["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"];
  if (!domain || free.includes(domain.toLowerCase())) return "";
  return domain.split(".")[0].replace(/(^|[-_])(\w)/g, (_, s, c) => (s ? " " : "") + c.toUpperCase());
}
