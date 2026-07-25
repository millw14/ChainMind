/**
 * Pre-rendered money and count strings — the one piece of arithmetic the model
 * is never trusted with.
 *
 * Observed live: given marketCap 4160789.1145265275, llama-3.3 answered
 * "$4,160,789,114.53" — the true figure inflated a THOUSANDFOLD by absorbing the
 * fractional digits into the integer part. A wrong market cap stated confidently
 * is the worst class of bug this product can ship, so every path that hands a
 * raw float to the model hands it a finished string beside it to copy instead.
 *
 * WHY THIS IS ITS OWN FILE. displayNumber used to live in lib/market-evidence.js,
 * which imports lib/stock-tokens.js, which imports lib/ask-evidence.js. That is
 * already a cycle, and it only works because every reference across it sits
 * inside a function body rather than at module scope. Making lib/ask-evidence.js
 * import from lib/market-evidence.js would close a second loop through the same
 * three files for the sake of one pure function. This module imports NOTHING, so
 * both callers can take it directly and the cycle is not touched;
 * lib/market-evidence.js re-exports it for the callers and tests that already
 * import it from there.
 *
 * Server-side only, but it would be safe anywhere: no I/O, no state, no React.
 */

/**
 * A finite Number, or null. Blockscout sends numbers as strings, and sends ""
 * and "N/A" where it has no value — Number("") is 0, which is a fact nobody
 * measured, so the empty cases must land on null rather than on zero.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
export function finiteOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Render a figure the way the answer should quote it.
 *
 * `null` in, `null` out: a missing figure has no display string, and the prompt
 * tells the model that a null field means the indexer had none — never zero.
 *
 * @param {number|null} n
 * @param {"usd"|"count"} [kind]
 * @returns {string|null}
 */
export function displayNumber(n, kind = "usd") {
  if (n === null || !Number.isFinite(n)) return null;
  if (kind === "count") return Math.round(n).toLocaleString("en-US");
  const abs = Math.abs(n);
  const unit = abs >= 1e12 ? ["T", 1e12] : abs >= 1e9 ? ["B", 1e9] : abs >= 1e6 ? ["M", 1e6] : abs >= 1e3 ? ["K", 1e3] : null;
  if (unit) return `$${(n / unit[1]).toFixed(2)}${unit[0]}`;
  // Sub-$1000: two decimals reads as a price, which is what these are.
  return `$${n.toFixed(2)}`;
}
