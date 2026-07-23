// Server-only Firebase Admin init. Reads service-account credentials from env
// (never a committed JSON file). Lazy singleton so it initialises once per runtime.
// Only import this from server code (route handlers) — never a client component.
import { getApps, initializeApp, cert, getApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;

const formatPrivateKey = (key) => {
  if (!key) return undefined;
  return key
    .trim()
    .replace(/^["']/g, "")   // Remove stray leading single/double quotes
    .replace(/["']$/g, "")   // Remove stray trailing single/double quotes
    .replace(/\\n/g, "\n")    // Convert escaped \n to real newlines
    .replace(/\r/g, "");     // Strip Windows carriage returns
};
// Private keys are stored with escaped newlines in env; restore them here.
const privateKey = formatPrivateKey(process.env.FIREBASE_ADMIN_PRIVATE_KEY);
export const isAdminConfigured = Boolean(projectId && clientEmail && privateKey);

/**
 * Returns a Firestore Admin instance, or null if credentials aren't configured.
 * Callers must handle the null case (so the app runs before Firebase is set up).
 */
export function getAdminDb() {

  if (!isAdminConfigured) return null;
  const app = getApps().length
    ? getApp()
    : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  return getFirestore(app);
}
