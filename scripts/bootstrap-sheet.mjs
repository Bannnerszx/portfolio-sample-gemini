/**
 * Bootstrap the Google Sheet.
 *
 * Firestore creates a collection implicitly on first write, so the app never
 * has to provision anything. Google Sheets does not work that way: a tab with
 * no header row has no column names, and n8n's `appendOrUpdate` matches rows
 * *by column name*. Point it at a blank sheet and it fails.
 *
 * This script is the missing provisioning step. It is idempotent — safe to run
 * as many times as you like:
 *
 *   - tab missing            → creates it, writes the header row
 *   - tab exists, no header  → writes the header row
 *   - header wrong/reordered → reports the mismatch, changes nothing
 *   - header already correct → does nothing
 *
 * It never touches data rows. The worst it can do is add a tab.
 *
 * Usage:
 *   npm run setup:sheet          # apply
 *   npm run setup:sheet -- --dry # report only, write nothing
 */

import { google } from "googleapis";

// The schema contract. These names must match the `columns` mapping in
// n8n/workflow.json exactly — n8n matches on the header text, case-sensitively.
const TABS = {
  CRM: {
    matchKey: "email",
    headers: [
      "email",
      "name",
      "company",
      "stage",
      "lastSubject",
      "lastSummary",
      "owner",
      "updatedAt",
    ],
  },
  Tickets: {
    matchKey: "runId",
    headers: [
      "runId",
      "email",
      "orderRef",
      "subject",
      "priority",
      "sentiment",
      "owner",
      "updatedAt",
    ],
  },
};

const DRY_RUN = process.argv.includes("--dry");

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. Add it to .env.local — see docs/SPREADSHEET.md.`);
    process.exit(1);
  }
  return value;
}

// Private keys are stored with escaped newlines in env; restore them.
// Same handling as lib/firebaseAdmin.js.
function formatPrivateKey(key) {
  return key
    .trim()
    .replace(/^["']/g, "")
    .replace(/["']$/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "");
}

async function main() {
  const spreadsheetId = required("GSHEETS_SPREADSHEET_ID");
  const clientEmail = required("GSHEETS_CLIENT_EMAIL");
  const privateKey = formatPrivateKey(required("GSHEETS_PRIVATE_KEY"));

  const auth = new google.auth.GoogleAuth({
    credentials: { client_email: clientEmail, private_key: privateKey },
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  console.log(`Spreadsheet: ${spreadsheetId}`);
  if (DRY_RUN) console.log("DRY RUN — nothing will be written.\n");

  let meta;
  try {
    meta = await sheets.spreadsheets.get({ spreadsheetId });
  } catch (err) {
    const status = err?.status ?? err?.code;
    if (status === 403) {
      console.error(
        `\n403 Forbidden. The spreadsheet exists but this service account can't see it.\n` +
          `Share the sheet with ${clientEmail} as an Editor.`
      );
    } else if (status === 404) {
      console.error(
        `\n404 Not Found. Check GSHEETS_SPREADSHEET_ID — it's the long id in the URL:\n` +
          `https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`
      );
    } else {
      console.error("\nCould not read the spreadsheet:", err?.message ?? err);
    }
    process.exit(1);
  }

  console.log(`Title: ${meta.data.properties?.title}\n`);

  const existing = new Set(meta.data.sheets.map((s) => s.properties.title));
  let changed = 0;
  let problems = 0;

  for (const [tab, { headers, matchKey }] of Object.entries(TABS)) {
    // ---- 1. Create the tab if it doesn't exist --------------------------
    if (!existing.has(tab)) {
      if (DRY_RUN) {
        console.log(`[would create] tab "${tab}"`);
      } else {
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [{ addSheet: { properties: { title: tab } } }],
          },
        });
        console.log(`[created] tab "${tab}"`);
      }
      changed++;
    }

    // A tab we just created (or would create) has no header yet.
    const current = existing.has(tab)
      ? (
          await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `${tab}!1:1`,
          })
        ).data.values?.[0] ?? []
      : [];

    // ---- 2. Write the header if the row is empty ------------------------
    if (current.length === 0) {
      if (DRY_RUN) {
        console.log(`[would write header] ${tab}: ${headers.join(", ")}`);
      } else {
        await sheets.spreadsheets.values.update({
          spreadsheetId,
          range: `${tab}!A1`,
          valueInputOption: "RAW",
          requestBody: { values: [headers] },
        });
        // Freeze row 1 and bold it — cosmetic, but it makes the sheet usable
        // for the human who has to look at it.
        const sheetId = DRY_RUN
          ? null
          : (await sheets.spreadsheets.get({ spreadsheetId })).data.sheets.find(
              (s) => s.properties.title === tab
            )?.properties.sheetId;
        if (sheetId != null) {
          await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
              requests: [
                {
                  updateSheetProperties: {
                    properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
                    fields: "gridProperties.frozenRowCount",
                  },
                },
                {
                  repeatCell: {
                    range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                    cell: { userEnteredFormat: { textFormat: { bold: true } } },
                    fields: "userEnteredFormat.textFormat.bold",
                  },
                },
              ],
            },
          });
        }
        console.log(`[header written] ${tab}: ${headers.join(", ")}`);
      }
      changed++;
      continue;
    }

    // ---- 3. Verify an existing header ------------------------------------
    // Deliberately non-destructive. Renaming or reordering a column that
    // already has data under it would silently corrupt the sheet, so we
    // report and let a human decide.
    const missing = headers.filter((h) => !current.includes(h));
    const extra = current.filter((h) => h && !headers.includes(h));
    const orderOk = headers.every((h, i) => current[i] === h);

    if (missing.length === 0 && extra.length === 0 && orderOk) {
      console.log(`[ok] ${tab} — header matches (match key: ${matchKey})`);
    } else {
      problems++;
      console.log(`[MISMATCH] ${tab}`);
      console.log(`   expected: ${headers.join(", ")}`);
      console.log(`   found   : ${current.join(", ")}`);
      if (missing.length) console.log(`   missing : ${missing.join(", ")}`);
      if (extra.length) console.log(`   extra   : ${extra.join(", ")}`);
      if (!orderOk && !missing.length && !extra.length) {
        console.log("   order differs — n8n matches by name, so this is usually fine.");
      }
      console.log("   Not changed automatically — fix by hand to avoid corrupting data.");
    }

    // The match key must exist or appendOrUpdate cannot dedupe.
    if (!current.includes(matchKey) && !missing.includes(matchKey)) {
      console.log(`   ⚠ match key "${matchKey}" is absent — dedupe will not work.`);
    }
  }

  console.log();
  if (problems > 0) {
    console.log(`Finished with ${problems} mismatch(es) needing manual attention.`);
    process.exit(1);
  }
  console.log(
    changed === 0
      ? "Nothing to do — the sheet already matches the schema."
      : DRY_RUN
        ? `${changed} change(s) would be made. Re-run without --dry to apply.`
        : `${changed} change(s) applied. The sheet is ready.`
  );
}

main().catch((err) => {
  console.error("Bootstrap failed:", err?.message ?? err);
  process.exit(1);
});
