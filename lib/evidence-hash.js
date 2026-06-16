import { createHash } from "node:crypto";

// Keys that change between otherwise-identical analyses (current RPC slot, prior
// verdicts that accumulate, ingestion/compute timestamps). Stripping them lets the
// hash represent the *meaningful* evidence so repeated calls for an unchanged scope
// collapse to one. Suffix patterns catch the common timestamp field conventions.
const VOLATILE_KEY = /^(rpcCluster|priorVerdicts|slot|ts)$/;
const VOLATILE_SUFFIX = /(Iso|_iso|At|_at)$/;

/**
 * Deterministically stringify a value: object keys sorted, volatile keys dropped.
 * @param {unknown} value
 * @returns {unknown}
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (VOLATILE_KEY.test(key) || VOLATILE_SUFFIX.test(key)) continue;
      out[key] = canonicalize(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Stable SHA-256 of the meaningful evidence. Two calls with the same on-chain
 * picture (ignoring RPC slot / timestamps) produce the same hash, so the
 * groq-brief route can skip a redundant model call and reuse the prior verdict.
 *
 * @param {unknown} data evidence payload sent to /api/groq-brief
 * @returns {string} hex digest
 */
export function stableEvidenceHash(data) {
  let json;
  try {
    json = JSON.stringify(canonicalize(data));
  } catch {
    json = String(data);
  }
  return createHash("sha256").update(json).digest("hex");
}
