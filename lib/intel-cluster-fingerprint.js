import { createHash } from "node:crypto";

/**
 * Stable id for an exact wallet set (same set → same fingerprint).
 * @param {string[]} members
 */
export function clusterFingerprintFromMembers(members) {
  const s = [...new Set(members.map(String).filter(Boolean))].sort().join("|");
  return createHash("sha256").update(s).digest("hex").slice(0, 48);
}
