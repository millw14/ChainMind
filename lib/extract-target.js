/**
 * Pull the first transaction hash (0x + 64 hex) or address (0x + 40 hex) out of
 * a free-text question.
 *
 * Lives here rather than inside the client component so node:test can cover the
 * matching without a JSX loader.
 */

// Both patterns demand a non-hex boundary on each side. Unanchored versions
// silently slice a valid-looking target out of a longer or malformed hex run —
// the user then gets a confident answer about a completely different account.
const TX_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{64})(?![0-9a-fA-F])/;
const ADDRESS_RE = /(?:^|[^0-9a-fA-F])(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/;

/**
 * @param {unknown} text
 * @returns {string|null} the target, transaction hash first when both appear
 */
export function extractTarget(text) {
  const s = typeof text === "string" ? text : "";
  const tx = s.match(TX_RE);
  if (tx) return tx[1];
  const addr = s.match(ADDRESS_RE);
  if (addr) return addr[1];
  return null;
}
