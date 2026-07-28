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
 * THREE kinds, because a price is not the same shape of number as a total.
 * Observed live: VLAD quoted as "price: $0.00, market cap: $0.00" when the
 * indexer held 0.00024243 and 247,349.11. Two decimals is right for a total and
 * catastrophic for a micro-cap price — most tokens anyone asks about trade below
 * a cent, so the one figure a trader came for was the one rounded to nothing.
 *
 * @param {number|null} n
 * @param {"usd"|"price"|"count"} [kind]
 * @returns {string|null}
 */
export function displayNumber(n, kind = "usd") {
  if (n === null || !Number.isFinite(n)) return null;
  if (kind === "count") return Math.round(n).toLocaleString("en-US");
  const abs = Math.abs(n);

  // A PRICE keeps its significant digits however small it gets: $0.00024243,
  // not $0.00 and not "<$0.01" — a trader compares those digits, so rounding
  // them away answers a different question than the one asked.
  if (kind === "price" && n !== 0 && abs < 1) {
    // Enough decimals to carry 4 significant digits past the leading zeros.
    const leadingZeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
    const decimals = Math.min(18, leadingZeros + 4);
    return `$${n.toFixed(decimals).replace(/0+$/, "").replace(/\.$/, "")}`;
  }

  const unit = abs >= 1e12 ? ["T", 1e12] : abs >= 1e9 ? ["B", 1e9] : abs >= 1e6 ? ["M", 1e6] : abs >= 1e3 ? ["K", 1e3] : null;
  if (unit) return `$${(n / unit[1]).toFixed(2)}${unit[0]}`;
  // A real but tiny TOTAL must not round to "$0.00", which reads as worthless
  // rather than small — the same mistake as treating unknown as zero, one
  // decimal further down. A true zero still prints $0.00, because that IS the
  // value.
  if (n !== 0 && abs < 0.01) return n > 0 ? "<$0.01" : ">-$0.01";
  return `$${n.toFixed(2)}`;
}
