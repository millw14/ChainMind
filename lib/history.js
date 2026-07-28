/**
 * A signed-in user's saved questions and answers.
 *
 * SCOPING IS THE KEY, NOT A CHECK. Every read, write and delete goes through
 * historyKey(), and the address it is given always comes from the signed session
 * cookie — never from a body, a query string or a header. Deleting one item
 * additionally matches an id INSIDE that key (see store.removeFromList), so an id
 * belonging to somebody else's history matches no row rather than being caught by
 * an ownership check that a later refactor could quietly drop. There is no code
 * path here that takes an address as user input.
 *
 * PRIVACY. This is user content tied to a wallet address, and an address is
 * personal data: it is a permanent, public, cross-site identifier for a person's
 * money. So the rules are narrow on purpose.
 *   - Only what the feature needs is kept: the question, the answer, the intent
 *     label and a timestamp. No IP, no user agent, no session id, no evidence
 *     blob.
 *   - The user can delete one entry or all of them, immediately, and delete means
 *     delete — there is no soft-delete flag anywhere in this file.
 *   - It ages out on its own (HISTORY_TTL_MS, default 90 days), because history
 *     nobody has looked at in three months is a liability rather than a feature.
 *   - Addresses are truncated in logs (lib/session.js shortAddress) and full
 *     answers are never logged at all.
 *
 * THE CAP IS A RING, NOT A REFUSAL. At HISTORY_MAX_ITEMS the oldest entry is
 * dropped so the newest can be kept — a save never fails because a user has asked
 * a lot of questions, and nobody is told their question was not saved when it was.
 * The trade is stated in the UI: "the last N are kept".
 */
import { randomBytes } from "node:crypto";

/** How many entries one address keeps. The store caps lists at 500 regardless. */
const DEFAULT_MAX_ITEMS = 50;

/** Hard ceiling from lib/store.js — asking for more than this silently gets this. */
const STORE_LIST_CEILING = 500;

/** Longest answer kept. Enough for any answer this app produces, bounded anyway. */
const DEFAULT_MAX_ANSWER_CHARS = 4_000;

/** Longest question kept. /api/ask already refuses anything over 500. */
const MAX_QUESTION_CHARS = 500;

/** How long an entry survives untouched. 0 disables ageing (cap only). */
const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Marker left where text was cut, so a truncated answer never reads as a complete one. */
const TRUNCATED = "\n\n… (truncated in saved history)";

/** Entries kept per address. */
export function historyMaxItems() {
  const n = Number(process.env.HISTORY_MAX_ITEMS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ITEMS;
  return Math.min(Math.floor(n), STORE_LIST_CEILING);
}

/** Longest saved answer, in characters. */
export function historyMaxAnswerChars() {
  const n = Number(process.env.HISTORY_MAX_ANSWER_CHARS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_ANSWER_CHARS;
}

/**
 * How long an entry lives.
 *
 * NOTE the adapters differ here and it is documented rather than papered over:
 * postgres expires each row on its own, while the memory adapter carries one
 * expiry for the whole list and refreshes it on every append. On memory that means
 * an inactive user's history disappears in one piece — acceptable, since a memory
 * store loses everything on restart anyway.
 */
export function historyTtlMs() {
  const n = Number(process.env.HISTORY_TTL_MS);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_TTL_MS;
  return n;
}

/** True when history is switched off entirely for this deploy. */
export function historyEnabled() {
  return String(process.env.HISTORY_ENABLED ?? "").trim().toLowerCase() !== "false";
}

/**
 * The one place a history key is built.
 *
 * Throws on anything that is not a canonical lowercase address, because every
 * caller passes a session address and a caller that does not is a bug worth
 * failing on rather than a key worth writing.
 *
 * @param {string} address
 * @returns {string}
 */
export function historyKey(address) {
  const addr = String(address ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error("History is only ever keyed by a session address.");
  }
  return `hist:${addr}`;
}

/** Short, unguessable, and unique enough for a 50-item list. */
function newId() {
  return randomBytes(9).toString("base64url");
}

/** Cut to `max`, marking the cut so nothing reads as complete when it is not. */
function clip(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - TRUNCATED.length)) + TRUNCATED;
}

/**
 * Save one question and its answer.
 *
 * Returns the stored entry rather than a boolean so a caller can echo the id back
 * to the client without a second read. A save with no answer is skipped: a turn
 * that failed is not history worth keeping, and it would only fill the ring.
 *
 * @param {{ store: object, address: string, question: string, answer: string,
 *           intent?: string|null, at?: number }} args
 * @returns {Promise<{ id: string, at: number, question: string, answer: string,
 *                     intent: string|null, cap: number }|null>}
 */
export async function saveHistoryEntry({
  store,
  address,
  question,
  answer,
  intent = null,
  at = Date.now(),
}) {
  if (!historyEnabled()) return null;
  const q = String(question ?? "").trim();
  const a = String(answer ?? "").trim();
  if (!q || !a) return null;

  const entry = {
    id: newId(),
    at,
    question: clip(q, MAX_QUESTION_CHARS),
    answer: clip(a, historyMaxAnswerChars()),
    intent: typeof intent === "string" && intent.trim() ? intent.trim().slice(0, 40) : null,
  };

  const ttlMs = historyTtlMs();
  await store.append(historyKey(address), entry, {
    max: historyMaxItems(),
    ...(ttlMs > 0 ? { ttlMs } : {}),
  });
  return { ...entry, cap: historyMaxItems() };
}

/**
 * This address's saved entries, newest first.
 *
 * @param {{ store: object, address: string, limit?: number }} args
 * @returns {Promise<Array<object>>}
 */
export async function listHistory({ store, address, limit = 0 }) {
  const cap = historyMaxItems();
  const n = Number(limit) > 0 ? Math.min(Math.floor(Number(limit)), cap) : cap;
  const rows = await store.list(historyKey(address), { limit: n });
  // Defensive: a row written by an older shape (or by hand) must not crash a
  // list render. Anything without an id cannot be deleted individually anyway.
  return rows
    .filter((row) => row && typeof row === "object" && typeof row.id === "string")
    .map((row) => ({
      id: row.id,
      at: Number(row.at) || 0,
      question: String(row.question ?? ""),
      answer: String(row.answer ?? ""),
      intent: typeof row.intent === "string" ? row.intent : null,
    }));
}

/**
 * Delete ONE entry belonging to this address.
 *
 * The id is the only thing here that comes from the client, and it can only ever
 * select within this address's own key. A well-formed id from someone else's
 * history deletes nothing and returns false — the same answer as an id that never
 * existed, so this is not an oracle for what another wallet has asked.
 *
 * @param {{ store: object, address: string, id: string }} args
 * @returns {Promise<boolean>} true when something was removed
 */
export async function deleteHistoryEntry({ store, address, id }) {
  const itemId = String(id ?? "").trim();
  // Bounded and character-restricted: an id is base64url from newId(), and
  // anything else is not worth putting into a query at all.
  if (!itemId || itemId.length > 64 || !/^[A-Za-z0-9_-]+$/.test(itemId)) return false;
  const removed = await store.removeFromList(historyKey(address), itemId);
  return Number(removed) > 0;
}

/**
 * Delete EVERYTHING this address has saved.
 *
 * @param {{ store: object, address: string }} args
 * @returns {Promise<boolean>}
 */
export async function clearHistory({ store, address }) {
  return Boolean(await store.delete(historyKey(address)));
}
